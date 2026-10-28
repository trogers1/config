import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { readSessionSnapshot, SESSION_SNAPSHOT_ERRORS } from "./support/session-snapshot.ts";

function sessionFixture({ work }: { work: string }) {
	const session = SessionManager.create(work, join(work, "sessions"));
	session.appendMessage({ role: "user", content: "owned snapshot fixture", timestamp: Date.now() });
	const header = session.getHeader();
	if (!header) throw new Error(SESSION_SNAPSHOT_ERRORS.header);
	const file = join(work, "producer.jsonl");
	const text = [header, ...session.getEntries()].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
	writeFileSync(file, text);
	return { file, text, header, entries: session.getEntries() };
}

describe("read-only session observation", () => {
	it("defers only an unfinished final append and never repairs the producer", () => {
		const work = mkdtempSync(join(tmpdir(), "pi-session-observation-"));
		try {
			const fixture = sessionFixture({ work });
			appendFileSync(fixture.file, '{"type":"message","message":');
			const original = readFileSync(fixture.file);
			expect(readSessionSnapshot({ file: fixture.file, running: true }).entries).toEqual(fixture.entries);
			expect(readFileSync(fixture.file)).toEqual(original);
			expect(() => readSessionSnapshot({ file: fixture.file })).toThrow(SESSION_SNAPSHOT_ERRORS.json);
			expect(readFileSync(fixture.file)).toEqual(original);
			writeFileSync(fixture.file, fixture.text.trimEnd());
			const completeWithoutNewline = readFileSync(fixture.file);
			expect(readSessionSnapshot({ file: fixture.file }).entries).toEqual(fixture.entries);
			expect(readFileSync(fixture.file)).toEqual(completeWithoutNewline);
		} finally {
			rmSync(work, { recursive: true });
		}
	});

	it("rejects malformed complete records even when valid evidence follows them", () => {
		const work = mkdtempSync(join(tmpdir(), "pi-session-observation-"));
		try {
			const fixture = sessionFixture({ work });
			writeFileSync(fixture.file, fixture.text + "{broken}\n" + JSON.stringify(fixture.entries[0]) + "\n");
			const original = readFileSync(fixture.file);
			for (const running of [true, false]) {
				expect(() => readSessionSnapshot({ file: fixture.file, running })).toThrow(SESSION_SNAPSHOT_ERRORS.json);
				expect(readFileSync(fixture.file)).toEqual(original);
			}
		} finally {
			rmSync(work, { recursive: true });
		}
	});

	it("marks an unfinished initial header pending but rejects it as final evidence", () => {
		const work = mkdtempSync(join(tmpdir(), "pi-session-observation-"));
		try {
			const file = join(work, "producer.jsonl");
			const partial = '{"type":"session",';
			writeFileSync(file, partial);
			expect(readSessionSnapshot({ file, running: true })).toMatchObject({ pending: true, header: null });
			expect(() => readSessionSnapshot({ file })).toThrow(SESSION_SNAPSHOT_ERRORS.json);
			expect(readFileSync(file, "utf8")).toBe(partial);
		} finally {
			rmSync(work, { recursive: true });
		}
	});
});
