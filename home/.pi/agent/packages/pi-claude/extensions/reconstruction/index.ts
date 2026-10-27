import type { Message } from "@earendil-works/pi-ai";
import { CLAUDE_BRIDGE_PROVIDER } from "../../../pi-guard-subagents/extensions/interactive/provider-extensions.ts";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, opendir, realpath, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { Value } from "typebox/value";
import { parseOrThrow, validateJsonObject } from "../validation.ts";
export { projectRecoveryHistory } from "./recovery.ts";
import { assertToolPairing } from "./pairing.ts";
export type { ConversationMessage } from "./schema.ts";
import {
  AssistantContentSchema,
  ImageBlockSchema,
  NativeRecordSchema,
  PiConversationSchema,
  RecordTypeSchema,
  UserContentSchema,
  UuidSchema,
  WrittenRecordSchema,
  type AssistantContent,
  type UserContent,
  type WrittenRecord,
  type ConversationMessage,
} from "./schema.ts";
export type DriftCheckResult =
  | { status: "matching"; filePath: string }
  | { status: "warning"; warning: string }
  | { status: "unavailable"; reason: string };

function contentBlocks({
  content,
}: {
  content: Exclude<Extract<Message, { role: "user" }>["content"], string>;
}) {
  return content.map((block) => {
    if (block.type === "text") {
      if (block.textSignature !== undefined)
        throw new Error("pi-claude: text signatures cannot be reconstructed as Claude text");
      return { type: block.type, text: block.text };
    }
    const image = parseOrThrow({
      schema: ImageBlockSchema,
      value: {
        type: "image",
        source: { type: "base64", media_type: block.mimeType, data: block.data },
      },
      source: "Pi image",
    });
    if (Buffer.from(image.source.data, "base64").toString("base64") !== image.source.data) {
      throw new Error("pi-claude: image is not canonical base64");
    }
    return image;
  });
}

function convert({
  messages,
  model,
  cwd,
  sessionId,
  toolNameMap,
}: {
  messages: readonly ConversationMessage[];
  model: string;
  cwd: string;
  sessionId: string;
  toolNameMap?: ReadonlyMap<string, string>;
}): WrittenRecord[] {
  parseOrThrow({
    schema: PiConversationSchema,
    value: messages,
    source: "Pi conversation (system messages must be handled by provider)",
  });
  if (!messages.length) throw new Error("pi-claude: cannot reconstruct an empty conversation");
  assertToolPairing({ messages });
  const records: WrittenRecord[] = [];
  let parentUuid: string | null = null;
  function append({
    message,
    timestamp,
  }: {
    message:
      | { role: "user"; content: UserContent }
      | {
          role: "assistant";
          content: AssistantContent;
          source: Extract<Message, { role: "assistant" }>;
        };
    timestamp: number;
  }) {
    if (!Number.isFinite(timestamp) || Math.abs(timestamp) > 8.64e15)
      throw new Error("pi-claude: invalid message timestamp");
    const uuid = randomUUID();
    const base = {
      uuid,
      parentUuid,
      sessionId,
      cwd,
      isSidechain: false,
      timestamp: new Date(timestamp).toISOString(),
    };
    const value =
      message.role === "user"
        ? { ...base, type: "user", message: { role: "user", content: message.content } }
        : {
            ...base,
            type: "assistant",
            message: {
              id: `msg_${randomUUID().replaceAll("-", "")}`,
              type: "message",
              role: "assistant",
              model: message.source.responseModel ?? message.source.model,
              content: message.content,
              stop_reason:
                message.source.stopReason === "error" || message.source.stopReason === "aborted"
                  ? null
                  : message.source.stopReason === "toolUse"
                    ? "tool_use"
                    : message.source.stopReason === "length"
                      ? "max_tokens"
                      : "end_turn",
              stop_sequence: null,
            },
          };
    records.push(
      parseOrThrow({
        schema: WrittenRecordSchema,
        value,
        source: `generated record ${records.length + 1}`,
      }),
    );
    parentUuid = uuid;
  }
  for (const message of messages) {
    if (message.role === "user") {
      const content = parseOrThrow({
        schema: UserContentSchema,
        value:
          typeof message.content === "string"
            ? message.content
            : contentBlocks({ content: message.content }),
        source: "Pi user content",
      });
      append({ message: { role: "user", content }, timestamp: message.timestamp });
    } else if (message.role === "assistant") {
      if (
        !message.content.length &&
        (message.stopReason === "error" || message.stopReason === "aborted")
      )
        throw new Error("pi-claude: empty failed attempt requires explicit projectRecoveryHistory");
      const blocks = message.content.map((block) => {
        if (block.type === "text") {
          if (block.textSignature !== undefined)
            throw new Error("pi-claude: text signatures cannot be reconstructed as Claude text");
          return { type: block.type, text: block.text };
        }
        if (block.type === "thinking") {
          // Only the provider's own Claude-native signatures are eligible for replay.
          if (
            message.provider !== CLAUDE_BRIDGE_PROVIDER ||
            !model.startsWith("claude-") ||
            (message.responseModel ?? message.model) !== model ||
            !block.thinkingSignature
          ) {
            throw new Error(
              "pi-claude: unsupported thinking provenance, model, or missing signature",
            );
          }
          if (block.redacted) {
            if (block.thinking !== "")
              throw new Error("pi-claude: redacted thinking contains unexpected visible text");
            return { type: "redacted_thinking", data: block.thinkingSignature };
          }
          return { type: "thinking", thinking: block.thinking, signature: block.thinkingSignature };
        }
        if (block.thoughtSignature !== undefined || block.namespace !== undefined)
          throw new Error("pi-claude: unsupported signed or namespaced Pi tool call");
        validateJsonObject({ value: block.arguments, source: "reconstruction tool arguments" });
        const name = toolNameMap ? toolNameMap.get(block.name) : block.name;
        if (!name) throw new Error("pi-claude: missing SDK tool name mapping for historical tool");
        return { type: "tool_use", id: block.id, name, input: block.arguments };
      });
      const content = parseOrThrow({
        schema: AssistantContentSchema,
        value: blocks,
        source: "Pi assistant content",
      });
      append({
        message: { role: "assistant", content, source: message },
        timestamp: message.timestamp,
      });
    } else {
      const content = parseOrThrow({
        schema: UserContentSchema,
        value: [
          {
            type: "tool_result",
            tool_use_id: message.toolCallId,
            content: contentBlocks({ content: message.content }),
            is_error: message.isError,
          },
        ],
        source: "Pi tool result",
      });
      append({ message: { role: "user", content }, timestamp: message.timestamp });
    }
  }
  return records;
}

