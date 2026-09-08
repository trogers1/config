import * as path from "node:path";
import { readActivity, type ActivityEvent } from "./activity.ts";
import type { ChildState } from "./types.ts";

type StatusRecord = {
	name: string;
	agent: string;
	state: ChildState;
	startedAt: string;
	sessionId: string;
	loadoutPath: string;
	attemptId?: string;
	task?: string;
	paneId?: string | null;
};

const STALE_ACTIVITY_MS = 30_000;
interface ChildStatus {
	name: string;
	agent: string;
	state: ChildState;
	elapsedMs: number;
	activity?: ActivityEvent;
}
function latestActivity(record: StatusRecord): ActivityEvent | undefined {
	return readActivity(path.join(path.dirname(record.loadoutPath), `activity-${record.sessionId}.json`)).at(-1);
}
export function classifyChild(record: StatusRecord, now = Date.now()): ChildStatus {
	const started = Date.parse(record.startedAt);
	const activity = latestActivity(record);
	const activityAt = activity ? Date.parse(activity.at) : Number.NaN;
	const stale =
		["starting", "active"].includes(record.state) &&
		Number.isFinite(activityAt) &&
		now - activityAt > STALE_ACTIVITY_MS;
	return {
		name: record.name,
		agent: record.agent,
		state: stale ? "stalled" : record.state,
		elapsedMs: Number.isFinite(started) ? Math.max(0, now - started) : 0,
		activity,
	};
}
export function formatChildStatus(record: StatusRecord, now = Date.now()): string {
	const s = classifyChild(record, now);
	const detail = s.activity ? ` ${s.activity.kind}${s.activity.detail ? `:${s.activity.detail}` : ""}` : "";
	return `${s.name}/${s.agent} ${s.state} ${Math.floor(s.elapsedMs / 1000)}s${detail}`;
}
export function formatStatus(records: StatusRecord[], now = Date.now()): string {
	return records
		.map((r) => classifyChild(r, now))
		.filter((s) => s.state !== "completed" && s.state !== "failed")
		.map((s) => {
			const detail = s.activity ? ` ${s.activity.kind}${s.activity.detail ? `:${s.activity.detail}` : ""}` : "";
			return `${s.name}/${s.agent} ${s.state} ${Math.floor(s.elapsedMs / 1000)}s${detail}`;
		})
		.join(" · ");
}
