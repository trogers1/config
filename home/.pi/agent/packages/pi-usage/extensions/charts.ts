export type ChartRow = Record<string, unknown>;

export function formatTokens(value: unknown): string {
  const n = asNumber(value);
  if (n < 1_000) return String(Math.round(n));
  if (n < 1_000_000) return `${trimFixed(n / 1_000, 1)}K`;
  return `${trimFixed(n / 1_000_000, 1)}M`;
}

export function formatCurrency(value: unknown): string {
  const n = asNumber(value);
  if (n === 0) return "$0.00";
  if (Math.abs(n) < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

export function barChart(
  rows: ChartRow[],
  valueKey: string,
  labelKey: string,
  options: { width?: number; formatValue?: (value: unknown, row: ChartRow) => string } = {},
): string {
  if (rows.length === 0) return "(no daily usage)";

  const width = options.width ?? 30;
  const formatValue: (value: unknown, row: ChartRow) => string = options.formatValue ?? ((value) => formatCurrency(value));
  const max = Math.max(...rows.map((row) => asNumber(row[valueKey])), 0);

  return rows
    .map((row) => {
      const label = String(row[labelKey] ?? "");
      const value = asNumber(row[valueKey]);
      const barLength = max > 0 ? Math.max(value > 0 ? 1 : 0, Math.round((value / max) * width)) : 0;
      return `${label.padEnd(10)} ${"█".repeat(barLength)} ${formatValue(value, row)}`.trimEnd();
    })
    .join("\n");
}

export function sparkline(values: number[]): string {
  if (values.length === 0) return "";
  const ticks = "▁▂▃▄▅▆▇█";
  const max = Math.max(...values);
  const min = Math.min(...values);
  if (max === min) return ticks[0].repeat(values.length);
  return values
    .map((value) => ticks[Math.round(((value - min) / (max - min)) * (ticks.length - 1))])
    .join("");
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function trimFixed(value: number, digits: number): string {
  return value.toFixed(digits).replace(/\.0$/, "");
}