async function privateDirectory({ path }: { path: string }) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error("pi-claude: session destination is not a real directory");
}

/** Creates a fresh owned file only. Never opens, repairs, or overwrites a user session.
 * Provider handles system/tool state separately and supplies the exact history prefix.
 */
export async function reconstructSession({
  messages,
  cwd,
  model,
  claudeConfigDir,
  toolNameMap,
}: {
  messages: readonly ConversationMessage[];
  cwd: string;
  model: string;
  claudeConfigDir: string;
  toolNameMap?: ReadonlyMap<string, string>;
}): Promise<{ sessionId: string; filePath: string }> {
  if (!isAbsolute(cwd) || !isAbsolute(claudeConfigDir))
    throw new Error("pi-claude: cwd and Claude config directory must be absolute");
  if (!model) throw new Error("pi-claude: reconstruction requires a target model");
  const canonicalCwd = (await realpath(cwd)).normalize("NFC");
  if (!(await lstat(canonicalCwd)).isDirectory())
    throw new Error("pi-claude: reconstruction cwd is not a directory");
  const sessionId = randomUUID();
  const records = convert({ messages, model, cwd: canonicalCwd, sessionId, toolNameMap });
  // Round-trip every emitted record so non-JSON tool arguments cannot mutate silently.
  const lines = records.map((record, index) => {
    const line = JSON.stringify(record);
    const decoded: unknown = JSON.parse(line);
    parseOrThrow({
      schema: WrittenRecordSchema,
      value: decoded,
      source: `serialized record ${index + 1}`,
    });
    return line;
  });
  await privateDirectory({ path: claudeConfigDir });
  const root = await realpath(claudeConfigDir);
  // Full-path SDK resume does not require Claude's runtime-specific project hash.
  // Keep drafts out of projects/ so startup checks observe runtime-written files only.
  const owned = join(root, "pi-claude");
  await privateDirectory({ path: owned });
  const drafts = join(owned, "reconstruction");
  await privateDirectory({ path: drafts });
  const filePath = join(drafts, `${sessionId}.jsonl`);
  const temporaryPath = join(drafts, `.pi-claude-${randomUUID()}.tmp`);
  const file = await open(
    temporaryPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.writeFile(`${lines.join("\n")}\n`, "utf8");
    await file.sync();
    await file.close();
    // A hard link publishes the complete inode atomically and refuses replacement.
    await link(temporaryPath, filePath);
  } finally {
    await file.close();
    await unlink(temporaryPath);
  }
  return { sessionId, filePath };
}

const MAX_CHECK_BYTES = 8 * 1024 * 1024;
const MAX_SCAN_ENTRIES = 20_000;

