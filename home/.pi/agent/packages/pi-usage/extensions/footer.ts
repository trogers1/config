import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { formatCurrency, formatTokens } from "./charts";

type FooterCtx = {
  sessionManager: {
    getEntries(): any[];
    getCwd(): string;
    getSessionName?(): string | undefined;
  };
  model?: {
    id?: string;
    provider?: string;
    reasoning?: boolean;
  };
};

export function usageFooter(ctx: FooterCtx) {
  return (tui: any, theme: any, footerData: any) => {
    const unsubscribe = footerData.onBranchChange?.(() => tui.requestRender());

    return {
      dispose() {
        unsubscribe?.();
      },
      invalidate() {},
      render(width: number): string[] {
        const lines = renderDefaultFooterLines(ctx, footerData, theme, width);
        lines.push(...renderStatusLines(footerData.getExtensionStatuses(), theme, width));
        return lines;
      },
    };
  };
}

function renderDefaultFooterLines(ctx: FooterCtx, footerData: any, theme: any, width: number): string[] {
  const cwd = formatCwd(ctx.sessionManager.getCwd());
  const branch = footerData.getGitBranch?.();
  const sessionName = ctx.sessionManager.getSessionName?.();
  const pwdParts = [cwd];
  if (branch) pwdParts.push(`(${branch})`);
  if (sessionName) pwdParts.push(`• ${sessionName}`);

  const totals = usageTotals(ctx.sessionManager.getEntries());
  const statsParts: string[] = [];
  if (totals.input) statsParts.push(`↑${formatTokens(totals.input)}`);
  if (totals.output) statsParts.push(`↓${formatTokens(totals.output)}`);
  if (totals.cacheRead) statsParts.push(`R${formatTokens(totals.cacheRead)}`);
  if (totals.cacheWrite) statsParts.push(`W${formatTokens(totals.cacheWrite)}`);
  if (totals.cost) statsParts.push(formatCurrency(totals.cost));

  const model = ctx.model?.id || "no-model";
  const statsLeft = statsParts.join(" ") || "no usage";
  const statsLeftWidth = visibleWidth(statsLeft);
  const modelWidth = visibleWidth(model);
  const padding = " ".repeat(Math.max(1, width - statsLeftWidth - modelWidth));

  return [
    truncateToWidth(theme.fg("dim", pwdParts.join(" ")), width, theme.fg("dim", "...")),
    truncateToWidth(theme.fg("dim", statsLeft + padding + model), width, theme.fg("dim", "...")),
  ];
}

function renderStatusLines(statuses: Map<string, string>, theme: any, width: number): string[] {
  const lines: string[] = [];
  const profile = statuses.get("permissions");
  const limits = statuses.get("usage-limits");

  if (profile) lines.push(truncateToWidth(theme.fg("dim", sanitizeStatusText(profile)), width, theme.fg("dim", "...")));
  if (limits) lines.push(truncateToWidth(theme.fg("dim", sanitizeStatusText(limits)), width, theme.fg("dim", "...")));

  const remaining = Array.from(statuses.entries())
    .filter(([key]) => key !== "permissions" && key !== "usage-limits")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, text]) => sanitizeStatusText(text));
  if (remaining.length > 0) lines.push(truncateToWidth(theme.fg("dim", remaining.join(" ")), width, theme.fg("dim", "...")));

  return lines;
}

function usageTotals(entries: any[]): { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number } {
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  for (const entry of entries) {
    if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;
    const usage = entry.message.usage;
    if (!usage) continue;
    totals.input += number(usage.input);
    totals.output += number(usage.output);
    totals.cacheRead += number(usage.cacheRead);
    totals.cacheWrite += number(usage.cacheWrite);
    totals.cost += number(usage.cost?.total);
  }
  return totals;
}

function formatCwd(cwd: string): string {
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home || !cwd.startsWith(home)) return cwd;
  return cwd === home ? "~" : `~${cwd.slice(home.length)}`;
}

function sanitizeStatusText(text: string): string {
  return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
