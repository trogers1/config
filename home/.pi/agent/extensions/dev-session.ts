/** Record only the configured dev agent pane, never extra panes or subagents. */
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

function record({ ctx }: { ctx: ExtensionContext }): void {
	if (ctx.mode !== "tui" || !process.env.TMUX || !process.env.TMUX_PANE || (process.env.PI_SUBAGENT_DEPTH ?? "0") !== "0") return;
	const metadata = {
		agent: "pi",
		session_id: ctx.sessionManager.getSessionId(),
		transcript_path: ctx.sessionManager.getSessionFile() ?? null,
	};
	execFileSync(join(homedir(), "bin", "dev"), ["_record-agent", "pi"], {
		input: JSON.stringify(metadata),
		encoding: "utf8",
		stdio: ["pipe", "pipe", "pipe"],
	});
}

// Pi invokes extension factories/handlers positionally by API contract.
export default function (pi: ExtensionAPI): void {
	// session_start also fires after /new, /resume, /fork, /clone and /reload,
	// with the new context. Shutdown deliberately does NOT clear durable intent.
	pi.on("session_start", (_event, ctx) => record({ ctx }));
}
