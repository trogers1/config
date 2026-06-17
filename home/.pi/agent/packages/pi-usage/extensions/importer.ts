import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { getAgentDir, recordUsage, type UsageEvent } from "./db";

export type ImportSummary = {
  filesScanned: number;
  eventsFound: number;
  inserted: number;
  alreadyPresent: number;
  errors: number;
};

export async function importSessions(sessionRoot = path.join(getAgentDir(), "sessions")): Promise<ImportSummary> {
  const summary: ImportSummary = {
    filesScanned: 0,
    eventsFound: 0,
    inserted: 0,
    alreadyPresent: 0,
    errors: 0,
  };

  if (!fs.existsSync(sessionRoot)) return summary;

  for (const file of walkJsonl(sessionRoot)) {
    summary.filesScanned++;
    await importFile(file, summary);
  }

  return summary;
}

async function importFile(file: string, summary: ImportSummary): Promise<void> {
  const stream = fs.createReadStream(file, { encoding: "utf8" });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let headerCwd: string | undefined;

  for await (const line of lines) {
    if (!line.trim()) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      summary.errors++;
      continue;
    }

    if (entry?.type === "session" && typeof entry.cwd === "string") {
      headerCwd = entry.cwd;
      continue;
    }

    const event = usageEventFromEntry(entry, file, headerCwd);
    if (!event) continue;
    summary.eventsFound++;
    try {
      const result = recordUsage(event);
      if (result === "inserted") summary.inserted++;
      else summary.alreadyPresent++;
    } catch {
      summary.errors++;
    }
  }
}

export function usageEventFromEntry(entry: any, sessionFile: string, cwd?: string): UsageEvent | undefined {
  if (entry?.type !== "message") return undefined;
  const message = entry.message;
  if (message?.role !== "assistant" || !message.usage) return undefined;
  return usageEventFromMessage(message, {
    source: "import",
    sessionFile,
    sessionEntryId: typeof entry.id === "string" ? entry.id : undefined,
    entryTimestamp: typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : undefined,
    cwd,
  });
}

export function usageEventFromMessage(
  message: any,
  options: {
    source: "live" | "import";
    sessionFile?: string;
    sessionEntryId?: string;
    entryTimestamp?: number;
    cwd?: string;
  },
): UsageEvent | undefined {
  const usage = message?.usage;
  if (!usage) return undefined;
  const cost = usage.cost ?? {};
  const input = number(usage.input);
  const output = number(usage.output);
  const cacheRead = number(usage.cacheRead);
  const cacheWrite = number(usage.cacheWrite);
  return {
    source: options.source,
    timestampMs: number(message.timestamp) || options.entryTimestamp || Date.now(),
    provider: string(message.provider) || "unknown",
    model: string(message.model) || "unknown",
    api: string(message.api) || null,
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    totalTokens: number(usage.totalTokens) || input + output + cacheRead + cacheWrite,
    inputCost: number(cost.input),
    outputCost: number(cost.output),
    cacheReadCost: number(cost.cacheRead),
    cacheWriteCost: number(cost.cacheWrite),
    totalCost: number(cost.total),
    cwd: options.cwd,
    sessionFile: options.sessionFile,
    sessionEntryId: options.sessionEntryId,
  };
}

function* walkJsonl(dir: string): Generator<string> {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walkJsonl(full);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) yield full;
  }
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
