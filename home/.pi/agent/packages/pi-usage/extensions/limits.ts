import fs from "node:fs";
import path from "node:path";
import { getAgentDir, getDb } from "./db";
import { formatCurrency, formatTokens } from "./charts";

export type UsageLimit = {
  name?: string;
  provider: string;
  period?: "day" | "week" | "month" | "7d" | "30d";
  startDate?: string;
  tokens?: number;
  cost?: number;
  yellowAt?: number;
  redAt?: number;
  shouldAlwaysDisplay?: boolean;
};

type LimitsConfig = {
  limits?: UsageLimit[];
  yellowAt?: number;
  redAt?: number;
};

type LimitStatus = {
  label: string;
  used: number;
  limit: number;
  kind: "tokens" | "cost";
  percent: number;
  color: "none" | "yellow" | "red";
  shouldAlwaysDisplay: boolean;
};

const DEFAULT_FG = "\x1b[39m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";

export function renderLimitsReport(now = Date.now(), resetColor = DEFAULT_FG): string | undefined {
  const statuses = limitStatuses(now);
  if (statuses.length === 0) return undefined;

  return `Limits:\n${statuses.map((status) => formatLimitStatus(status, resetColor)).join(" | ")}`;
}

export function renderLimitsStatus(now = Date.now(), resetColor = DEFAULT_FG): string | undefined {
  const statuses = limitStatuses(now).filter((status) => status.color !== "none" || status.shouldAlwaysDisplay);
  if (statuses.length === 0) return undefined;

  return `limits: ${statuses.map((status) => formatLimitStatus(status, resetColor)).join(" | ")}`;
}

export function getLimitsPath(): string {
  return path.join(getAgentDir(), "usage", "limits.json");
}

function limitStatuses(now: number): LimitStatus[] {
  const config = readLimitsConfig();
  const limits = config?.limits?.filter(isValidLimit) ?? [];
  return limits.map((limit) => limitStatus(limit, config ?? {}, now));
}

function readLimitsConfig(): LimitsConfig | undefined {
  const limitsPath = getLimitsPath();
  if (!fs.existsSync(limitsPath)) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(limitsPath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isValidLimit(value: UsageLimit): boolean {
  return Boolean(
    value &&
      typeof value.provider === "string" &&
      value.provider.length > 0 &&
      ((typeof value.tokens === "number" && value.tokens > 0) || (typeof value.cost === "number" && value.cost > 0)),
  );
}

function limitStatus(limit: UsageLimit, config: LimitsConfig, now: number): LimitStatus {
  const range = periodRange(limit, now);
  const row = getDb().prepare(`
    SELECT SUM(total_tokens) AS total_tokens, SUM(total_cost) AS total_cost
    FROM usage_events
    WHERE timestamp_ms >= @startMs
      AND timestamp_ms < @endMs
      AND lower(provider) = lower(@provider)
  `).get({ startMs: range.startMs, endMs: range.endMs, provider: limit.provider }) as any;

  const kind = typeof limit.tokens === "number" && limit.tokens > 0 ? "tokens" : "cost";
  const used = kind === "tokens" ? Number(row?.total_tokens ?? 0) : Number(row?.total_cost ?? 0);
  const max = kind === "tokens" ? Number(limit.tokens) : Number(limit.cost);
  const percent = max > 0 ? used / max : 0;
  const yellowAt = numberOr(limit.yellowAt, numberOr(config.yellowAt, 0.5));
  const redAt = numberOr(limit.redAt, numberOr(config.redAt, 0.8));
  const color = percent >= redAt ? "red" : percent >= yellowAt ? "yellow" : "none";

  return {
    label: limit.name || limit.provider,
    used,
    limit: max,
    kind,
    percent,
    color,
    shouldAlwaysDisplay: limit.shouldAlwaysDisplay === true,
  };
}

function periodRange(limit: UsageLimit, now: number): { startMs: number; endMs: number } {
  const period = limit.period ?? "week";
  const periodMs = periodLengthMs(period, now);
  const endMs = now + 1;

  if (limit.startDate) {
    const anchor = parseLocalDate(limit.startDate);
    if (anchor !== undefined && anchor <= now) {
      const elapsedPeriods = Math.floor((now - anchor) / periodMs);
      return { startMs: anchor + elapsedPeriods * periodMs, endMs };
    }
  }

  if (period === "day") {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    return { startMs: start.getTime(), endMs };
  }

  if (period === "month") {
    const start = new Date(now);
    start.setDate(1);
    start.setHours(0, 0, 0, 0);
    return { startMs: start.getTime(), endMs };
  }

  return { startMs: now - periodMs + 1, endMs };
}

function periodLengthMs(period: UsageLimit["period"], now: number): number {
  if (period === "day") return 24 * 60 * 60 * 1000;
  if (period === "month" || period === "30d") return 30 * 24 * 60 * 60 * 1000;
  if (period === "week" || period === "7d" || !period) return 7 * 24 * 60 * 60 * 1000;
  return now * 0 + 7 * 24 * 60 * 60 * 1000;
}

function parseLocalDate(dateText: string): number | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateText)) return undefined;
  const value = new Date(`${dateText}T00:00:00`).getTime();
  return Number.isFinite(value) ? value : undefined;
}

function formatLimitStatus(status: LimitStatus, resetColor: string): string {
  const percent = `${Math.round(status.percent * 100)}%`;
  const used = status.kind === "tokens" ? formatTokens(status.used) : formatCurrency(status.used);
  const max = status.kind === "tokens" ? formatTokens(status.limit) : formatCurrency(status.limit);
  const text = `${status.label}: ${percent} (~${used}/${max})`;
  if (status.color === "red") return `${RED}${text}${resetColor}`;
  if (status.color === "yellow") return `${YELLOW}${text}${resetColor}`;
  return text;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
