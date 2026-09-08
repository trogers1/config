import { execFileSync } from "node:child_process";

const SUBAGENT_TMUX_LAYOUT = "even-horizontal";
const REBALANCE_DELAY_MS = 120;
let rebalanceTimer: ReturnType<typeof setTimeout> | null = null;

export function requireTmux(): void {
	try {
		execFileSync("tmux", ["-V"], { stdio: "ignore" });
	} catch {
		throw new Error("Interactive subagents require tmux. Start Pi inside tmux, for example: tmux new -A -s pi 'pi'");
	}
	if (!process.env.TMUX)
		throw new Error("Interactive subagents require Pi to run inside tmux. Start with: tmux new -A -s pi 'pi'");
}
export function tmux(args: string[]): string {
	return execFileSync("tmux", args, { encoding: "utf8" }).trim();
}
function validPaneId(paneId: string): boolean {
	return /^%[0-9]+$/.test(paneId);
}
export function paneExists(paneId: string): boolean {
	if (!validPaneId(paneId)) return false;
	try {
		return tmux(["display-message", "-p", "-t", paneId, "#{pane_id}"]) === paneId;
	} catch {
		return false;
	}
}
function rebalancePanes(hintPane?: string): void {
	const target = process.env.TMUX_PANE ?? hintPane;
	if (!target) return;
	if (rebalanceTimer) clearTimeout(rebalanceTimer);
	rebalanceTimer = setTimeout(() => {
		rebalanceTimer = null;
		try {
			tmux(["select-layout", "-t", target, SUBAGENT_TMUX_LAYOUT]);
		} catch {
			// Layout is cosmetic and the target window may already be gone.
		}
	}, REBALANCE_DELAY_MS);
}
export function createPane(command: string, cwd: string): string {
	const args = ["split-window", "-d", "-h"];
	if (process.env.TMUX_PANE) args.push("-t", process.env.TMUX_PANE);
	args.push("-P", "-F", "#{pane_id}", "-c", cwd, "sh", "-lc", command);
	const id = tmux(args);
	rebalancePanes(id);
	return id;
}
export function sendKeys(paneId: string, text: string): void {
	if (!validPaneId(paneId)) throw new Error(`Invalid tmux pane id: ${paneId}`);
	tmux(["send-keys", "-t", paneId, "-l", text]);
	tmux(["send-keys", "-t", paneId, "Enter"]);
}
export function closePane(paneId: string): void {
	if (!validPaneId(paneId)) return;
	try {
		tmux(["kill-pane", "-t", paneId]);
	} catch {
		/* already gone */
	} finally {
		rebalancePanes();
	}
}
export function hasTmux(): boolean {
	try {
		execFileSync("tmux", ["-V"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}
