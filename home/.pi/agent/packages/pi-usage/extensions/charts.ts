export type ChartRow = Record<string, unknown>;

export function formatTokens({ value }: { value: unknown }): string {
	const n = asNumber({ value });
	if (n < 1_000) return String(Math.round(n));
	if (n < 1_000_000) return `${trimFixed({ value: n / 1_000, digits: 1 })}K`;
	return `${trimFixed({ value: n / 1_000_000, digits: 1 })}M`;
}

export function formatCurrency({ value }: { value: unknown }): string {
	const n = asNumber({ value });
	if (n === 0) return '$0.00';
	if (Math.abs(n) < 0.01) return `$${n.toFixed(4)}`;
	return `$${n.toFixed(2)}`;
}

export function barChart({
	rows,
	valueKey,
	labelKey,
	options = {},
}: {
	rows: ChartRow[];
	valueKey: string;
	labelKey: string;
	options?: {
		width?: number;
		formatValue?: (args: { value: unknown; row: ChartRow }) => string;
	};
}): string {
	if (rows.length === 0) return '(no daily usage)';
	const width = options.width ?? 30;
	const formatValue =
		options.formatValue ?? (({ value }: { value: unknown }) => formatCurrency({ value }));
	const max = Math.max(...rows.map((row) => asNumber({ value: row[valueKey] })), 0);
	return rows
		.map((row) => {
			const label = String(row[labelKey] ?? '');
			const value = asNumber({ value: row[valueKey] });
			const barLength =
				max > 0 ? Math.max(value > 0 ? 1 : 0, Math.round((value / max) * width)) : 0;
			return `${label.padEnd(10)} ${'█'.repeat(barLength)} ${formatValue({ value, row })}`.trimEnd();
		})
		.join('\n');
}

function asNumber({ value }: { value: unknown }): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function trimFixed({ value, digits }: { value: number; digits: number }): string {
	return value.toFixed(digits).replace(/\.0$/, '');
}
