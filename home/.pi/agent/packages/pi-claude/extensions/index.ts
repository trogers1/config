import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createProvider, type Model, type ProviderStreams } from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  approveProviderExtension,
  CLAUDE_BRIDGE_PROVIDER,
} from "../../pi-guard-subagents/extensions/interactive/provider-extensions.ts";
import { createSessionProvider, type SessionBinding } from "./provider.ts";
import { checkLatestClaudeSession } from "./reconstruction/index.ts";

export default function piClaude(pi: ExtensionAPI) {
  const bindings = new Map<string, SessionBinding>();
  const summarySessions = new WeakMap<AbortSignal, string>();
  const sourceModels = new Map<string, Model<"anthropic-messages">>();
  const runtime = createSessionProvider({ bindings, summarySessions, sourceModels });
  function remember({ ctx }: { ctx: ExtensionContext }) {
    const id = ctx.sessionManager.getSessionId();
    // Notification failures alone do not block Pi requests; erase old trust
    // before resolving the new context so a failed refresh cannot reuse it.
    bindings.delete(id);
    bindings.set(id, {
      cwd: realpathSync(ctx.cwd),
      trusted: ctx.isProjectTrusted(),
      warn: ({ message }) => ctx.ui.notify(message, "warning"),
    });
  }
  pi.on("session_start", async (_event, ctx) => {
    remember({ ctx });
    const result = await checkLatestClaudeSession({
      claudeConfigDir: resolve(process.env.CLAUDE_CONFIG_DIR ?? resolve(homedir(), ".claude")),
    });
    // The checker returns metadata-only diagnostics. Never print transcript
    // lines, content, parsing errors containing source data, or credentials.
    if (result.status === "warning") ctx.ui.notify(result.warning, "warning");
  });
  pi.on("before_provider_request", (_event, ctx) => {
    remember({ ctx });
  });
  pi.on("session_before_compact", (event, ctx) => {
    remember({ ctx });
    summarySessions.set(event.signal, ctx.sessionManager.getSessionId());
  });
  pi.on("session_before_tree", (event, ctx) => {
    remember({ ctx });
    summarySessions.set(event.signal, ctx.sessionManager.getSessionId());
  });
  async function closeQueries({ id, forget = false }: { id: string; forget?: boolean }) {
    const release = forget ? runtime.forget : runtime.close;
    await release({ id });
    await release({ id: `${id}:summary` });
  }
  pi.on("agent_settled", (_event, ctx) => closeQueries({ id: ctx.sessionManager.getSessionId() }));
  async function closeSession({ ctx }: { ctx: ExtensionContext }) {
    const id = ctx.sessionManager.getSessionId();
    bindings.delete(id);
    await closeQueries({ id, forget: true });
  }
  pi.on("session_before_switch", (_event, ctx) => closeSession({ ctx }));
  pi.on("session_before_fork", (_event, ctx) => closeSession({ ctx }));
  pi.on("session_shutdown", (_event, ctx) => closeSession({ ctx }));
  const catalog = getBuiltinModels("anthropic");
  for (const source of catalog) sourceModels.set(source.id, source);
  const models: Model<string>[] = [];
  for (const alias of ["haiku", "sonnet", "opus"]) {
    const source = [...catalog]
      .filter((model) => model.id.startsWith(`claude-${alias}-`))
      .sort((a, b) =>
        b.id
          .replace(/-\d{8}$/, "")
          .localeCompare(a.id.replace(/-\d{8}$/, ""), undefined, { numeric: true }),
      )[0];
    if (!source) throw new Error(`pi-claude: Pi's Anthropic catalog has no ${alias} model`);
    const model = {
      ...source,
      provider: CLAUDE_BRIDGE_PROVIDER,
      api: "claude-code",
      contextWindow: Math.min(source.contextWindow, 200_000),
      promptCache: undefined,
      compat: undefined,
    } satisfies Model<string>;
    models.push(model, { ...model, id: alias, name: `Claude ${alias} (runtime alias)` });
    sourceModels.set(model.id, source);
    sourceModels.set(alias, source);
  }
  const api = {
    stream(model, context, options) {
      return runtime.stream({ model, context, options });
    },
    streamSimple(model, context, options) {
      return runtime.stream({ model, context, options });
    },
  } satisfies ProviderStreams;
  pi.registerProvider(
    createProvider({
      id: CLAUDE_BRIDGE_PROVIDER,
      name: "Claude Code (owned SDK provider)",
      // Availability does not assert authentication or subscription eligibility.
      // The official runtime owns authentication and reports its failures.
      auth: {
        apiKey: {
          name: "Claude Code runtime authentication",
          async resolve() {
            return { auth: {} };
          },
        },
      },
      models,
      api,
    }),
  );
  approveProviderExtension({ pi, provider: CLAUDE_BRIDGE_PROVIDER });
}
