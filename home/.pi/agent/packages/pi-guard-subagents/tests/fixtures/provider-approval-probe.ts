import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync, lstatSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { Type, type Static } from "typebox";
import { parseOrThrow } from "../../extensions/interactive/types.ts";
import {
	ProviderExtensionSchema,
	resolveProviderExtensions,
} from "../../extensions/interactive/provider-extensions.ts";

export const ApprovalProbeConfigSchema = Type.Object(
	{
		model: Type.String(),
		output: Type.String(),
		settings: Type.String(),
		sourceChange: Type.Optional(
			Type.Union([
				Type.Object({ kind: Type.Literal("append"), file: Type.String() }),
				Type.Object({ kind: Type.Literal("symlink"), file: Type.String(), target: Type.String() }),
				Type.Object({ kind: Type.Literal("unexpected-file"), file: Type.String() }),
			]),
		),
	},
	{ additionalProperties: false },
);
export const ApprovalProbeResultSchema = Type.Union([
	Type.Object({ status: Type.Literal("approved"), extensions: Type.Array(ProviderExtensionSchema) }),
	Type.Object({ status: Type.Literal("refused"), reason: Type.String() }),
]);
export const REMOVE_PROVIDER_COMMAND = "remove-provider-approval";

export default function approvalProbe(pi: ExtensionAPI): void {
	const config = parseOrThrow(
		ApprovalProbeConfigSchema,
		JSON.parse(readFileSync(new URL("provider-approval-probe.json", import.meta.url), "utf8")),
		"approval probe config",
	);
	// CLI extensions load before settings extensions. Probe the started runtime,
	// not factory order, so every explicitly configured adapter has activated.
	pi.on("session_start", () => {
		const change = config.sourceChange;
		if (change?.kind === "append") {
			appendFileSync(change.file, "\n// changed after activation, before first child\n");
		} else if (change?.kind === "symlink") {
			symlinkSync(change.target, change.file, lstatSync(change.target).isDirectory() ? "dir" : "file");
		} else if (change?.kind === "unexpected-file") {
			writeFileSync(change.file, "unexpected production file\n");
		}
		try {
			const extensions = resolveProviderExtensions({ model: config.model, events: pi.events });
			const result = { status: "approved", extensions } satisfies Static<typeof ApprovalProbeResultSchema>;
			appendFileSync(config.output, `${JSON.stringify(result)}\n`);
		} catch (error) {
			const result = { status: "refused", reason: String(error) } satisfies Static<typeof ApprovalProbeResultSchema>;
			appendFileSync(config.output, `${JSON.stringify(result)}\n`);
		}
	});
	pi.registerCommand(REMOVE_PROVIDER_COMMAND, {
		description: "Remove the adapter and reload the real extension runtime",
		handler: async (_args, ctx) => {
			writeFileSync(config.settings, JSON.stringify({ extensions: [] }));
			await ctx.reload();
		},
	});
}
