import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { ImageContent, Message, Usage } from "@earendil-works/pi-ai";
import { CLAUDE_BRIDGE_PROVIDER } from "../../pi-guard-subagents/extensions/interactive/provider-extensions.ts";
import {
  checkLatestClaudeSession,
  reconstructSession,
  projectRecoveryHistory,
  type ConversationMessage,
} from "../extensions/reconstruction/index.ts";
import {
  NativeRecordSchema,
  PiConversationSchema,
  RecoveryDiagnosticSchema,
  WrittenRecordSchema,
} from "../extensions/reconstruction/schema.ts";
import { parseOrThrow } from "../extensions/validation.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
const model = "claude-sonnet-4-6";
const timestamp = Date.parse("2026-05-01T12:00:00.000Z");
const usage = {
  input: 12,
  output: 8,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 20,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} satisfies Usage;
const image = { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" } satisfies ImageContent;
const user = {
  role: "user",
  content: "Inspect this sanitized example.",
  timestamp,
} satisfies ConversationMessage;
const assistant = {
  role: "assistant",
  api: "claude-code",
  provider: CLAUDE_BRIDGE_PROVIDER,
  model,
  content: [{ type: "text", text: "A complete sanitized answer." }],
  usage,
  stopReason: "stop",
  timestamp: timestamp + 1,
} satisfies Extract<Message, { role: "assistant" }>;

async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-claude-reconstruction-")));
  roots.push(root);
  const cwd = join(root, "project");
  await mkdir(cwd, { mode: 0o700 });
  return { root, cwd, claudeConfigDir: join(root, "claude-config"), model };
}
async function readRecords({ filePath }: { filePath: string }) {
  return (await readFile(filePath, "utf8"))
    .trimEnd()
    .split("\n")
    .map((line, index) => {
      const value: unknown = JSON.parse(line);
      return parseOrThrow({
        schema: WrittenRecordSchema,
        value,
        source: `test written line ${index + 1}`,
      });
    });
}
function validateMessages({ messages }: { messages: readonly ConversationMessage[] }) {
  const validated: readonly ConversationMessage[] = parseOrThrow({
    schema: PiConversationSchema,
    value: messages,
    source: "sanitized Pi fixture",
  });
  return validated;
}
async function nativeFixture({
  claudeConfigDir,
  marker = "PRIVATE_PROMPT_DO_NOT_LOG",
  mtime = timestamp,
}: {
  claudeConfigDir: string;
  marker?: string;
  mtime?: number;
}) {
  const sessionId = randomUUID();
  const firstUuid = randomUUID();
  const attachmentUuid = randomUUID();
  const records = [
    {
      type: "user",
      uuid: firstUuid,
      parentUuid: null,
      sessionId,
      timestamp: new Date(timestamp).toISOString(),
      cwd: "/sanitized/project",
      isSidechain: false,
      userType: "external",
      version: "2.1.83",
      gitBranch: "main",
      slug: "sanitized-session",
      message: { role: "user", content: marker },
    },
    {
      type: "attachment",
      uuid: attachmentUuid,
      parentUuid: firstUuid,
      sessionId,
      timestamp: new Date(timestamp + 1).toISOString(),
      cwd: "/sanitized/project",
      isSidechain: false,
      attachment: {
        type: "file",
        filename: "/sanitized/example.ts",
        content: {
          type: "text",
          file: { filePath: "/sanitized/example.ts", content: "export const example = 1;" },
        },
      },
    },
    {
      type: "assistant",
      uuid: randomUUID(),
      parentUuid: attachmentUuid,
      sessionId,
      timestamp: new Date(timestamp + 2).toISOString(),
      cwd: "/sanitized/project",
      isSidechain: false,
      requestId: "req_sanitized",
      version: "2.1.83",
      message: {
        id: "msg_sanitized",
        type: "message",
        role: "assistant",
        model,
        content: [{ type: "text", text: "Sanitized result." }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: {
          input_tokens: 12,
          output_tokens: 8,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          service_tier: "standard",
        },
      },
    },
    {
      type: "queue-operation",
      operation: "dequeue",
      sessionId,
      timestamp: new Date(timestamp + 3).toISOString(),
    },
  ];
  for (const record of records)
    parseOrThrow({ schema: NativeRecordSchema, value: record, source: "sanitized native fixture" });
  const directory = join(claudeConfigDir, "projects", "-sanitized-project");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const filePath = join(directory, `${sessionId}.jsonl`);
  await writeFile(filePath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, {
    mode: 0o600,
  });
  await utimes(filePath, new Date(mtime), new Date(mtime));
  return { filePath, records };
}

describe("owned Claude session reconstruction", () => {
  it("publishes fresh private complete files with linked records and never alters existing sessions", async () => {
    const options = await setup();
    const existing = await nativeFixture(options);
    const original = await readFile(existing.filePath, "utf8");
    const messages = validateMessages({ messages: [user, assistant] });
    const first = await reconstructSession({ ...options, messages });
    const second = await reconstructSession({ ...options, messages });
    expect(first.sessionId).not.toBe(second.sessionId);
    expect(first.filePath).toContain(first.sessionId);
    const records = await readRecords(first);
    expect(records).toHaveLength(messages.length);
    expect(records[0]?.parentUuid).toBeNull();
    expect(records[1]?.parentUuid).toBe(records[0]?.uuid);
    expect(records.every((record) => record.sessionId === first.sessionId)).toBe(true);
    expect((await stat(first.filePath)).mode & 0o777).toBe(0o600);
    expect((await stat(dirname(first.filePath))).mode & 0o777).toBe(0o700);
    expect((await readdir(dirname(first.filePath))).some((name) => name.endsWith(".tmp"))).toBe(
      false,
    );
    expect(await readFile(existing.filePath, "utf8")).toBe(original);
    await utimes(second.filePath, new Date(timestamp + 30_000), new Date(timestamp + 30_000));
    await utimes(first.filePath, new Date(timestamp + 20_000), new Date(timestamp + 20_000));
    expect(first.filePath).toBe(
      join(options.claudeConfigDir, "pi-claude", "reconstruction", `${first.sessionId}.jsonl`),
    );
    // Newer owned drafts must not hide the actual runtime session from drift checks.
    expect(await checkLatestClaudeSession(options)).toEqual({
      status: "matching",
      filePath: existing.filePath,
    });
  });

  it("preserves signed/redacted thinking, images, exact parallel tool pairing and MCP names", async () => {
    const options = await setup();
    const messages = validateMessages({
      messages: [
        { ...user, content: [{ type: "text", text: "Inspect image." }, image] },
        {
          ...assistant,
          stopReason: "toolUse",
          content: [
            {
              type: "thinking",
              thinking: "Reasoning preserved verbatim.",
              thinkingSignature: "sanitized-native-signature",
            },
            {
              type: "thinking",
              thinking: "",
              redacted: true,
              thinkingSignature: "sanitized-encrypted-data",
            },
            { type: "toolCall", id: "toolu_read_1", name: "read", arguments: { path: "one.ts" } },
            { type: "toolCall", id: "toolu_read_2", name: "read", arguments: { path: "two.png" } },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "toolu_read_2",
          toolName: "read",
          content: [image],
          isError: false,
          timestamp: timestamp + 2,
        },
        {
          role: "toolResult",
          toolCallId: "toolu_read_1",
          toolName: "read",
          content: [{ type: "text", text: "Permission denied." }],
          isError: true,
          timestamp: timestamp + 3,
        },
        assistant,
      ],
    });
    const result = await reconstructSession({
      ...options,
      messages,
      toolNameMap: new Map([["read", "mcp__pi__read"]]),
    });
    const records = await readRecords(result);
    const thinking = records[1];
    if (thinking?.type !== "assistant") throw new Error("fixture did not produce an assistant");
    expect(thinking.message.content).toEqual([
      {
        type: "thinking",
        thinking: "Reasoning preserved verbatim.",
        signature: "sanitized-native-signature",
      },
      { type: "redacted_thinking", data: "sanitized-encrypted-data" },
      { type: "tool_use", id: "toolu_read_1", name: "mcp__pi__read", input: { path: "one.ts" } },
      { type: "tool_use", id: "toolu_read_2", name: "mcp__pi__read", input: { path: "two.png" } },
    ]);
    expect(records[2]?.message.content).toEqual([
      {
        type: "tool_result",
        tool_use_id: "toolu_read_2",
        is_error: false,
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: image.mimeType, data: image.data },
          },
        ],
      },
    ]);
    expect(records[3]?.message.content).toEqual([
      {
        type: "tool_result",
        tool_use_id: "toolu_read_1",
        is_error: true,
        content: [{ type: "text", text: "Permission denied." }],
      },
    ]);
    for (const [index, record] of records.entries())
      expect(record.parentUuid).toBe(index ? records[index - 1]?.uuid : null);
    expect((await checkLatestClaudeSession(options)).status).toBe("unavailable");
  });

  it("preserves validated actual response models, including signed history with a resolved alias", async () => {
    const options = await setup();
    const messages = validateMessages({
      messages: [
        user,
        {
          ...assistant,
          model: "sonnet",
          responseModel: model,
          content: [
            {
              type: "thinking",
              thinking: "Resolved-model native reasoning.",
              thinkingSignature: "sanitized-native-signature",
            },
            { type: "text", text: "Resolved-model answer." },
          ],
        },
        { ...assistant, model: "sonnet", responseModel: "claude-opus-4-6" },
        assistant,
      ],
    });
    const result = await reconstructSession({ ...options, messages });
    const records = await readRecords(result);
    const assistantModels = records.flatMap((record) =>
      record.type === "assistant" ? [record.message.model] : [],
    );
    expect(assistantModels).toEqual([model, "claude-opus-4-6", assistant.model]);
    const mismatchedThinking = {
      ...assistant,
      responseModel: "claude-opus-4-6",
      content: [
        {
          type: "thinking",
          thinking: "Different actual model.",
          thinkingSignature: "sanitized-native-signature",
        },
      ],
    } satisfies ConversationMessage;
    await expect(
      reconstructSession({ ...options, messages: [user, mismatchedThinking] }),
    ).rejects.toThrow("unsupported thinking provenance");
  });

  it("rejects unpaired, interrupted, unsupported, foreign-thinking and lossy histories without publishing files", async () => {
    const options = await setup();
    const call = {
      ...assistant,
      stopReason: "toolUse",
      content: [
        { type: "toolCall", id: "toolu_test", name: "read", arguments: { path: "example.ts" } },
      ],
    } satisfies ConversationMessage;
    const result = {
      role: "toolResult",
      toolCallId: "toolu_test",
      toolName: "read",
      content: [{ type: "text", text: "example" }],
      isError: false,
      timestamp,
    } satisfies ConversationMessage;
    const cases: (readonly ConversationMessage[])[] = [
      [],
      [user, call],
      [user, result],
      [user, call, user, result],
      [user, call, result, result],
      [user, call, { ...result, toolName: "write" }],
      [
        user,
        {
          ...call,
          content: [
            {
              type: "toolCall",
              id: "toolu_test",
              name: "read",
              arguments: { nonfinite: Number.NaN },
            },
          ],
        },
        result,
      ],
      [
        user,
        {
          ...call,
          content: [
            {
              type: "toolCall",
              id: "toolu_test",
              name: "read",
              arguments: {},
              thoughtSignature: "unsupported",
            },
          ],
        },
        result,
      ],
      [user, { ...assistant, content: [] }],
      [user, { ...assistant, responseModel: "" }],
      [user, { ...assistant, stopReason: "deferred" }],
      [user, { ...assistant, content: [{ type: "thinking", thinking: "unsigned" }] }],
      [
        user,
        {
          ...assistant,
          provider: "other",
          content: [{ type: "thinking", thinking: "foreign", thinkingSignature: "opaque" }],
        },
      ],
      [
        user,
        {
          ...assistant,
          model: "claude-opus-4-6",
          content: [{ type: "thinking", thinking: "model mismatch", thinkingSignature: "opaque" }],
        },
      ],
      [
        user,
        {
          ...assistant,
          content: [{ type: "text", text: "signed", textSignature: "foreign-signature" }],
        },
      ],
      [{ ...user, content: [{ ...image, data: "not base64" }] }],
      [{ ...user, content: [{ ...image, mimeType: "application/pdf" }] }],
    ];
    for (const messages of cases)
      await expect(reconstructSession({ ...options, messages })).rejects.toThrow("pi-claude:");
    const system = {
      role: "system",
      content: "System state belongs to the provider.",
      timestamp,
    } satisfies Message;
    // Deliberately cross the runtime boundary with a host-valid, conversion-invalid role.
    await expect(
      Reflect.apply(reconstructSession, undefined, [
        { ...options, messages: [system, user, assistant] },
      ]),
    ).rejects.toThrow("system messages must be handled by provider");
    await expect(stat(options.claudeConfigDir)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      reconstructSession({ ...options, messages: [user, call, result], toolNameMap: new Map() }),
    ).rejects.toThrow("missing SDK tool name mapping");
  });

  it("recovers empty error/cancelled attempts explicitly and keeps the next successful turn usable", async () => {
    const options = await setup();
    const failed = {
      ...assistant,
      stopReason: "error",
      content: [],
      errorMessage: "PRIVATE_TRANSPORT_ERROR",
    } satisfies ConversationMessage;
    const cancelled = {
      ...assistant,
      stopReason: "aborted",
      content: [],
    } satisfies ConversationMessage;
    const messages = validateMessages({
      messages: [user, failed, cancelled, { ...user, content: "Try again." }, assistant],
    });
    await expect(reconstructSession({ ...options, messages })).rejects.toThrow(
      "requires explicit projectRecoveryHistory",
    );
    const recovered = projectRecoveryHistory({ messages });
    for (const diagnostic of recovered.diagnostics)
      parseOrThrow({
        schema: RecoveryDiagnosticSchema,
        value: diagnostic,
        source: "recovery test diagnostic",
      });
    expect(recovered.messages).toEqual([user, { ...user, content: "Try again." }, assistant]);
    expect(recovered.diagnostics).toEqual([
      {
        messageIndex: 1,
        stopReason: "error",
        action: "excluded-empty-attempt",
        excludedUnresolvedToolCalls: 0,
        retainedToolResults: 0,
      },
      {
        messageIndex: 2,
        stopReason: "aborted",
        action: "excluded-empty-attempt",
        excludedUnresolvedToolCalls: 0,
        retainedToolResults: 0,
      },
    ]);
    expect(JSON.stringify(recovered.diagnostics)).not.toContain("PRIVATE_");
    const result = await reconstructSession({ ...options, messages: recovered.messages });
    const records = await readRecords(result);
    expect(records.map((record) => record.message.content)).toEqual([
      user.content,
      "Try again.",
      assistant.content,
    ]);
  });

  it("preserves meaningful interrupted text and complete signed thinking without inventing a successful stop", async () => {
    const options = await setup();
    const partialError = {
      ...assistant,
      stopReason: "error",
      content: [{ type: "text", text: "Completed visible prefix before EOF." }],
    } satisfies ConversationMessage;
    const partialCancel = {
      ...assistant,
      stopReason: "aborted",
      content: [
        {
          type: "thinking",
          thinking: "Complete signed reasoning before cancellation.",
          thinkingSignature: "sanitized-native-signature",
        },
        { type: "text", text: "Completed visible prefix before cancellation." },
      ],
    } satisfies ConversationMessage;
    const messages = validateMessages({
      messages: [user, partialError, partialCancel, { ...user, content: "Continue." }, assistant],
    });
    const recovered = projectRecoveryHistory({ messages });
    expect(recovered.messages).toEqual(messages);
    expect(
      recovered.diagnostics.every(
        (diagnostic) => diagnostic.action === "preserved-interrupted-attempt",
      ),
    ).toBe(true);
    const records = await readRecords(
      await reconstructSession({ ...options, messages: recovered.messages }),
    );
    const errored = records[1];
    const cancelled = records[2];
    if (errored?.type !== "assistant" || cancelled?.type !== "assistant")
      throw new Error("missing interrupted assistant records");
    expect(errored.message.stop_reason).toBeNull();
    expect(errored.message.content).toEqual(partialError.content);
    expect(cancelled.message.stop_reason).toBeNull();
    expect(cancelled.message.content).toEqual([
      {
        type: "thinking",
        thinking: "Complete signed reasoning before cancellation.",
        signature: "sanitized-native-signature",
      },
      { type: "text", text: "Completed visible prefix before cancellation." },
    ]);
  });

  it("retains only recorded tool outcomes from an explicitly failed attempt and reports unresolved exclusions", async () => {
    const options = await setup();
    const interrupted = {
      ...assistant,
      stopReason: "aborted",
      content: [
        { type: "text", text: "I started inspecting the files." },
        {
          type: "toolCall",
          id: "toolu_completed",
          name: "read",
          arguments: { path: "completed.ts" },
        },
        { type: "toolCall", id: "toolu_unknown", name: "read", arguments: { path: "unknown.ts" } },
      ],
    } satisfies ConversationMessage;
    const completed = {
      role: "toolResult",
      toolCallId: "toolu_completed",
      toolName: "read",
      isError: false,
      content: [{ type: "text", text: "Actual completed file contents." }],
      timestamp,
    } satisfies ConversationMessage;
    const recovered = projectRecoveryHistory({
      messages: validateMessages({ messages: [user, interrupted, completed, user, assistant] }),
    });
    expect(recovered.diagnostics).toEqual([
      {
        messageIndex: 1,
        stopReason: "aborted",
        action: "preserved-interrupted-attempt",
        excludedUnresolvedToolCalls: 1,
        retainedToolResults: 1,
      },
    ]);
    const records = await readRecords(
      await reconstructSession({ ...options, messages: recovered.messages }),
    );
    expect(records).toHaveLength(5);
    expect(JSON.stringify(records)).not.toContain("toolu_unknown");
    expect(records[2]?.message.content).toEqual([
      {
        type: "tool_result",
        tool_use_id: "toolu_completed",
        is_error: false,
        content: completed.content,
      },
    ]);
    expect(recovered.messages[2]).toEqual(completed);
    const projectedResult = recovered.messages[2];
    if (projectedResult?.role !== "toolResult") throw new Error("missing projected tool result");
    projectedResult.content = [{ type: "text", text: "Outbound hook replacement." }];
    expect(completed.content).toEqual([{ type: "text", text: "Actual completed file contents." }]);
  });

  it("recovers cancellation after completed tool results but refuses unsafe ordinary gaps and malformed failed fragments", async () => {
    const options = await setup();
    const call = {
      ...assistant,
      stopReason: "toolUse",
      content: [
        {
          type: "toolCall",
          id: "toolu_cancelled",
          name: "read",
          arguments: { path: "example.ts" },
        },
      ],
    } satisfies ConversationMessage;
    const result = {
      role: "toolResult",
      toolCallId: "toolu_cancelled",
      toolName: "read",
      isError: true,
      content: [{ type: "text", text: "Actual tool cancellation result." }],
      timestamp,
    } satisfies ConversationMessage;
    const cancelled = {
      ...assistant,
      stopReason: "aborted",
      content: [],
    } satisfies ConversationMessage;
    const recovered = projectRecoveryHistory({
      messages: validateMessages({ messages: [user, call, result, cancelled, user, assistant] }),
    });
    expect(
      (await readRecords(await reconstructSession({ ...options, messages: recovered.messages })))
        .length,
    ).toBe(5);
    const interleavedTransportFailure = projectRecoveryHistory({
      messages: [user, call, cancelled, result, user, assistant],
    });
    expect(interleavedTransportFailure.messages).toEqual(recovered.messages);
    expect(
      (
        await readRecords(
          await reconstructSession({ ...options, messages: interleavedTransportFailure.messages }),
        )
      ).length,
    ).toBe(5);
    expect(() => projectRecoveryHistory({ messages: [user, call, cancelled, user] })).toThrow(
      "incomplete tool results",
    );
    const failedCall = { ...call, stopReason: "error" } satisfies ConversationMessage;
    expect(() =>
      projectRecoveryHistory({ messages: [user, failedCall, { ...result, toolName: "write" }] }),
    ).toThrow("wrong-name tool result");
    expect(() => projectRecoveryHistory({ messages: [user, failedCall, result, result] })).toThrow(
      "duplicate",
    );
    expect(() =>
      projectRecoveryHistory({
        messages: [
          user,
          {
            ...failedCall,
            content: [
              {
                type: "toolCall",
                id: "toolu_bad",
                name: "read",
                arguments: { invalid: Number.NaN },
              },
            ],
          },
        ],
      }),
    ).toThrow("schema mismatch");
    expect(() =>
      projectRecoveryHistory({
        messages: [
          user,
          { ...failedCall, content: [{ type: "toolCall", id: "", name: "read", arguments: {} }] },
        ],
      }),
    ).toThrow("schema mismatch");
    expect(() =>
      Reflect.apply(projectRecoveryHistory, undefined, [
        {
          messages: [
            user,
            { ...failedCall, content: [{ type: "toolCall", id: "toolu_partial", name: "read" }] },
          ],
        },
      ]),
    ).toThrow("schema mismatch");
    const unsupported = projectRecoveryHistory({
      messages: [
        user,
        {
          ...assistant,
          stopReason: "error",
          content: [{ type: "thinking", thinking: "Unsigned partial reasoning." }],
        },
      ],
    });
    await expect(
      reconstructSession({ ...options, messages: unsupported.messages }),
    ).rejects.toThrow("unsupported thinking");
  });

  it("canonicalizes cwd and supports long paths without guessing native project hashes; rejects wrong paths and symlink destinations", async () => {
    const options = await setup();
    const messages = validateMessages({ messages: [user, assistant] });
    const alias = join(options.root, "project-alias");
    await symlink(options.cwd, alias);
    const result = await reconstructSession({ ...options, cwd: alias, messages });
    const records = await readRecords(result);
    expect(records[0]?.cwd).toBe(await realpath(options.cwd));
    await expect(reconstructSession({ ...options, cwd: "relative", messages })).rejects.toThrow(
      "must be absolute",
    );
    await expect(
      reconstructSession({ ...options, cwd: join(options.root, "missing"), messages }),
    ).rejects.toThrow();
    const deep = join(options.cwd, "a".repeat(100), "b".repeat(100));
    await mkdir(deep, { recursive: true });
    const longPathSession = await reconstructSession({ ...options, cwd: deep, messages });
    expect((await readRecords(longPathSession))[0]?.cwd).toBe(await realpath(deep));
    expect(dirname(longPathSession.filePath)).toBe(dirname(result.filePath));
    const alternateRoot = join(options.root, "alternate-config");
    const target = join(options.root, "do-not-write");
    await mkdir(alternateRoot);
    await mkdir(target);
    await symlink(target, join(alternateRoot, "pi-claude"));
    await expect(
      reconstructSession({ ...options, claudeConfigDir: alternateRoot, messages }),
    ).rejects.toThrow("not a real directory");
    expect(await readdir(target)).toEqual([]);
  });
});

