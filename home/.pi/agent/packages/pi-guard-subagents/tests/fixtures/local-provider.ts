import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { Type } from "typebox";
import { parseOrThrow } from "../../extensions/interactive/types.ts";
import { approveProviderExtension, CLAUDE_BRIDGE_PROVIDER } from "../../extensions/interactive/provider-extensions.ts";

export const LOCAL_PROVIDER_MODEL_ID = "child";
export const OTHER_EXTENSION_SECTION = { name: "other_extension", content: "other extension retained" };
export const LocalProviderFixtureSchema = Type.Object(
	{
		baseUrl: Type.String({ pattern: "^http://127\\.0\\.0\\.1:[0-9]+/v1$" }),
	},
	{ additionalProperties: false },
);

/** A real extension provider backed exclusively by a loopback test server. */
export default function localProvider(pi: ExtensionAPI): void {
	const config = parseOrThrow(
		LocalProviderFixtureSchema,
		JSON.parse(readFileSync(new URL("local-provider.json", import.meta.url), "utf8")),
		"local provider fixture",
	);
	approveProviderExtension({ pi, provider: CLAUDE_BRIDGE_PROVIDER });
	pi.registerProvider(CLAUDE_BRIDGE_PROVIDER, {
		baseUrl: config.baseUrl,
		api: "openai-completions",
		apiKey: "local",
		models: [
			{
				id: LOCAL_PROVIDER_MODEL_ID,
				name: "local child",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 32000,
				maxTokens: 1024,
			},
		],
	} satisfies ProviderConfig);
	pi.registerTool({
		name: "unapproved_provider_tool",
		label: "Not approved",
		description: "Must not leak into children",
		parameters: Type.Object({}),
		execute: async () => {
			throw new Error("Unapproved provider tool executed");
		},
	});
	pi.on("before_agent_start", (event) => {
		event.systemPromptOptions.sections[OTHER_EXTENSION_SECTION.name] = OTHER_EXTENSION_SECTION.content;
	});
}
