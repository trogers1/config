import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

export type UsageSource = "live" | "import";

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
  inputCost: number;
  outputCost: number;
  cacheReadCost: number;
  cacheWriteCost: number;
  totalCost: number;
  cwd?: string | null;
  sessionFile?: string | null;
  sessionEntryId?: string | null;
};

export type InsertResult = "inserted" | "duplicate";

let db: any | undefined;

export function getAgentDir(): string {
  return path.join(process.env.HOME ?? process.cwd(), ".pi", "agent");
}

export function getDbPath(): string {
  return path.join(getAgentDir(), "usage", "usage.sqlite");
}

export function getDb(): any {
  if (db) return db;
  const dbPath = getDbPath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(schemaSql);
  return db;
}

export function closeDb(): void {
  if (!db) return;
  db.close();
  db = undefined;
}

export function recordUsage(event: UsageEvent): InsertResult {
  const database = getDb();
  const uniqueKey = uniqueKeyForEvent(event);
  const day = localDay(event.timestampMs);
  const result = insertStmt(database).run({
    unique_key: uniqueKey,
    source: event.source,
    timestamp_ms: event.timestampMs,
    day,
    provider: event.provider || "unknown",
    model: event.model || "unknown",
    api: event.api ?? null,
    input_tokens: finiteInt(event.inputTokens),
    output_tokens: finiteInt(event.outputTokens),
    cache_read_tokens: finiteInt(event.cacheReadTokens),
    cache_write_tokens: finiteInt(event.cacheWriteTokens),
    total_tokens: finiteInt(event.totalTokens),
    input_cost: finiteNumber(event.inputCost),
    output_cost: finiteNumber(event.outputCost),
    cache_read_cost: finiteNumber(event.cacheReadCost),
    cache_write_cost: finiteNumber(event.cacheWriteCost),
    total_cost: finiteNumber(event.totalCost),
    cwd: displayCwd(event.cwd),
    session_file: displaySessionFile(event.sessionFile),
    session_entry_id: event.sessionEntryId ?? null,
    created_at_ms: Date.now(),
  });
  return result.changes > 0 ? "inserted" : "duplicate";
}

function insertStmt(database: any): any {
  return database.prepare(`
    INSERT OR IGNORE INTO usage_events (
      unique_key, source, timestamp_ms, day, provider, model, api,
      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens,
      input_cost, output_cost, cache_read_cost, cache_write_cost, total_cost,
      cwd, session_file, session_entry_id, created_at_ms
    ) VALUES (
      @unique_key, @source, @timestamp_ms, @day, @provider, @model, @api,
      @input_tokens, @output_tokens, @cache_read_tokens, @cache_write_tokens, @total_tokens,
      @input_cost, @output_cost, @cache_read_cost, @cache_write_cost, @total_cost,
      @cwd, @session_file, @session_entry_id, @created_at_ms
    )
  `);
}

function uniqueKeyForEvent(event: UsageEvent): string {
  const sessionFile = event.sessionFile ?? "";
  const entryId = event.sessionEntryId ?? "";
  const sessionIdentity = sessionFile ? hash(sessionFile) : "no-session";
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
    event.totalCost,
  ].join(":");
}

export function localDay(timestampMs: number): string {
  const date = new Date(timestampMs);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function displayCwd(cwd: string | null | undefined): string | null {
  return cwd ? path.basename(cwd) : null;
}

function displaySessionFile(sessionFile: string | null | undefined): string | null {
  if (!sessionFile) return null;
  return path.join(path.basename(path.dirname(sessionFile)), path.basename(sessionFile));
}

function hash(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function finiteInt(value: unknown): number {
  return Math.max(0, Math.trunc(finiteNumber(value)));
}

function finiteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

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
  input_cost REAL NOT NULL DEFAULT 0,
  output_cost REAL NOT NULL DEFAULT 0,
  cache_read_cost REAL NOT NULL DEFAULT 0,
  cache_write_cost REAL NOT NULL DEFAULT 0,
  total_cost REAL NOT NULL DEFAULT 0,
  cwd TEXT,
  session_file TEXT,
  session_entry_id TEXT,
  created_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_events_timestamp ON usage_events(timestamp_ms);
CREATE INDEX IF NOT EXISTS idx_usage_events_day ON usage_events(day);
CREATE INDEX IF NOT EXISTS idx_usage_events_provider ON usage_events(provider);
CREATE INDEX IF NOT EXISTS idx_usage_events_model ON usage_events(model);
CREATE INDEX IF NOT EXISTS idx_usage_events_session_entry ON usage_events(session_file, session_entry_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_events_natural ON usage_events(
  session_file, timestamp_ms, provider, model,
  input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_cost
);
`;
