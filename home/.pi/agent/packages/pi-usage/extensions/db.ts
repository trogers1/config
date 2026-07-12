import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { TieredTokenRates } from './metering';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const SCHEMA_VERSION = 2;

export type UsageSource = 'live' | 'import';

export type UsageEvent = {
	source: UsageSource;
	timestampMs: number;
	provider: string;
	model: string;
	api?: string | null;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	totalTokens: number;
	cwd?: string | null;
	projectId?: string | null;
	sessionFile?: string | null;
	sessionEntryId?: string | null;
};

export type UsageCharge = {
	meter: string;
	unit: string;
	rateCard: string;
	rates?: TieredTokenRates;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
};

export type UsageRecord = { event: UsageEvent; charges: UsageCharge[] };
export type RecordResult = 'inserted' | 'updated' | 'unchanged';

let db: any | undefined;

export function getAgentDir(): string {
	return path.join(process.env.HOME ?? process.cwd(), '.pi', 'agent');
}

export function getDbPath(): string {
	return path.join(getStateHome(), 'pi', 'agent', 'pi-usage', 'usage.sqlite');
}

function getStateHome(): string {
	return (
		process.env.XDG_STATE_HOME || path.join(process.env.HOME ?? process.cwd(), '.local', 'state')
	);
}

export function getDb(): any {
	if (db) return db;
	const dbPath = getDbPath();
	fs.mkdirSync(path.dirname(dbPath), { recursive: true });
	backupIncompatibleDb({ dbPath });
	db = new Database(dbPath);
	db.pragma('journal_mode = WAL');
	db.pragma('foreign_keys = ON');
	db.exec(schemaSql);
	return db;
}

export function closeDb(): void {
	if (!db) return;
	db.close();
	db = undefined;
}

export function recordUsage({ record }: { record: UsageRecord }): RecordResult {
	const database = getDb();
	const stored = storedRecord({ record });
	const existing = readStoredRecord({
		database,
		uniqueKey: stored.event.unique_key,
	});
	if (existing && canonical({ record: existing }) === canonical({ record: stored }))
		return 'unchanged';

	if (!existing) {
		insertRecord({ database, record: stored });
		return 'inserted';
	}
	updateRecord({ database, record: stored });
	return 'updated';
}

function storedRecord({ record }: { record: UsageRecord }): StoredRecord {
	const event = record.event;
	return {
		event: {
			unique_key: uniqueKeyForEvent({ event }),
			source: event.source,
			timestamp_ms: finiteInt({ value: event.timestampMs }),
			day: localDay({ timestampMs: event.timestampMs }),
			provider: event.provider || 'unknown',
			model: event.model || 'unknown',
			api: event.api ?? null,
			input_tokens: finiteInt({ value: event.inputTokens }),
			output_tokens: finiteInt({ value: event.outputTokens }),
			cache_read_tokens: finiteInt({ value: event.cacheReadTokens }),
			cache_write_tokens: finiteInt({ value: event.cacheWriteTokens }),
			total_tokens: finiteInt({ value: event.totalTokens }),
			cwd: displayCwd({ cwd: event.cwd }),
			project_id: displayProjectId({
				projectId: event.projectId,
				cwd: event.cwd,
			}),
			session_file: displaySessionFile({ sessionFile: event.sessionFile }),
			session_entry_id: event.sessionEntryId ?? null,
		},
		charges: record.charges
			.map((item) => ({
				meter: item.meter,
				unit: item.unit,
				rate_card: item.rateCard,
				rates_json: item.rates ? stableJson({ value: item.rates }) : null,
				input_amount: finiteNumber({ value: item.input }),
				output_amount: finiteNumber({ value: item.output }),
				cache_read_amount: finiteNumber({ value: item.cacheRead }),
				cache_write_amount: finiteNumber({ value: item.cacheWrite }),
				total_amount: finiteNumber({ value: item.total }),
			}))
			.sort((a, b) => a.meter.localeCompare(b.meter)),
	};
}

function readStoredRecord({
	database,
	uniqueKey,
}: {
	database: any;
	uniqueKey: string;
}): StoredRecord | undefined {
	const event = database
		.prepare(
			`SELECT unique_key, source, timestamp_ms, day, provider, model, api,
    input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens,
    cwd, project_id, session_file, session_entry_id
    FROM usage_events WHERE unique_key = ?`
		)
		.get(uniqueKey) as StoredEvent | undefined;
	if (!event) return undefined;
	const charges = database
		.prepare(
			`SELECT meter, unit, rate_card, rates_json,
    input_amount, output_amount, cache_read_amount, cache_write_amount, total_amount
    FROM usage_charges WHERE event_key = ? ORDER BY meter`
		)
		.all(uniqueKey) as StoredCharge[];
	return { event, charges };
}

