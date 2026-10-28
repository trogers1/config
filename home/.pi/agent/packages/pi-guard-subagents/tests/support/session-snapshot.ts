import { lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { parseOrThrow } from "../../extensions/interactive/types.ts";

export const SESSION_SNAPSHOT_ERRORS = Object.freeze({
	source: "Observation requires a regular, non-symlink session file",
	json: "Invalid JSON in owned session snapshot",
	encoding: "Invalid UTF-8 in owned session snapshot",
	header: "Missing owned session header",
	size: "Owned session exceeds observation size limit",
});
const MAX_SESSION_BYTES = 16 * 1024 * 1024;
type Entry = ReturnType<SessionManager["getEntries"]>[number];
const entryTypes = {
	message: "message",
	thinking_level_change: "thinking_level_change",
	model_change: "model_change",
	usage: "usage",
	compaction: "compaction",
	branch_summary: "branch_summary",
	custom: "custom",
	label: "label",
	session_info: "session_info",
	custom_message: "custom_message",
	context_edit: "context_edit",
} satisfies { [Kind in Entry["type"]]: Kind };
const EntryEnvelopeSchema = Type.Object({ type: Type.Enum(entryTypes) });
const HeaderSchema = Type.Object({
	type: Type.Literal("session"),
	id: Type.String({ minLength: 1 }),
	cwd: Type.String(),
	timestamp: Type.String(),
});

/** The host loader can repair its input. It must only ever see our disposable copy. */
export function readSessionSnapshot({ file, running = false }: { file: string; running?: boolean }): {
	pending: boolean;
	header: ReturnType<SessionManager["getHeader"]>;
	entries: ReturnType<SessionManager["getEntries"]>;
} {
	const stat = lstatSync(file);
	if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(SESSION_SNAPSHOT_ERRORS.source);
	if (stat.size > MAX_SESSION_BYTES) throw new Error(SESSION_SNAPSHOT_ERRORS.size);
	const original = readFileSync(file);
	if (original.length > MAX_SESSION_BYTES) throw new Error(SESSION_SNAPSHOT_ERRORS.size);
	// Slice bytes before decoding, so a partial UTF-8 character is deferred too.
	const captured = running ? original.subarray(0, original.lastIndexOf(10) + 1) : original;
	// A newly created producer may not have finished its header yet. This is an
	// explicit pending observation, never evidence of a completed interaction.
	if (running && captured.length === 0) return { pending: true, header: null, entries: [] satisfies Entry[] };
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(captured);
	} catch {
		throw new Error(SESSION_SNAPSHOT_ERRORS.encoding);
	}
	const lines = text.split("\n").filter((line) => line.trim().length > 0);
	if (!lines.length) throw new Error(SESSION_SNAPSHOT_ERRORS.header);
	for (const [index, line] of lines.entries()) {
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch {
			throw new Error(SESSION_SNAPSHOT_ERRORS.json);
		}
		if (index === 0) parseOrThrow(HeaderSchema, value, "owned session header");
		else parseOrThrow(EntryEnvelopeSchema, value, "owned session entry envelope");
	}
	const directory = mkdtempSync(join(dirname(file), ".observation-"));
	try {
		const snapshotFile = join(directory, "snapshot.jsonl");
		writeFileSync(snapshotFile, lines.join("\n") + "\n");
		const session = SessionManager.open(snapshotFile, directory);
		const header = session.getHeader();
		if (!header) throw new Error(SESSION_SNAPSHOT_ERRORS.header);
		return { pending: false, header, entries: session.getEntries() };
	} finally {
		rmSync(directory, { recursive: true });
	}
}
