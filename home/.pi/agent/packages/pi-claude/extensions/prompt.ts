import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { getPackageDir, type BuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  getCurrentSystemMessage,
  getSystemMessageText,
  type Tool,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { sdkToolName } from "./mcp.ts";
import { parseOrThrow } from "./validation.ts";

// Version the ownership split as well as its text: checkpoints must never cross
// a change between a custom base and the native preset.
export const PROMPT_MODE = "claude-code-preset-pi-context-v2";
const SectionsSchema = Type.Record(Type.String(), Type.String());
let stock: Promise<Record<string, string>> | undefined;

/** Isolated compatibility boundary: Pi does not publicly export its builder.
 * Resolve only this known module from the actual loaded host, never a global
 * installation path. Unknown versions fail explicitly rather than lose context.
 */
async function stockSections() {
  stock ??= (async () => {
    try {
      const module: unknown = await import(
        pathToFileURL(join(getPackageDir(), "dist/core/system-prompt.js")).href
      );
      if (
        typeof module !== "object" ||
        module === null ||
        !("buildSystemPromptSections" in module) ||
        typeof module.buildSystemPromptSections !== "function"
      )
        throw new Error("missing host builder");
      const options = { cwd: "/" } satisfies BuildSystemPromptOptions;
      const sections = parseOrThrow({
        schema: SectionsSchema,
        value: module.buildSystemPromptSections(options),
        source: "host stock prompt sections",
      });
      if (!sections.preamble || !sections.docs) throw new Error("missing host stock preamble/docs");
      return sections;
    } catch (cause) {
      throw new Error("pi-claude: incompatible Pi host system-prompt builder", { cause });
    }
  })();
  return stock;
}

/** Opaque content is never parsed or deduplicated. Only independently rendered
 * structured sections exactly matching the host's own stock values are omitted.
 * A payload-hook rewrite owns the whole string and is retained verbatim.
 */
export async function nativeSystemPrompt({
  messages,
  sourceSystem,
  systemPrompt,
  tools,
}: {
  messages: TranscriptContext["messages"];
  sourceSystem: string;
  systemPrompt: string;
  tools: Tool[];
}): Promise<Options["systemPrompt"]> {
  const defaults = await stockSections();
  const current = getCurrentSystemMessage(messages);
  let append = systemPrompt;
  if (current?.sections && systemPrompt === sourceSystem) {
    const sections = { ...current.sections };
    for (const name of ["preamble", "docs"]) {
      if (sections[name] === defaults[name]) delete sections[name];
    }
    append = getSystemMessageText({ ...current, sections });
  }
  const names = tools.map((tool) => `- ${tool.name}: call ${sdkToolName({ name: tool.name })}`);
  const guidance = [
    "# Pi tool naming (Claude transport)",
    "Only the advertised mcp__pi__ names are callable as direct model tools. Native Claude tools and bare Pi names are unavailable.",
    "References to short tool names in the preserved instructions above describe Pi operations; use the matching advertised name for direct calls:",
    ...names,
    "Inside codemode JavaScript ONLY, keep the original short API (for example tools.bash(args)); do not prefix script APIs. Tool descriptions' Codemode examples refer to this script API, not direct model tool calls.",
  ].join("\n");
  return {
    type: "preset",
    preset: "claude_code",
    append: `${append}\n\n${guidance}`,
  } satisfies Options["systemPrompt"];
}