function insertRecord({ database, record }: { database: any; record: StoredRecord }): void {
	database.transaction(() => {
		database
			.prepare(
				`INSERT INTO usage_events (
      unique_key, source, timestamp_ms, day, provider, model, api,
      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens,
      cwd, project_id, session_file, session_entry_id, created_at_ms
    ) VALUES (
      @unique_key, @source, @timestamp_ms, @day, @provider, @model, @api,
      @input_tokens, @output_tokens, @cache_read_tokens, @cache_write_tokens, @total_tokens,
      @cwd, @project_id, @session_file, @session_entry_id, @created_at_ms
    )`
			)
			.run({ ...record.event, created_at_ms: Date.now() });
		insertCharges({
			database,
			eventKey: record.event.unique_key,
			charges: record.charges,
		});
	})();
}

function updateRecord({ database, record }: { database: any; record: StoredRecord }): void {
	database.transaction(() => {
		database
			.prepare(
				`UPDATE usage_events SET
      timestamp_ms=@timestamp_ms, day=@day, provider=@provider, model=@model, api=@api,
      input_tokens=@input_tokens, output_tokens=@output_tokens,
      cache_read_tokens=@cache_read_tokens, cache_write_tokens=@cache_write_tokens,
      total_tokens=@total_tokens, cwd=@cwd, project_id=@project_id,
      session_file=@session_file, session_entry_id=@session_entry_id
      WHERE unique_key=@unique_key`
			)
			.run(record.event);
		database.prepare('DELETE FROM usage_charges WHERE event_key = ?').run(record.event.unique_key);
		insertCharges({
			database,
			eventKey: record.event.unique_key,
			charges: record.charges,
		});
	})();
}

function insertCharges({
	database,
	eventKey,
	charges,
}: {
	database: any;
	eventKey: string;
	charges: StoredCharge[];
}): void {
	const statement = database.prepare(`INSERT INTO usage_charges (
    event_key, meter, unit, rate_card, rates_json,
    input_amount, output_amount, cache_read_amount, cache_write_amount, total_amount
  ) VALUES (
    @event_key, @meter, @unit, @rate_card, @rates_json,
    @input_amount, @output_amount, @cache_read_amount, @cache_write_amount, @total_amount
  )`);
	for (const item of charges) statement.run({ event_key: eventKey, ...item });
}

function canonical({ record }: { record: StoredRecord }): string {
	const { source: _source, ...event } = record.event;
	return stableJson({ value: { event, charges: record.charges } });
}

function backupIncompatibleDb({ dbPath }: { dbPath: string }): void {
	if (!fs.existsSync(dbPath)) return;
	const probe = new Database(dbPath);
	const version = Number(probe.pragma('user_version', { simple: true }) ?? 0);
	if (version === SCHEMA_VERSION) {
		probe.close();
		return;
	}
	probe.pragma('wal_checkpoint(TRUNCATE)');
	probe.close();
	const suffix = new Date().toISOString().replace(/[:.]/g, '-');
	fs.renameSync(dbPath, `${dbPath}.backup-${suffix}`);
	removeIfPresent({ file: `${dbPath}-wal` });
	removeIfPresent({ file: `${dbPath}-shm` });
}

function removeIfPresent({ file }: { file: string }): void {
	try {
		fs.unlinkSync(file);
	} catch (error: any) {
		if (error?.code !== 'ENOENT') throw error;
	}
}

function uniqueKeyForEvent({ event }: { event: UsageEvent }): string {
	const sessionFile = event.sessionFile ?? '';
	const entryId = event.sessionEntryId ?? '';
	const sessionIdentity = sessionFile ? hash({ value: sessionFile }) : 'no-session';
	if (sessionFile && entryId) return `session:${sessionIdentity}:${entryId}`;
	return [
		event.source,
		sessionIdentity,
		event.timestampMs,
		event.provider,
		event.model,
		event.inputTokens,
		event.outputTokens,
		event.cacheReadTokens,
		event.cacheWriteTokens,
	].join(':');
}

