import fs from 'node:fs';
import path from 'node:path';
import { getDb } from './db';
import type { Range } from './args';
import { barChart, formatCurrency, formatTokens } from './charts';
import { renderLimitsReport } from './limits';

export type Filters = { range: Range; provider?: string; model?: string };

export function renderReport(filters: Filters, options: { limitResetColor?: string } = {}): string {
	const db = getDb();
	const params = queryParams(filters);
	const where = whereClause(filters);

	const summary = db
		.prepare(
			`
    SELECT e.provider, e.model,
      SUM(e.input_tokens) AS input_tokens,
      SUM(e.output_tokens) AS output_tokens,
      SUM(e.cache_read_tokens) AS cache_read_tokens,
      SUM(e.cache_write_tokens) AS cache_write_tokens,
      SUM(e.total_tokens) AS total_tokens,
      SUM(COALESCE(c.total_amount, 0)) AS total_cost
    FROM usage_events e
    LEFT JOIN usage_charges c ON c.event_key = e.unique_key AND c.meter = 'cost'
    WHERE ${where}
    GROUP BY e.provider, e.model
    ORDER BY total_cost DESC, total_tokens DESC
  `
		)
		.all(params);

	const dailyRows = db
		.prepare(
			`
    SELECT e.day, SUM(COALESCE(c.total_amount, 0)) AS total_cost, SUM(e.total_tokens) AS total_tokens
    FROM usage_events e
    LEFT JOIN usage_charges c ON c.event_key = e.unique_key AND c.meter = 'cost'
    WHERE ${where}
    GROUP BY e.day
    ORDER BY e.day ASC
  `
		)
		.all(params);
	const daily = fillMissingDays(
		dailyRows,
		filters.range.startMs,
		Math.min(filters.range.endMs - 1, Date.now())
	);

	const projects = db
		.prepare(
			`
    SELECT COALESCE(e.project_id, e.cwd, 'unknown') AS project_id,
      SUM(COALESCE(c.total_amount, 0)) AS total_cost,
      SUM(e.total_tokens) AS total_tokens
    FROM usage_events e
    LEFT JOIN usage_charges c ON c.event_key = e.unique_key AND c.meter = 'cost'
    WHERE ${where}
    GROUP BY COALESCE(e.project_id, e.cwd, 'unknown')
    ORDER BY total_cost DESC, total_tokens DESC
  `
		)
		.all(params);

	const totalCost = summary.reduce((sum: number, row: any) => sum + Number(row.total_cost ?? 0), 0);
	const totalTokens = summary.reduce(
		(sum: number, row: any) => sum + Number(row.total_tokens ?? 0),
		0
	);
	const titleBits = [`Usage: ${filters.range.label}`];
	if (filters.provider) titleBits.push(`provider ${filters.provider}`);
	if (filters.model) titleBits.push(`model ${filters.model}`);

	const sections = [
		titleBits.join(' — '),
		`Total: ${formatTokens({ value: totalTokens })} tokens, ${formatCurrency({ value: totalCost })}`,
	];
	const limitsReport = renderLimitsReport(Date.now(), options.limitResetColor);
	if (limitsReport) sections.push('', limitsReport);
	sections.push(
		'',
		renderSummaryTable(summary),
		'',
		renderCoverageLine(daily),
		'',
		'Daily usage',
		barChart({
			rows: daily,
			valueKey: 'total_cost',
			labelKey: 'day',
			options: { formatValue: formatDailyUsage },
		}),
		'',
		'By project',
		renderProjectTable(projects)
	);
	return sections.join('\n');
}

export function exportCsv(filters: Filters, outputPath?: string, cwd = process.cwd()): string {
	const db = getDb();
	const params = queryParams(filters);
	const where = whereClause(filters);
	const rows = db
		.prepare(
			`
    SELECT e.timestamp_ms, e.day, e.provider, e.model, e.api,
      e.input_tokens, e.output_tokens, e.cache_read_tokens, e.cache_write_tokens, e.total_tokens,
      e.cwd, e.project_id, e.session_file, e.session_entry_id, e.source,
      c.meter, c.unit, c.rate_card, c.rates_json,
      c.input_amount, c.output_amount, c.cache_read_amount, c.cache_write_amount, c.total_amount
    FROM usage_events e
    LEFT JOIN usage_charges c ON c.event_key = e.unique_key
    WHERE ${where}
    ORDER BY e.timestamp_ms ASC, c.meter ASC
  `
		)
		.all(params);

	const headers = [
		'timestamp',
		'day',
		'provider',
		'model',
		'api',
		'input_tokens',
		'output_tokens',
		'cache_read_tokens',
		'cache_write_tokens',
		'total_tokens',
		'cwd',
		'project_id',
		'session_file',
		'session_entry_id',
		'source',
		'meter',
		'unit',
		'rate_card',
		'rates_json',
		'input_amount',
		'output_amount',
		'cache_read_amount',
		'cache_write_amount',
		'total_amount',
	];
	const csv =
		[headers.join(',')]
			.concat(
				rows.map((row: any) => headers.map((header) => csvCell(valueForCsv(row, header))).join(','))
			)
			.join('\n') + '\n';
	const finalPath = outputPath
		? path.resolve(cwd, expandHome(outputPath))
		: path.resolve(cwd, `usage-export-${new Date().toISOString().slice(0, 10)}.csv`);
	fs.mkdirSync(path.dirname(finalPath), { recursive: true });
	fs.writeFileSync(finalPath, csv, 'utf8');
	return finalPath;
}

