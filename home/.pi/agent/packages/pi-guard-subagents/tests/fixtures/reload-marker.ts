import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function reloadMarker(pi: ExtensionAPI) {
	const file = process.env.PI_GUARD_TEST_RELOAD_MARKER;
	if (!file) throw new Error("Reload marker fixture requires PI_GUARD_TEST_RELOAD_MARKER");
	pi.on("session_start", () => appendFileSync(file, "start\n"));
	pi.on("session_shutdown", () => appendFileSync(file, "shutdown\n"));
}