describe("startup Claude session schema diagnostic", () => {
  it("checks latest session by file metadata, never prompts, and leaves native attachments unchanged", async () => {
    const options = await setup();
    const older = await nativeFixture({ ...options, mtime: timestamp });
    const latest = await nativeFixture({ ...options, mtime: timestamp + 10_000 });
    const before = await readFile(latest.filePath, "utf8");
    const draft = await reconstructSession({
      ...options,
      messages: validateMessages({ messages: [user, assistant] }),
    });
    await utimes(draft.filePath, new Date(timestamp + 30_000), new Date(timestamp + 30_000));
    expect(await checkLatestClaudeSession(options)).toEqual({
      status: "matching",
      filePath: latest.filePath,
    });
    expect(await readFile(latest.filePath, "utf8")).toBe(before);
    // A valid fixture is mutated at the boundary to simulate future Claude drift.
    const changed = [
      ...latest.records,
      { type: "future-record", privatePrompt: "DO_NOT_LEAK_FUTURE_CONTENT" },
    ];
    await writeFile(
      latest.filePath,
      `${changed.map((record) => JSON.stringify(record)).join("\n")}\n`,
    );
    const drift = await checkLatestClaudeSession(options);
    expect(drift.status).toBe("warning");
    if (drift.status !== "warning") throw new Error("expected drift warning");
    expect(drift.warning).toContain("line 5, record future-record: schema mismatch");
    expect(drift.warning).not.toContain("DO_NOT_LEAK");
    expect(drift.warning).not.toContain("PRIVATE_PROMPT");
    expect(drift.warning).not.toContain(options.root);
    expect(await readFile(older.filePath, "utf8")).toContain("PRIVATE_PROMPT_DO_NOT_LOG");
  });

  it("returns unavailable rather than verified without a latest session and does not follow file symlinks", async () => {
    const options = await setup();
    expect((await checkLatestClaudeSession(options)).status).toBe("unavailable");
    const project = join(options.claudeConfigDir, "projects", "-sanitized-project");
    await mkdir(project, { recursive: true });
    const outside = join(options.root, "outside.jsonl");
    await writeFile(outside, "PRIVATE_OUTSIDE_DATA");
    await symlink(outside, join(project, `${randomUUID()}.jsonl`));
    expect((await checkLatestClaudeSession(options)).status).toBe("unavailable");
    expect(await readFile(outside, "utf8")).toBe("PRIVATE_OUTSIDE_DATA");
  });

  it("warns content-free on malformed JSON, oversized sessions and mismatched IDs", async () => {
    const options = await setup();
    const fixture = await nativeFixture(options);
    await writeFile(fixture.filePath, '{"type":"user","content":"PRIVATE_UNFINISHED_PROMPT');
    const malformed = await checkLatestClaudeSession(options);
    expect(malformed.status).toBe("warning");
    expect(JSON.stringify(malformed)).not.toContain("PRIVATE_");
    expect(JSON.stringify(malformed)).toContain("line 1");
    await writeFile(fixture.filePath, "PRIVATE_".repeat(1_100_000));
    expect(JSON.stringify(await checkLatestClaudeSession(options))).toContain(
      "bounded schema-check limit; not verified",
    );
    await writeFile(
      fixture.filePath,
      `${fixture.records.map((record) => JSON.stringify({ ...record, sessionId: randomUUID() })).join("\n")}\n`,
    );
    expect(JSON.stringify(await checkLatestClaudeSession(options))).toContain(
      "session ID mismatch",
    );
  });
});
