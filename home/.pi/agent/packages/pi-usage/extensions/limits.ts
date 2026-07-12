import { readUsageConfig, type UsageConfig, type UsageLimit } from './config';
import { getDb } from './db';
import { formatCurrency, formatTokens } from './charts';

export type LimitStatus = {
	label: string;
	used: number;
	limit: number;
	meter: string;
	unit: string;
	percent: number;
	color: 'none' | 'yellow' | 'red';
	shouldAlwaysDisplay: boolean;
};

const DEFAULT_FG = '\x1b[39m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';

export function renderLimitsReport(now = Date.now(), resetColor = DEFAULT_FG): string | undefined {
	try {
		const statuses = limitStatuses(now);
		if (statuses.length === 0) return undefined;
		return `Limits:\n${statuses.map((status) => formatLimitStatus(status, resetColor)).join(' | ')}`;
	} catch (error) {
		return formatLimitsError(error, resetColor);
	}
}

export function renderLimitsStatus(now = Date.now(), resetColor = DEFAULT_FG): string | undefined {
	try {
		const visible = limitStatuses(now).filter(
			(status) => status.color !== 'none' || status.shouldAlwaysDisplay
		);
		if (visible.length === 0) return undefined;
		return `limits: ${visible.map((status) => formatLimitStatus(status, resetColor)).join(' | ')}`;
	} catch (error) {
		return formatLimitsError(error, resetColor);
	}
}

export function limitStatuses(now: number): LimitStatus[] {
	const config = readUsageConfig();
	return config.limits.map((limit) => limitStatus(limit, config, now));
}

function limitStatus(limit: UsageLimit, config: UsageConfig, now: number): LimitStatus {
	const range = periodRange(limit, now);
	const filters = ['e.timestamp_ms >= @startMs', 'e.timestamp_ms < @endMs'];
	if (limit.provider) filters.push('lower(e.provider) = lower(@provider)');
	if (limit.model) filters.push('lower(e.model) = lower(@model)');

	let used: number;
	let unit: string;
	if (limit.meter === 'tokens') {
		const row = getDb()
			.prepare(
				`SELECT SUM(e.total_tokens) AS used FROM usage_events e WHERE ${filters.join(' AND ')}`
			)
			.get(params(limit, range)) as any;
		used = Number(row?.used ?? 0);
		unit = 'tokens';
	} else {
		filters.push('c.meter = @meter');
		const row = getDb()
			.prepare(
				`SELECT SUM(c.total_amount) AS used, MAX(c.unit) AS unit
      FROM usage_events e
      JOIN usage_charges c ON c.event_key = e.unique_key
      WHERE ${filters.join(' AND ')}`
			)
			.get(params(limit, range)) as any;
		used = Number(row?.used ?? 0);
		unit = String(row?.unit ?? configuredUnit(limit, config));
	}

	const percent = limit.maximum > 0 ? used / limit.maximum : 0;
	const yellowAt = numberOr(limit.yellowAt, numberOr(config.yellowAt, 0.5));
	const redAt = numberOr(limit.redAt, numberOr(config.redAt, 0.8));
	return {
		label: limit.name || limit.provider || limit.meter,
		used,
		limit: limit.maximum,
		meter: limit.meter,
		unit,
		percent,
		color: percent >= redAt ? 'red' : percent >= yellowAt ? 'yellow' : 'none',
		shouldAlwaysDisplay: limit.shouldAlwaysDisplay === true,
	};
}

function params(
	limit: UsageLimit,
	range: { startMs: number; endMs: number }
): Record<string, unknown> {
	return {
		startMs: range.startMs,
		endMs: range.endMs,
		provider: limit.provider,
		model: limit.model,
		meter: limit.meter,
	};
}

function configuredUnit(limit: UsageLimit, config: UsageConfig): string {
	if (limit.meter === 'cost') return 'USD';
	return config.rateCards[limit.meter]?.unit ?? limit.meter;
}

function periodRange(limit: UsageLimit, now: number): { startMs: number; endMs: number } {
	const period = limit.period ?? 'week';
	const periodMs = periodLengthMs(period);
	const endMs = now + 1;

	if (limit.startDate) {
		const anchor = parseLocalDate(limit.startDate);
		if (anchor !== undefined && anchor <= now) {
			const elapsedPeriods = Math.floor((now - anchor) / periodMs);
			return { startMs: anchor + elapsedPeriods * periodMs, endMs };
		}
	}

	if (period === 'day') {
		const start = new Date(now);
		start.setHours(0, 0, 0, 0);
		return { startMs: start.getTime(), endMs };
	}

	if (period === 'month') {
		const start = new Date(now);
		start.setDate(1);
		start.setHours(0, 0, 0, 0);
		return { startMs: start.getTime(), endMs };
	}

	return { startMs: now - periodMs + 1, endMs };
}

function periodLengthMs(period: UsageLimit['period']): number {
	if (period === 'day') return 24 * 60 * 60 * 1000;
	if (period === 'month' || period === '30d') return 30 * 24 * 60 * 60 * 1000;
	return 7 * 24 * 60 * 60 * 1000;
}

function parseLocalDate(dateText: string): number | undefined {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(dateText)) return undefined;
	const value = new Date(`${dateText}T00:00:00`).getTime();
	return Number.isFinite(value) ? value : undefined;
}

function formatLimitsError(error: unknown, resetColor: string): string {
	const message = error instanceof Error ? error.message : String(error);
	return `${RED}limits: ⚠ ${message}${resetColor}`;
}

function formatLimitStatus(status: LimitStatus, resetColor: string): string {
	const percent = `${Math.round(status.percent * 100)}%`;
	const used = formatAmount(status.used, status.unit);
	const maximum = formatAmount(status.limit, status.unit);
	const text = `${status.label}: ${percent} (~${used}/${maximum})`;
	if (status.color === 'red') return `${RED}${text}${resetColor}`;
	if (status.color === 'yellow') return `${YELLOW}${text}${resetColor}`;
	return text;
}

function formatAmount(value: number, unit: string): string {
	if (unit === 'USD') return formatCurrency({ value });
	if (unit === 'tokens') return formatTokens({ value });
	return `${formatNumber(value)} ${unit}`;
}

function formatNumber(value: number): string {
	if (Math.abs(value) >= 1_000) return formatTokens({ value });
	if (Number.isInteger(value)) return String(value);
	return value
		.toFixed(Math.abs(value) < 0.01 ? 4 : 2)
		.replace(/0+$/, '')
		.replace(/\.$/, '');
}

function numberOr(value: unknown, fallback: number): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
