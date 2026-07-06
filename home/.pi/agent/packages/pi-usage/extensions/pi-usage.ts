import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { closeDb, getDbPath, recordUsage } from "./db";
import { parseUsageArgs, usageHelp } from "./args";
import { importSessions } from "./importer";
import { exportCsv, renderReport } from "./reporting";
import { usageEventFromMessage } from "./importer";
import { renderLimitsStatus } from "./limits";

export default function piUsageExtension(pi: ExtensionAPI) {
  let liveInsertCount = 0;

  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    updateLimitsStatus(ctx);
  });

  pi.on("message_end", async (event: any, ctx: ExtensionContext) => {
    const message = event.message;
    if (message?.role !== "assistant" || !message.usage) return;

    try {
      const sessionFile = ctx.sessionManager.getSessionFile?.();
      const entryId = findEntryIdForMessage(ctx, message);
      const usageEvent = usageEventFromMessage(message, {
        source: "live",
        sessionFile,
        sessionEntryId: entryId,
        cwd: ctx.cwd,
      });
      if (!usageEvent) return;
      const result = recordUsage(usageEvent);
      if (result === "inserted") liveInsertCount++;
      updateLimitsStatus(ctx);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`pi-usage failed to record usage: ${message}`, "error");
    }
  });

  pi.on("session_shutdown", async (_event, ctx: ExtensionContext) => {
    ctx.ui.setStatus("usage-limits", undefined);
    closeDb();
  });

  pi.registerCommand("usage", {
    description:
      "Show token usage and cost reports, import history, or export CSV",
    getArgumentCompletions: (prefix: string) => {
      const values = [
        "today",
        "week",
        "month",
        "7d",
        "30d",
        "1 month",
        "since ",
        "provider ",
        "model ",
        "import",
        "export ",
      ];
      return values
        .filter((value) => value.startsWith(prefix))
        .map((value) => ({ value, label: value.trim() }));
    },
    handler: async (args: string, ctx: any) => {
      let command;
      try {
        command = parseUsageArgs(args);
      } catch (error) {
        ctx.ui.notify(
          error instanceof Error ? error.message : usageHelp,
          "error",
        );
        return;
      }

      try {
        if (command.kind === "import") {
          let latestProgress =
            "Finding session files... Do not close this window.";
          const notifyProgress = () => ctx.ui.notify(latestProgress, "info");
          notifyProgress();
          const reminder = setInterval(notifyProgress, 5000);

          try {
            let lastProgressNotifyMs = 0;
            let lastNotifiedFilesScanned = -1;
            const summary = await importSessions(undefined, (progress) => {
              const lines = [
                "Importing usage history... Do not close this window.",
                `Files scanned: ${progress.filesScanned}/${progress.totalFiles}`,
                `Assistant usage events found: ${progress.eventsFound}`,
                `Inserted: ${progress.inserted}`,
                `Already present: ${progress.alreadyPresent}`,
                `Errors: ${progress.errors}`,
              ];
              if (progress.currentFile) {
                lines.push(`Current file: ${basename(progress.currentFile)}`);
              }
              latestProgress = lines.join("\n");

              const now = Date.now();
              const shouldNotify =
                lastProgressNotifyMs === 0 ||
                progress.filesScanned !== lastNotifiedFilesScanned ||
                now - lastProgressNotifyMs >= 5000;
              if (shouldNotify) {
                lastProgressNotifyMs = now;
                lastNotifiedFilesScanned = progress.filesScanned;
                notifyProgress();
              }
            });
            ctx.ui.notify(
              [
                "Usage import complete",
                `Files scanned: ${summary.filesScanned}`,
                `Assistant usage events found: ${summary.eventsFound}`,
                `Inserted: ${summary.inserted}`,
                `Already present: ${summary.alreadyPresent}`,
                `Errors: ${summary.errors}`,
                `DB: ${getDbPath()}`,
              ].join("\n"),
              summary.errors > 0 ? "warning" : "info",
            );
            updateLimitsStatus(ctx);
          } finally {
            clearInterval(reminder);
          }
          return;
        }

        if (command.kind === "export") {
          const outputPath = exportCsv(
            command,
            command.path,
            ctx.cwd ?? process.cwd(),
          );
          ctx.ui.notify(`Usage CSV exported: ${outputPath}`, "info");
          return;
        }

        const report = renderReport(command, { limitResetColor: themeFgStart(ctx.ui?.theme, "dim") });
        const footer =
          liveInsertCount > 0
            ? `\n\nLive events recorded this runtime: ${liveInsertCount}`
            : "";
        ctx.ui.notify(`${report}${footer}\n\nDB: ${getDbPath()}`, "info");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Usage command failed: ${message}`, "error");
      }
    },
  });
}

function findEntryIdForMessage(
  ctx: ExtensionContext,
  message: any,
): string | undefined {
  const entries = ctx.sessionManager.getEntries?.() ?? [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i] as any;
    if (entry?.type !== "message") continue;
    if (entry.message?.role !== "assistant") continue;
    if (entry.message === message) return string(entry.id);
    if (messagesMatch(entry.message, message)) return string(entry.id);
  }
  return undefined;
}

function messagesMatch(a: any, b: any): boolean {
  if (!a || !b) return false;
  return (
    a.role === b.role &&
    a.provider === b.provider &&
    a.model === b.model &&
    number(a.timestamp) === number(b.timestamp) &&
    usageSignature(a.usage) === usageSignature(b.usage)
  );
}

function usageSignature(usage: any): string {
  const cost = usage?.cost ?? {};
  return [
    number(usage?.input),
    number(usage?.output),
    number(usage?.cacheRead),
    number(usage?.cacheWrite),
    number(usage?.totalTokens),
    number(cost.total),
  ].join(":");
}

function updateLimitsStatus(ctx: ExtensionContext): void {
  try {
    ctx.ui.setStatus("usage-limits", renderLimitsStatus(Date.now(), themeFgStart(ctx.ui?.theme, "dim")));
  } catch {
    ctx.ui.setStatus("usage-limits", undefined);
  }
}

function themeFgStart(theme: any, color: string): string {
  const marker = "__pi_usage_marker__";
  if (!theme?.fg) return "\x1b[39m";
  try {
    const text = String(theme.fg(color, marker));
    const index = text.indexOf(marker);
    return index >= 0 ? text.slice(0, index) : "\x1b[39m";
  } catch {
    return "\x1b[39m";
  }
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function basename(file: string): string {
  return file.split(/[\\/]/).pop() || file;
}
