import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { closeDb, getDbPath, recordUsage } from "./db";
import { parseUsageArgs, usageHelp } from "./args";
import { importSessions } from "./importer";
import { exportCsv, renderReport } from "./reporting";
import { usageEventFromMessage } from "./importer";

export default function piUsageExtension(pi: ExtensionAPI) {
  let liveInsertCount = 0;

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
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`pi-usage failed to record usage: ${message}`, "error");
    }
  });

  pi.on("session_shutdown", async () => {
    closeDb();
  });

  pi.registerCommand("usage", {
    description: "Show token usage and cost reports, import history, or export CSV",
    getArgumentCompletions: (prefix: string) => {
      const values = ["today", "week", "month", "7d", "30d", "1 month", "since ", "provider ", "model ", "import", "export "];
      return values.filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value.trim() }));
    },
    handler: async (args: string, ctx: any) => {
      let command;
      try {
        command = parseUsageArgs(args);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : usageHelp, "error");
        return;
      }

      try {
        if (command.kind === "import") {
          const summary = await importSessions();
          ctx.ui.notify([
            "Usage import complete",
            `Files scanned: ${summary.filesScanned}`,
            `Assistant usage events found: ${summary.eventsFound}`,
            `Inserted: ${summary.inserted}`,
            `Already present: ${summary.alreadyPresent}`,
            `Errors: ${summary.errors}`,
            `DB: ${getDbPath()}`,
          ].join("\n"), summary.errors > 0 ? "warning" : "info");
          return;
        }

        if (command.kind === "export") {
          const outputPath = exportCsv(command, command.path, ctx.cwd ?? process.cwd());
          ctx.ui.notify(`Usage CSV exported: ${outputPath}`, "info");
          return;
        }

        const report = renderReport(command);
        const footer = liveInsertCount > 0 ? `\n\nLive events recorded this runtime: ${liveInsertCount}` : "";
        ctx.ui.notify(`${report}${footer}\n\nDB: ${getDbPath()}`, "info");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Usage command failed: ${message}`, "error");
      }
    },
  });
}

function findEntryIdForMessage(ctx: ExtensionContext, message: any): string | undefined {
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

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
