import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { checkLatestClaudeSession } from "../extensions/reconstruction/index.ts";
import { NativeRecordSchema, WrittenRecordSchema } from "../extensions/reconstruction/schema.ts";
import { parseOrThrow } from "../extensions/validation.ts";
import { Value } from "typebox/value";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function fixture() {
  const value: unknown = JSON.parse(
    await readFile(new URL("./fixtures/native-cli-2.1.303.json", import.meta.url), "utf8"),
  );
  if (!Array.isArray(value)) throw new Error("Expected native fixture array");
  return value.map((record: unknown) =>
    parseOrThrow({
      schema: NativeRecordSchema,
      value: record,
      source: "sanitized CLI 2.1.303 fixture",
    }),
  );
}
async function check({ records }: { records: unknown[] }) {
  const claudeConfigDir = await mkdtemp(join(tmpdir(), "pi-claude-native-"));
  roots.push(claudeConfigDir);
  const project = join(claudeConfigDir, "projects", "sanitized");
  await mkdir(project, { recursive: true });
  await writeFile(
    join(project, "11111111-1111-4111-8111-111111111111.jsonl"),
    records.map((record) => JSON.stringify(record)).join("\n") + "\n",
  );
  return checkLatestClaudeSession({ claudeConfigDir });
}
it("checks sanitized CLI 2.1.303 metadata and native conversation through the public checker", async () => {
  expect((await check({ records: await fixture() })).status).toBe("matching");
});
function nativeToolFixture({ records }: { records: Awaited<ReturnType<typeof fixture>> }) {
  for (const record of records) {
    if (record.type !== "assistant") continue;
    for (const block of record.message.content) {
      if (block.type === "tool_use" && block.caller) return { record, block };
    }
  }
  throw new Error("Sanitized native fixture must contain a tool block with caller provenance");
}
it("keeps native caller provenance out of the otherwise-valid strict owned format", async () => {
  const { record, block } = nativeToolFixture({ records: await fixture() });
  const { caller, ...ownedBlock } = block;
  const owned = parseOrThrow({
    schema: WrittenRecordSchema,
    value: {
      type: record.type,
      uuid: record.uuid,
      parentUuid: record.parentUuid,
      sessionId: record.sessionId,
      timestamp: record.timestamp,
      message: {
        id: record.message.id,
        type: record.message.type,
        role: record.message.role,
        model: record.message.model,
        stop_reason: record.message.stop_reason,
        stop_sequence: record.message.stop_sequence,
        content: [ownedBlock],
      },
    },
    source: "minimal owned assistant fixture without native caller",
  });
  expect(Value.Check(WrittenRecordSchema, owned)).toBe(true);
  expect(
    Value.Check(WrittenRecordSchema, {
      ...owned,
      message: { ...owned.message, content: [{ ...ownedBlock, caller }] },
    }),
  ).toBe(false);
});
it.each([
  { type: "PRIVATE_CALLER_DO_NOT_LOG" },
  { type: "direct", secret: "PRIVATE_CALLER_DO_NOT_LOG" },
])("warns content-free for malformed native caller %j", async (caller) => {
  const records = await fixture();
  const { record, block } = nativeToolFixture({ records });
  const mutated = {
    ...record,
    message: {
      ...record.message,
      content: record.message.content.map((entry) =>
        entry === block ? { ...entry, caller } : entry,
      ),
    },
  };
  const result = await check({
    records: records.map((entry) => (entry === record ? mutated : entry)),
  });
  expect(result.status).toBe("warning");
  expect(JSON.stringify(result)).toContain("record assistant: schema mismatch");
  expect(JSON.stringify(result)).not.toContain("PRIVATE_CALLER_DO_NOT_LOG");
  expect(JSON.stringify(result).length).toBeLessThan(350);
});
it("warns for malformed known metadata, conversation content, and unknown drift without leaking values", async () => {
  const records = await fixture();
  const marker = "PRIVATE_CONTENT_DO_NOT_LOG";
  const malformed: unknown[] = records
    .filter((record) =>
      [
        "atis-latch",
        "api-request-shape",
        "api-request-blob",
        "api-request",
        "ai-title",
        "cost-state",
        "assistant",
        "user",
      ].includes(record.type),
    )
    .map((record) => {
      switch (record.type) {
        case "atis-latch":
          return { ...record, atis: { secret: marker } };
        case "api-request-shape":
          return { ...record, shape: { system: marker, tools: [] } };
        case "api-request-blob":
          return {
            ...record,
            message: { role: "user", content: [{ type: "text", text: 42, secret: marker }] },
          };
        case "api-request":
          return { ...record, keep: marker };
        case "ai-title":
          return { ...record, aiTitle: [marker] };
        case "cost-state":
          return { ...record, modelUsage: { secret: { costUSD: marker } } };
        default:
          return {
            ...record,
            message: { role: record.type, content: [{ type: "text", text: 42, secret: marker }] },
          };
      }
    });
  malformed.push({ type: "new-native-metadata", secret: marker });
  malformed.push({ type: marker, secret: marker });
  for (const bad of malformed) {
    const result = await check({ records: [...records, bad] });
    expect(result.status).toBe("warning");
    expect(JSON.stringify(result)).not.toContain(marker);
    expect(JSON.stringify(result).length).toBeLessThan(350);
  }
});
