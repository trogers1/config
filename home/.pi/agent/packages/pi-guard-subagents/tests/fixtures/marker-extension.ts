import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function markerExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "integration_marker",
		label: "Integration marker",
		description: "Deterministic backing-extension marker for real child-process tests.",
		parameters: Type.Object({ value: Type.String() }),
		async execute(_id, parameters) {
			return { content: [{ type: "text", text: `marker:${parameters.value}` }], details: {} };
		},
	});
}