export function localDay({ timestampMs }: { timestampMs: number }): string {
	const date = new Date(timestampMs);
	const y = date.getFullYear();
	const m = String(date.getMonth() + 1).padStart(2, '0');
	const d = String(date.getDate()).padStart(2, '0');
	return `${y}-${m}-${d}`;
}

function displayCwd({ cwd }: { cwd: string | null | undefined }): string | null {
	return cwd ? path.basename(cwd) : null;
}

function displayProjectId({
	projectId,
	cwd,
}: {
	projectId: string | null | undefined;
	cwd: string | null | undefined;
}): string {
	if (projectId && projectId.trim().length > 0) return projectId.trim();
	return projectIdentifier({ cwd });
}

function projectIdentifier({ cwd }: { cwd: string | null | undefined }): string {
	if (!cwd) return 'NON-GIT PROJECT';
	try {
		const commonGitDir = execFileSync(
			'git',
			['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
			{
				encoding: 'utf8',
				stdio: ['ignore', 'pipe', 'ignore'],
				timeout: 1000,
			}
		).trim();
		if (!commonGitDir) return 'NON-GIT PROJECT';
		return (
			path.basename(commonGitDir.endsWith('/.git') ? path.dirname(commonGitDir) : commonGitDir) ||
			'NON-GIT PROJECT'
		);
	} catch {
		return 'NON-GIT PROJECT';
	}
}

function displaySessionFile({
	sessionFile,
}: {
	sessionFile: string | null | undefined;
}): string | null {
	if (!sessionFile) return null;
	return path.join(path.basename(path.dirname(sessionFile)), path.basename(sessionFile));
}

function hash({ value }: { value: string }): string {
	return crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function finiteInt({ value }: { value: unknown }): number {
	return Math.max(0, Math.trunc(finiteNumber({ value })));
}

function finiteNumber({ value }: { value: unknown }): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function stableJson({ value }: { value: unknown }): string {
	if (Array.isArray(value))
		return `[${value.map((item) => stableJson({ value: item })).join(',')}]`;
	if (value && typeof value === 'object') {
		const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
			a.localeCompare(b)
		);
		return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson({ value: item })}`).join(',')}}`;
	}
	return JSON.stringify(value);
}

type StoredEvent = {
	unique_key: string;
	source: UsageSource;
	timestamp_ms: number;
	day: string;
	provider: string;
	model: string;
	api: string | null;
	input_tokens: number;
	output_tokens: number;
	cache_read_tokens: number;
	cache_write_tokens: number;
	total_tokens: number;
	cwd: string | null;
	project_id: string;
	session_file: string | null;
	session_entry_id: string | null;
};

type StoredCharge = {
	meter: string;
	unit: string;
	rate_card: string;
	rates_json: string | null;
	input_amount: number;
	output_amount: number;
	cache_read_amount: number;
	cache_write_amount: number;
	total_amount: number;
};

type StoredRecord = { event: StoredEvent; charges: StoredCharge[] };

const schemaSql = `
CREATE TABLE IF NOT EXISTS usage_events (
  unique_key TEXT PRIMARY KEY NOT NULL,
  source TEXT NOT NULL,
  timestamp_ms INTEGER NOT NULL,
  day TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  api TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  cwd TEXT,
  project_id TEXT,
  session_file TEXT,
  session_entry_id TEXT,
  created_at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS usage_charges (
  event_key TEXT NOT NULL REFERENCES usage_events(unique_key) ON DELETE CASCADE,
  meter TEXT NOT NULL,
  unit TEXT NOT NULL,
  rate_card TEXT NOT NULL,
  rates_json TEXT,
  input_amount REAL NOT NULL DEFAULT 0,
  output_amount REAL NOT NULL DEFAULT 0,
  cache_read_amount REAL NOT NULL DEFAULT 0,
  cache_write_amount REAL NOT NULL DEFAULT 0,
  total_amount REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (event_key, meter)
);
CREATE INDEX IF NOT EXISTS idx_usage_events_timestamp ON usage_events(timestamp_ms);
CREATE INDEX IF NOT EXISTS idx_usage_events_day ON usage_events(day);
CREATE INDEX IF NOT EXISTS idx_usage_events_provider ON usage_events(provider);
CREATE INDEX IF NOT EXISTS idx_usage_events_model ON usage_events(model);
CREATE INDEX IF NOT EXISTS idx_usage_events_session_entry ON usage_events(session_file, session_entry_id);
CREATE INDEX IF NOT EXISTS idx_usage_charges_meter ON usage_charges(meter);
PRAGMA user_version = ${SCHEMA_VERSION};
`;