/** Read-only startup diagnostic. Never grants permissions or certifies resumability.
 * Enumerates only projects/<directory>/<UUID>.jsonl, not credentials or subagents.
 */
export async function checkLatestClaudeSession({
  claudeConfigDir,
}: {
  claudeConfigDir: string;
}): Promise<DriftCheckResult> {
  if (!isAbsolute(claudeConfigDir))
    return { status: "unavailable", reason: "Claude config directory must be absolute" };
  let selected:
    | {
        filePath: string;
        mtimeMs: number;
        ino: number;
        dev: number;
        size: number;
        sessionId: string;
      }
    | undefined;
  let scanned = 0;
  try {
    const projects = join(await realpath(claudeConfigDir), "projects");
    const projectInfo = await lstat(projects);
    if (!projectInfo.isDirectory() || projectInfo.isSymbolicLink())
      return { status: "unavailable", reason: "Claude projects directory is not a real directory" };
    for await (const project of await opendir(projects)) {
      if (++scanned > MAX_SCAN_ENTRIES)
        return {
          status: "unavailable",
          reason: "Claude session discovery exceeded metadata scan limit",
        };
      if (!project.isDirectory() || project.isSymbolicLink()) continue;
      for await (const entry of await opendir(join(projects, project.name))) {
        if (++scanned > MAX_SCAN_ENTRIES)
          return {
            status: "unavailable",
            reason: "Claude session discovery exceeded metadata scan limit",
          };
        if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
        const sessionId = entry.name.slice(0, -6);
        if (!Value.Check(UuidSchema, sessionId)) continue;
        const filePath = join(projects, project.name, entry.name);
        const info = await lstat(filePath);
        if (!info.isFile() || info.isSymbolicLink()) continue;
        if (
          !selected ||
          info.mtimeMs > selected.mtimeMs ||
          (info.mtimeMs === selected.mtimeMs && filePath > selected.filePath)
        ) {
          selected = {
            filePath,
            sessionId,
            mtimeMs: info.mtimeMs,
            ino: info.ino,
            dev: info.dev,
            size: info.size,
          };
        }
      }
    }
  } catch {
    return {
      status: "unavailable",
      reason: "Claude session metadata is unavailable; schema was not checked",
    };
  }
  if (!selected)
    return {
      status: "unavailable",
      reason: "No Claude session is available; schema was not checked",
    };
  const label = `projects/<project>/${selected.sessionId}.jsonl`;
  function warning({ detail }: { detail: string }): DriftCheckResult {
    return {
      status: "warning",
      warning: `pi-claude: Claude session schema check: ${label}: ${detail}`,
    };
  }
  if (selected.size > MAX_CHECK_BYTES)
    return warning({ detail: "file exceeds bounded schema-check limit; not verified" });
  try {
    const file = await open(selected.filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    let text: string;
    try {
      const before = await file.stat();
      if (
        !before.isFile() ||
        before.ino !== selected.ino ||
        before.dev !== selected.dev ||
        before.mtimeMs !== selected.mtimeMs ||
        before.size !== selected.size
      )
        return warning({ detail: "session changed during discovery; not verified" });
      const buffer = Buffer.alloc(MAX_CHECK_BYTES + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      const after = await file.stat();
      if (offset > MAX_CHECK_BYTES)
        return warning({ detail: "file exceeds bounded schema-check limit; not verified" });
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || offset !== before.size)
        return warning({ detail: "session changed during read; not verified" });
      text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, offset));
    } finally {
      await file.close();
    }
    const lines = text.split("\n");
    if (lines.at(-1) === "") lines.pop();
    if (!lines.length) return warning({ detail: "empty session; not verified" });
    let messages = 0;
    for (const [index, line] of lines.entries()) {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        return warning({ detail: `line ${index + 1}, record <unknown>: invalid JSON` });
      }
      const type = Value.Check(RecordTypeSchema, value) ? value.type : "<unknown>";
      try {
        const record = parseOrThrow({ schema: NativeRecordSchema, value, source: "native record" });
        if ("sessionId" in record && record.sessionId !== selected.sessionId)
          return warning({ detail: `line ${index + 1}, record ${type}: session ID mismatch` });
        if (record.type === "user" || record.type === "assistant") messages++;
      } catch {
        return warning({ detail: `line ${index + 1}, record ${type}: schema mismatch` });
      }
    }
    if (!messages) return warning({ detail: "no modeled conversation records; not verified" });
    return { status: "matching", filePath: selected.filePath };
  } catch {
    return warning({ detail: "session could not be read safely; not verified" });
  }
}