function renderSummaryTable(rows: any[]): string {
	if (rows.length === 0) return 'No usage recorded for this range.';
	const tableRows = rows.map((row) => [
		String(row.provider ?? 'unknown'),
		String(row.model ?? 'unknown'),
		formatTokens({ value: row.input_tokens }),
		formatTokens({ value: row.output_tokens }),
		formatTokens({ value: row.cache_read_tokens }),
		formatTokens({ value: row.cache_write_tokens }),
		formatCurrency({ value: row.total_cost }),
	]);
	const headers = ['Provider', 'Model', 'Input', 'Output', 'Cache R', 'Cache W', 'Cost'];
	const widths = headers.map((header, index) =>
		Math.max(header.length, ...tableRows.map((row) => row[index].length))
	);
	const formatRow = (row: string[]) =>
		row
			.map((cell, index) => cell.padEnd(widths[index]))
			.join('  ')
			.trimEnd();
	return [
		formatRow(headers),
		formatRow(widths.map((w) => '─'.repeat(w))),
		...tableRows.map(formatRow),
	].join('\n');
}

function renderProjectTable(rows: any[]): string {
	if (rows.length === 0) return 'No usage recorded for this range.';
	const tableRows = rows.map((row) => [
		String(row.project_id ?? 'unknown'),
		formatTokens({ value: row.total_tokens }),
		formatCurrency({ value: row.total_cost }),
	]);
	const headers = ['Project', 'Tokens', 'Cost'];
	const widths = headers.map((header, index) =>
		Math.max(header.length, ...tableRows.map((row) => row[index].length))
	);
	const formatRow = (row: string[]) =>
		row
			.map((cell, index) => cell.padEnd(widths[index]))
			.join('  ')
			.trimEnd();
	return [
		formatRow(headers),
		formatRow(widths.map((w) => '─'.repeat(w))),
		...tableRows.map(formatRow),
	].join('\n');
}

function formatDailyUsage({
	value,
	row,
}: {
	value: unknown;
	row: Record<string, unknown>;
}): string {
	return `${formatCurrency({ value })}  ${formatTokens({ value: row.total_tokens })} tokens`;
}

function renderCoverageLine(rows: any[]): string {
	if (rows.length === 0) return 'Recorded days: 0';
	const usedDays = rows.filter(
		(row) => Number(row.total_tokens ?? 0) > 0 || Number(row.total_cost ?? 0) > 0
	).length;
	return `Recorded days: ${usedDays} of ${rows.length}`;
}

function fillMissingDays(rows: any[], startMs: number, endMs: number): any[] {
	const days = localDaysBetween(startMs, endMs);
	if (days.length === 0 || days.length > 62) return rows;
	const byDay = new Map(rows.map((row) => [String(row.day), row]));
	return days.map((day) => byDay.get(day) ?? { day, total_cost: 0, total_tokens: 0 });
}

function localDaysBetween(startMs: number, endMs: number): string[] {
	if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return [];
	const cursor = new Date(startMs);
	cursor.setHours(0, 0, 0, 0);
	const end = new Date(endMs);
	end.setHours(0, 0, 0, 0);
	const days: string[] = [];
	while (cursor.getTime() <= end.getTime()) {
		days.push(localDay(cursor));
		cursor.setDate(cursor.getDate() + 1);
	}
	return days;
}

function localDay(date: Date): string {
	const y = date.getFullYear();
	const m = String(date.getMonth() + 1).padStart(2, '0');
	const d = String(date.getDate()).padStart(2, '0');
	return `${y}-${m}-${d}`;
}

function whereClause(filters: Filters): string {
	const clauses = ['e.timestamp_ms >= @startMs', 'e.timestamp_ms < @endMs'];
	if (filters.provider) clauses.push('e.provider = @provider');
	if (filters.model) clauses.push('e.model = @model');
	return clauses.join(' AND ');
}

function queryParams(filters: Filters): Record<string, unknown> {
	return {
		startMs: filters.range.startMs,
		endMs: filters.range.endMs,
		provider: filters.provider,
		model: filters.model,
	};
}

function valueForCsv(row: any, header: string): unknown {
	if (header === 'timestamp') return new Date(row.timestamp_ms).toISOString();
	return row[header];
}

function csvCell(value: unknown): string {
	if (value === null || value === undefined) return '';
	const text = String(value);
	if (!/[",\n\r]/.test(text)) return text;
	return `"${text.replace(/"/g, '""')}"`;
}

function expandHome(value: string): string {
	if (value === '~') return process.env.HOME ?? value;
	if (value.startsWith('~/')) return path.join(process.env.HOME ?? '~', value.slice(2));
	return value;
}
