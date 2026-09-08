import * as fs from "node:fs";
import * as path from "node:path";
import { atomicJsonWrite, ActivitySchema, parseOrThrow, type Activity, type ActivityKind } from "./types.ts";

export type ActivityEvent = Activity[number];

/** Atomic, bounded activity protocol shared by the child and parent watcher. */
export function recordActivity(file: string, kind: ActivityKind, detail?: string): ActivityEvent {
	const event: ActivityEvent = { version: 1, at: new Date().toISOString(), kind, ...(detail ? { detail } : {}) };
	fs.mkdirSync(path.dirname(file), { recursive: true });
	let events: ActivityEvent[] = [];
	if (fs.existsSync(file))
		events = parseOrThrow(ActivitySchema, JSON.parse(fs.readFileSync(file, "utf8")), "activity sidecar");
	events = [...events.slice(-99), event];
	atomicJsonWrite(file, events);
	return event;
}
export function readActivity(file: string): ActivityEvent[] {
	try {
		return parseOrThrow(ActivitySchema, JSON.parse(fs.readFileSync(file, "utf8")), "activity sidecar");
	} catch (error) {
		if (!fs.existsSync(file)) return [];
		throw error;
	}
}
