import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { createClaudeExecutableResolver } from "../../extensions/cli.ts";
import {
  COMPONENT_LIMITS,
  ComponentInventorySchema,
  hasApprovedComponents,
} from "../../extensions/components.ts";
import { createTestSession, lastAssistant } from "./session.ts";
import { failureCategory } from "./provider-diagnostics.ts";

export const DIAGNOSTIC_LIMITS = {
  ...COMPONENT_LIMITS,
  timeoutMs: 15_000,
  maxTokens: 32,
};
export const DIAGNOSTIC_PROMPT =
  "Initialization identity diagnostic only. Do not use any tools. Reply with OK only.";
// Use the production raw boundary contract. Path is validated but never copied
// into the report; only bounded identities are released.
const EventKindSchema = Type.Object({
  type: Type.String({ minLength: 1, maxLength: 64 }),
  subtype: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
});
type Inventory = {
  plugins: Omit<Static<typeof ComponentInventorySchema>["plugins"][number], "path">[];
  skills: Static<typeof ComponentInventorySchema>["skills"];
};
type DiagnosticReport = {
  diagnosticSuccess: boolean;
  bridgeAcceptance: "not-tested";
  outcome: "failed" | "isolation-rejected" | "approved-init-stopped";
  category: string;
  promptCount: number;
  requestCount: number;
  initCount: number;
  cliVersion?: string;
  sdkVersion?: string;
  inventory?: Inventory;
};
const CLEAN_STOP = "pi-claude-diagnostic: approved initialization stopped before output handling";

/** ASCII-only JSON: JSON.stringify escapes C0; this also escapes DEL, bidi,
 * other format/control characters and all non-ASCII UTF-16 code units. */
