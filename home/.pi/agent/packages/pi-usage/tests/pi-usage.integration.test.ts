import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	closeDb,
	getDb,
	getDbPath,
	insertEventSql,
	recordUsage,
	type UsageEventInsertParams,
} from '../extensions/db';
import piUsageExtension from '../extensions/pi-usage';
import { createPiUsageHarness } from './pi-usage.harness';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

let home: string;
let priorHome: string | undefined;
let priorStateHome: string | undefined;

beforeEach(() => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-usage-entry-test-'));
	priorHome = process.env.HOME;
	priorStateHome = process.env.XDG_STATE_HOME;
	process.env.HOME = home;
	process.env.XDG_STATE_HOME = path.join(home, 'state');
});

afterEach(() => {
	closeDb();
	if (priorHome === undefined) delete process.env.HOME;
	else process.env.HOME = priorHome;
	if (priorStateHome === undefined) delete process.env.XDG_STATE_HOME;
	else process.env.XDG_STATE_HOME = priorStateHome;
	fs.rmSync(home, { recursive: true, force: true });
});

describe('pi-usage extension', () => {
	it('records live registry and fallback costs, custom credits, and a report through Pi handlers', async () => {
		writeUsageConfig({
			rateCards: {
				credits: {
					unit: 'credits',
					provider: 'zai',
					models: {
						'glm-5.2': { input: 10, output: 20, cacheRead: 1, cacheWrite: 0 },
					},
				},
			},
			limits: [],
		});
		const timestamp = Date.now();
		const sessionFile = path.join(home, '.pi', 'agent', 'sessions', 'session.jsonl');
		const pricedMessage = {
			role: 'assistant',
			timestamp,
			provider: 'zai',
			model: 'glm-5.2',
			usage: {
				input: 50_000,
				output: 25_000,
				cacheRead: 1_000_000,
				cacheWrite: 0,
				totalTokens: 1_075_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
		const fallbackMessage = {
			role: 'assistant',
			timestamp: timestamp + 1,
			provider: 'unpriced',
			model: 'legacy',
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
			},
		};
		const harness = createPiUsageHarness({
			cwd: home,
			sessionFile,
			entries: [
				{ type: 'message', id: 'priced-entry', message: pricedMessage },
				{ type: 'message', id: 'fallback-entry', message: fallbackMessage },
			],
			model: {
				cost: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
			},
		});
		piUsageExtension(harness.api);

		await harness.emit('session_start', { reason: 'startup' });
		expect(harness.modelRegistry.refresh).toHaveBeenCalledOnce();
		await harness.emit('message_end', { message: pricedMessage });
		harness.modelRegistry.find.mockReturnValue(undefined);
		await harness.emit('message_end', { message: fallbackMessage });
		await harness.command('usage', 'today');
		const reportNotification = harness.notifications.at(-1);
		await harness.command('usage', 'export reports/usage.csv');
		await harness.emit('session_shutdown', { reason: 'quit' });

		const events = getDb()
			.prepare(
				'SELECT session_entry_id, provider, model, total_tokens FROM usage_events ORDER BY timestamp_ms'
			)
			.all() as Array<{
			session_entry_id: string;
			provider: string;
			model: string;
			total_tokens: number;
		}>;
		const charges = getDb()
			.prepare(
				`SELECT c.meter, c.rate_card, c.total_amount
				 FROM usage_charges c
				 JOIN usage_events e ON e.unique_key = c.event_key
				 ORDER BY e.timestamp_ms, c.meter`
			)
			.all() as Array<{ meter: string; rate_card: string; total_amount: number }>;
		expect(events).toEqual([
			{
				session_entry_id: 'priced-entry',
				provider: 'zai',
				model: 'glm-5.2',
				total_tokens: 1_075_000,
			},
			{
				session_entry_id: 'fallback-entry',
				provider: 'unpriced',
				model: 'legacy',
				total_tokens: 0,
			},
		]);
		expect(charges).toEqual([
			{ meter: 'cost', rate_card: 'model-registry', total_amount: expect.closeTo(0.44, 10) },
			{ meter: 'credits', rate_card: 'credits', total_amount: expect.closeTo(2, 10) },
			{ meter: 'cost', rate_card: 'session', total_amount: 10 },
		]);
		expect(reportNotification).toMatchObject({
			type: 'info',
			message: expect.stringContaining('Total: 1.1M tokens, $10.44'),
		});
		expect(fs.readFileSync(path.join(home, 'reports', 'usage.csv'), 'utf8')).toContain(
			'provider,model,api'
		);
		expect(harness.notifications.at(-1)).toEqual({
			type: 'info',
			message: `Usage CSV exported: ${path.join(home, 'reports', 'usage.csv')}`,
		});
		expect(harness.statuses.at(-1)).toEqual({ key: 'usage-limits', text: undefined });
	});

	it('ignores unrelated messages, surfaces malformed assistant usage, and deduplicates a matching entry', async () => {
		const timestamp = Date.now();
		const storedMessage = {
			role: 'assistant',
			timestamp,
			provider: 'zai',
			model: 'glm-5.2',
			usage: {
				input: 1000,
				output: 500,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 1500,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
		const harness = createPiUsageHarness({
			cwd: home,
			sessionFile: path.join(home, '.pi', 'agent', 'sessions', 'session.jsonl'),
			entries: [{ type: 'message', id: 'matching-entry', message: storedMessage }],
			model: { cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } },
		});
		piUsageExtension(harness.api);

		await harness.emit('message_end', { message: { role: 'user', content: 'ignore me' } });
		await harness.emit('message_end', {
			message: {
				role: 'assistant',
				timestamp,
				provider: 'zai',
				model: 'glm-5.2',
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			},
		});
		const deliveredMessage = structuredClone(storedMessage);
		await harness.emit('message_end', { message: deliveredMessage });
		await harness.emit('message_end', { message: deliveredMessage });
		await harness.command('usage', 'today');
		await harness.command('usage', 'nonsense');

		const event = getDb().prepare('SELECT session_entry_id, source FROM usage_events').get() as {
			session_entry_id: string;
			source: string;
		};
		expect(event).toEqual({ session_entry_id: 'matching-entry', source: 'live' });
		expect(harness.notifications).toContainEqual(
			expect.objectContaining({
				type: 'error',
				message: expect.stringContaining(
					'assistant message requires /usage must have required properties'
				),
			})
		);
		expect(harness.notifications).toContainEqual(
			expect.objectContaining({
				type: 'info',
				message: expect.stringContaining('Live events recorded this runtime: 1'),
			})
		);
		expect(harness.notifications.at(-1)).toEqual(
			expect.objectContaining({
				type: 'error',
				message: expect.stringContaining('Usage commands:'),
			})
		);
	});

	it('imports, reprices, and idempotently reconciles session history through /usage import', async () => {
		const sessionRoot = path.join(home, '.pi', 'agent', 'sessions');
		fs.mkdirSync(sessionRoot, { recursive: true });
		const sessionFile = path.join(sessionRoot, 'session.jsonl');
		fs.writeFileSync(
			sessionFile,
			[
				JSON.stringify({ type: 'session', cwd: home }),
				JSON.stringify({
					type: 'message',
					id: 'entry-1',
					timestamp: '2026-07-11T00:00:00.000Z',
					message: {
						role: 'assistant',
						timestamp: Date.parse('2026-07-11T00:00:00.000Z'),
						provider: 'zai',
						model: 'glm-5.2',
						api: 'openai-completions',
						usage: {
							input: 1000,
							output: 500,
							cacheRead: 2000,
							cacheWrite: 0,
							totalTokens: 3500,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
					},
				}),
			].join('\n') + '\n'
		);
		fs.mkdirSync(path.dirname(getDbPath()), { recursive: true });
		const incompatibleDb = new Database(getDbPath());
		incompatibleDb.exec('CREATE TABLE existing_usage (id INTEGER PRIMARY KEY)');
		incompatibleDb.close();

		const harness = createPiUsageHarness({
			cwd: home,
			model: { cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 } },
		});
		piUsageExtension(harness.api);

		await harness.command('usage', 'import');
		await harness.command('usage', 'import');
		harness.modelRegistry.find.mockReturnValue({
			cost: { input: 2, output: 4, cacheRead: 0.2, cacheWrite: 0 },
		});
		await harness.command('usage', 'import');

		const backups = fs
			.readdirSync(path.dirname(getDbPath()))
			.filter((name) => name.startsWith('usage.sqlite.backup-'));
		const event = getDb().prepare('SELECT COUNT(*) AS count FROM usage_events').get() as {
			count: number;
		};
		const charge = getDb()
			.prepare("SELECT total_amount FROM usage_charges WHERE meter = 'cost'")
			.get() as { total_amount: number };
		expect(harness.modelRegistry.refresh).toHaveBeenCalledTimes(3);
		expect(backups).toHaveLength(1);
		expect(event.count).toBe(1);
		expect(charge.total_amount).toBeCloseTo(0.0044);
		expect(
			harness.notifications.filter(({ message }) => message.includes('Usage import complete'))
		).toHaveLength(3);
	});

	it('reports import errors with the session file, line, and cause', async () => {
		const sessionRoot = path.join(home, '.pi', 'agent', 'sessions');
		fs.mkdirSync(sessionRoot, { recursive: true });
		fs.writeFileSync(
			path.join(sessionRoot, 'malformed.jsonl'),
			`${JSON.stringify({ type: 'session', cwd: home })}\nnot json\n`
		);
		const harness = createPiUsageHarness({ cwd: home });
		piUsageExtension(harness.api);

		await harness.command('usage', 'import');

		expect(harness.notifications.at(-1)).toEqual(
			expect.objectContaining({
				type: 'warning',
				message: expect.stringMatching(
					/Errors: 1\n\nImport errors:\n- malformed\.jsonl:2: Invalid JSON:/
				),
			})
		);
		const errorLogPath = harness.notifications.at(-1)?.message.match(/Error log: (.+)/)?.[1];
		expect(errorLogPath).toMatch(/import-errors-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.jsonl/);
		expect(fs.readFileSync(errorLogPath!, 'utf8')).toContain(
			'"file":"' + path.join(sessionRoot, 'malformed.jsonl') + '"'
		);
	});

	it('imports and captures live compaction and branch-summary model usage once', async () => {
		const sessionRoot = path.join(home, '.pi', 'agent', 'sessions');
		fs.mkdirSync(sessionRoot, { recursive: true });
		const sessionFile = path.join(sessionRoot, 'session.jsonl');
		const summaryUsage = {
			input: 1000,
			output: 500,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 1500,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		fs.writeFileSync(
			sessionFile,
			[
				JSON.stringify({ type: 'session', cwd: home }),
				JSON.stringify({ type: 'model_change', provider: 'zai', modelId: 'glm-5.2' }),
				JSON.stringify({
					type: 'compaction',
					id: 'imported-compaction',
					timestamp: '2026-07-21T00:00:00.000Z',
					usage: summaryUsage,
				}),
				JSON.stringify({
					type: 'branch_summary',
					id: 'imported-branch-summary',
					timestamp: '2026-07-21T00:01:00.000Z',
					usage: summaryUsage,
				}),
			].join('\n') + '\n'
		);
		const harness = createPiUsageHarness({
			cwd: home,
			sessionFile,
			model: { cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } },
			selectedModel: { provider: 'zai', id: 'glm-5.2' },
		});
		piUsageExtension(harness.api);

		await harness.command('usage', 'import');
		await harness.emit('session_compact', {
			compactionEntry: {
				type: 'compaction',
				id: 'live-compaction',
				timestamp: '2026-07-21T00:02:00.000Z',
				usage: summaryUsage,
			},
		});
		await harness.emit('session_tree', {
			summaryEntry: {
				type: 'branch_summary',
				id: 'live-branch-summary',
				timestamp: '2026-07-21T00:03:00.000Z',
				usage: summaryUsage,
			},
		});
		await harness.emit('session_compact', {
			compactionEntry: {
				type: 'compaction',
				id: 'live-compaction',
				timestamp: '2026-07-21T00:02:00.000Z',
				usage: summaryUsage,
			},
		});

		const events = getDb()
			.prepare(
				'SELECT session_entry_id, provider, model, total_tokens FROM usage_events ORDER BY timestamp_ms'
			)
			.all();
		expect(events).toEqual([
			{
				session_entry_id: 'imported-compaction',
				provider: 'zai',
				model: 'glm-5.2',
				total_tokens: 1500,
			},
			{
				session_entry_id: 'imported-branch-summary',
				provider: 'zai',
				model: 'glm-5.2',
				total_tokens: 1500,
			},
			{
				session_entry_id: 'live-compaction',
				provider: 'zai',
				model: 'glm-5.2',
				total_tokens: 1500,
			},
			{
				session_entry_id: 'live-branch-summary',
				provider: 'zai',
				model: 'glm-5.2',
				total_tokens: 1500,
			},
		]);
		const total = getDb()
			.prepare("SELECT SUM(total_amount) AS total FROM usage_charges WHERE meter = 'cost'")
			.get() as { total: number };
		expect(total.total).toBeCloseTo(0.008);
	});

	it('reports an actionable error when Pi no longer supplies a required capability', async () => {
		const harness = createPiUsageHarness({ cwd: home });
		Reflect.deleteProperty(harness.context.modelRegistry, 'refresh');
		piUsageExtension(harness.api);

		await expect(harness.emit('session_start', { reason: 'startup' })).rejects.toThrow(
			/session_start context requires \/modelRegistry must have required properties refresh/
		);
		expect(harness.notifications).toEqual([
			expect.objectContaining({
				type: 'error',
				message: expect.stringContaining('pi-usage is incompatible with this Pi runtime'),
			}),
		]);
	});

	it('handles concurrent writers without errors or lost records', async () => {
		const workerCount = 4;
		const recordsPerWorker = 50;
		const workerPath = new URL('./concurrent-writer.worker.mjs', import.meta.url);
		const day = new Date().toISOString().slice(0, 10);

		getDb();

		const workers: Worker[] = [];
		const results: Promise<number>[] = [];
		for (let i = 0; i < workerCount; i++) {
			const records: UsageEventInsertParams[] = [];
			for (let j = 0; j < recordsPerWorker; j++) {
				records.push({
					unique_key: `worker-${i}:entry-${j}`,
					source: 'live',
					timestamp_ms: Date.now(),
					day,
					provider: 'concurrent-test',
					model: `worker-${i}`,
					api: null,
					input_tokens: j,
					output_tokens: 0,
					cache_read_tokens: 0,
					cache_write_tokens: 0,
					total_tokens: j,
					cwd: null,
					project_id: 'NON-GIT PROJECT',
					session_file: null,
					session_entry_id: `entry-${j}`,
					created_at_ms: Date.now(),
				});
			}
			const worker = new Worker(workerPath, {
				workerData: { sql: insertEventSql, records, dbPath: getDbPath() },
			});
			workers.push(worker);
			results.push(
				new Promise((resolve, reject) => {
					worker.on('message', resolve);
					worker.on('error', reject);
					worker.on('exit', (code) => {
						if (code !== 0) reject(new Error(`Worker exited with code ${code}`));
					});
				})
			);
		}

		const workerResults = await Promise.all(results);
		for (const worker of workers) await worker.terminate();

		const totalInserted = workerResults.reduce((sum, value) => sum + value, 0);
		const count = getDb().prepare('SELECT COUNT(*) AS count FROM usage_events').get() as {
			count: number;
		};
		expect(totalInserted).toBe(workerCount * recordsPerWorker);
		expect(count.count).toBe(totalInserted);
	});

	it('retries on transient database lock errors before giving up', () => {
		const database = getDb();
		let failures = 0;
		const originalPrepare = database.prepare.bind(database);
		database.prepare = function (sql: string) {
			const statement = originalPrepare(sql);
			if (!sql.includes('SELECT unique_key')) return statement;
			return {
				get: (...args: unknown[]) => {
					failures++;
					if (failures <= 2) throw new Error('database is locked (SQLITE_BUSY)');
					return statement.get(...args);
				},
			};
		};

		const result = recordUsage({
			record: {
				event: {
					source: 'live',
					timestampMs: 1234567890123,
					provider: 'retry',
					model: 'test',
					inputTokens: 10,
					outputTokens: 5,
					cacheReadTokens: 0,
					cacheWriteTokens: 0,
					totalTokens: 15,
				},
				charges: [],
			},
		});
		expect(result).toBe('inserted');
		expect(failures).toBe(3);
	});

	it('keeps ephemeral keys unique across parallel workers with identical token signatures', () => {
		const base = {
			source: 'live' as const,
			timestampMs: 1234567890123,
			provider: 'parallel',
			model: 'same-model',
			inputTokens: 100,
			outputTokens: 50,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			totalTokens: 150,
		};
		expect(
			recordUsage({
				record: {
					event: { ...base, sessionId: 'worker-a', sessionEntryId: 'entry-1' },
					charges: [],
				},
			})
		).toBe('inserted');
		expect(
			recordUsage({
				record: {
					event: { ...base, sessionId: 'worker-b', sessionEntryId: 'entry-1' },
					charges: [],
				},
			})
		).toBe('inserted');
		const count = getDb().prepare('SELECT COUNT(*) AS count FROM usage_events').get() as {
			count: number;
		};
		expect(count.count).toBe(2);
	});

	it('keeps the legacy fallback key shape when no identity fields are provided', () => {
		const event = {
			source: 'live' as const,
			timestampMs: 1234567890123,
			provider: 'legacy',
			model: 'fallback',
			inputTokens: 100,
			outputTokens: 50,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			totalTokens: 150,
		};
		recordUsage({ record: { event, charges: [] } });
		const row = getDb().prepare('SELECT unique_key FROM usage_events').get() as {
			unique_key: string;
		};
		expect(row.unique_key).toBe('live:no-session:1234567890123:legacy:fallback:100:50:0:0');
	});

	it('deduplicates a live record against a later import of the same session entry', async () => {
		const sessionRoot = path.join(home, '.pi', 'agent', 'sessions');
		fs.mkdirSync(sessionRoot, { recursive: true });
		const sessionFile = path.join(sessionRoot, 'session.jsonl');
		const entryId = 'live-import-entry';
		const timestamp = Date.parse('2026-07-11T00:00:00.000Z');
		const message = {
			role: 'assistant',
			timestamp,
			provider: 'zai',
			model: 'glm-5.2',
			usage: {
				input: 1000,
				output: 500,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 1500,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
		fs.writeFileSync(
			sessionFile,
			[
				JSON.stringify({ type: 'session', cwd: home }),
				JSON.stringify({
					type: 'message',
					id: entryId,
					timestamp: '2026-07-11T00:00:00.000Z',
					message,
				}),
			].join('\n') + '\n'
		);

		const liveHarness = createPiUsageHarness({
			cwd: home,
			sessionFile,
			entries: [{ type: 'message', id: entryId, message }],
			model: { cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } },
		});
		piUsageExtension(liveHarness.api);
		await liveHarness.emit('message_end', { message });

		const importHarness = createPiUsageHarness({
			cwd: home,
			model: { cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } },
		});
		piUsageExtension(importHarness.api);
		await importHarness.command('usage', 'import');

		const count = getDb().prepare('SELECT COUNT(*) AS count FROM usage_events').get() as {
			count: number;
		};
		expect(count.count).toBe(1);
	});
});

function writeUsageConfig(value: unknown): void {
	const configPath = path.join(home, '.pi', 'agent', 'usage', 'usage.json');
	fs.mkdirSync(path.dirname(configPath), { recursive: true });
	fs.writeFileSync(configPath, JSON.stringify(value), 'utf8');
}