export function diagnosticJson({ report }: { report: DiagnosticReport }) {
  return JSON.stringify(report).replace(
    /[\u007f-\uffff]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/** One prompt, one request, no retry. Live callers MUST separately opt in.
 * Capture success is NOT bridge acceptance, nor proof of zero model usage:
 * the native runtime may already have started work before delivering init. */
export async function runInitializationDiagnostic({ live }: { live: boolean }) {
  let run: Awaited<ReturnType<typeof createTestSession>> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pendingAttempt: Promise<void> | undefined;
  const controller = new AbortController();
  const report: DiagnosticReport = {
    diagnosticSuccess: false,
    bridgeAcceptance: "not-tested",
    outcome: "failed",
    category: "setup-failed",
    promptCount: 0,
    requestCount: 0,
    initCount: 0,
  };
  let violation: string | undefined;
  let cleanStopped = false;
  function reject({ category }: { category: string }): never {
    violation ??= category;
    throw new Error("pi-claude-diagnostic: stopped");
  }
  try {
    run = await createTestSession({
      live,
      extensions: [
        (pi) => {
          // Keep the exact production tool/MCP surface, but authorize NO Pi
          // actions in this diagnostic, even if an upstream boundary regresses.
          pi.on("tool_call", () => {
            violation ??= "tool-dispatch-forbidden";
            controller.abort();
            return { block: true, reason: "Initialization diagnostic forbids all Pi actions" };
          });
        },
      ],
    });
    const active = run;
    const timeout = new Promise<never>((_resolve, rejectTimeout) => {
      timer = setTimeout(() => {
        violation ??= "timeout";
        controller.abort();
        rejectTimeout(new Error("pi-claude-diagnostic: timeout"));
      }, DIAGNOSTIC_LIMITS.timeoutMs);
    });
    const attempt = async () => {
      const executable = await createClaudeExecutableResolver().resolve({
        cwd: active.cwd,
        warn: () => undefined, // Warnings can contain local executable paths.
      });
      report.cliVersion = executable.version;
      report.sdkVersion = executable.sdkVersion;
      if (controller.signal.aborted) reject({ category: "cancelled" });
      const haiku = (await active.modelRuntime.getAvailable(active.session.model?.provider))
        .filter((model) => /haiku/i.test(model.id))
        .toSorted((a, b) => a.cost.input + a.cost.output - b.cost.input - b.cost.output)[0];
      if (!haiku) reject({ category: "no-eligible-haiku" });
      await active.session.setModel(haiku);
      const original = active.session.agent.streamFunction;
      active.session.agent.streamFunction = (model, context, options) => {
        report.requestCount++;
        if (report.requestCount !== 1 || controller.signal.aborted)
          reject({ category: "extra-request-or-cancelled" });
        return original(model, context, {
          ...options,
          maxTokens: DIAGNOSTIC_LIMITS.maxTokens,
          signal: options?.signal
            ? AbortSignal.any([options.signal, controller.signal])
            : controller.signal,
          onProviderStreamEvent: async (event, responseModel) => {
            if (!Value.Check(EventKindSchema, event)) reject({ category: "malformed-event" });
            if (event.type === "system" && event.subtype === "init") {
              report.initCount++;
              if (report.initCount !== 1) reject({ category: "extra-init" });
              if (!Value.Check(ComponentInventorySchema, event))
                reject({ category: "invalid-inventory" });
              report.inventory = {
                plugins: event.plugins.map((plugin) => ({
                  name: plugin.name,
                  ...(plugin.source === undefined ? {} : { source: plugin.source }),
                  ...(plugin.version === undefined ? {} : { version: plugin.version }),
                })),
                skills: [...event.skills],
              };
              if (hasApprovedComponents({ value: event })) {
                cleanStopped = true;
                throw new Error(CLEAN_STOP);
              }
              // Unapproved: return to production's shared classifier so the
              // provider rejects this init. Approved singleton/empty init stops
              // above, never advancing to model output or Pi actions.
            } else if (event.type !== "auth_status") {
              reject({ category: report.initCount ? "post-init-activity" : "pre-init-activity" });
            }
            await options?.onProviderStreamEvent?.(event, responseModel);
          },
        });
      };
      if (controller.signal.aborted) reject({ category: "cancelled" });
      report.category = "missing-report";
      report.promptCount++;
      await active.session.prompt(DIAGNOSTIC_PROMPT);
      const assistant = lastAssistant(active);
      if (violation) return;
      if (!report.inventory || report.initCount !== 1 || report.requestCount !== 1) return;
      if (assistant.stopReason !== "error") {
        report.category = "unexpected-completion";
        return;
      }
      if (cleanStopped && assistant.errorMessage?.includes(CLEAN_STOP)) {
        report.outcome = "approved-init-stopped";
        report.category = "deliberate-diagnostic-stop";
      } else if (
        !cleanStopped &&
        failureCategory({ message: assistant.errorMessage }) === "initialization-isolation"
      ) {
        report.outcome = "isolation-rejected";
        report.category = "initialization-isolation";
      } else {
        report.category = "unexpected-provider-failure";
        return;
      }
      report.diagnosticSuccess = true;
    };
    pendingAttempt = attempt();
    await Promise.race([pendingAttempt, timeout]);
  } catch {
    // SDK exceptions can contain stderr, paths, identities, or transcripts.
    // Neither a cause nor the original error is ever forwarded or printed.
    report.category = violation ?? "diagnostic-failed";
  } finally {
    clearTimeout(timer);
    controller.abort();
    try {
      await run?.session.abort();
      // Drain the aborted attempt before removing its environment/workspace.
      // Otherwise a timeout during metadata could resume after disposal.
      await pendingAttempt?.catch(() => undefined);
    } catch {
      violation ??= "cleanup-failed";
    } finally {
      try {
        run?.dispose();
      } catch {
        violation ??= "cleanup-failed";
      }
    }
  }
  if (violation) {
    report.diagnosticSuccess = false;
    report.outcome = "failed";
    report.category = violation;
  }
  return report;
}
