# Owned Claude session reconstruction

This module writes a **new** Claude JSONL session for a provider-supplied,
authoritative Pi conversation prefix. It does not open, edit, repair, delete,
or reuse an existing Claude session. The provider resumes the returned full
path with SDK forking and tracks the SDK's new session identity separately.

## Boundary

```ts
reconstructSession({
  messages, // readonly ConversationMessage[]; excludes Pi's system role
  cwd, // absolute, existing project directory
  model, // target Claude model
  claudeConfigDir, // explicit absolute config root, same as SDK environment
  toolNameMap, // optional exact Pi name -> SDK MCP name map
}): Promise<{ sessionId: string; filePath: string }>
```

The provider owns the newest pending user message and must not include it twice.
It computes current system instructions/tools with the host's transcript helpers;
passing any system message here fails validation. The optional tool map is exact
and complete for historical tool names: missing entries fail, never map to Claude
builtins or guess names. Without a map, names are preserved byte-for-byte.

Supported conversation content:

- User and assistant text, with its original ordering and content.
- Base64 PNG/JPEG/GIF/WebP user and tool-result images, unchanged. Base64 must be
  canonical. Image payload decoding/format detection is left to Claude.
- Tool uses with lossless JSON arguments, original valid IDs, matching named
  results, and error flags. Parallel results remain separate linked user records
  in their original order; they are not hoisted across steering messages.
- Signed thinking produced by this provider for the same fully qualified target
  Claude model (not an unresolved target alias), including redacted thinking with
  its opaque native data. The historical actual model is `responseModel ?? model`.
  Unsigned/foreign/model-mismatched
  thinking fails rather than being removed, flattened, or given a fake signature.

Unsupported history fails before creating files: system records, text/tool
signatures without a Claude representation, namespaced tools, deferred assistant
turns, unprojected empty failed attempts, empty successful assistant content,
malformed IDs, missing or
repeated results, steering interleaved with pending tools, duplicate tool IDs,
and missing SDK name mappings. Pi accounting, diagnostics, tool details and
nested execution metadata are not model content; no native Claude attachments
or file snapshots are invented from them. Native attachments absent from the Pi
transcript cannot be recovered. A live SDK continuation should be preserved until
Pi's authoritative history requires a rebuild.

Every generated record is schema-checked before and after JSON serialization.
Records use UUID parent links and minimal actual on-disk fields, with the
validated actual assistant model `responseModel ?? model`; no guessed Claude
version, git branch, slug, or native request metadata is fabricated. Runtime
validation and lossless tool-argument validation reuse the shared package helpers.

Project cwd is resolved through realpath and NFC normalization. Drafts live only
at `<claudeConfigDir>/pi-claude/reconstruction/<UUID>.jsonl`, outside Claude's
native `projects/` tree. The provider resumes their absolute path with SDK
forking, so no native project-directory encoding or Bun/Node long-path hashing
is needed. Long project paths are supported without guessing a runtime hash.
New directories request mode 0700; files request 0600. A private exclusive temporary
inode is synced and then hard-linked into its new random UUID path: publication
is atomic and cannot replace an existing file. Existing directories retain their
permissions; symlink destination directories are rejected. As with other Node
path-based APIs, protection against a malicious same-user process swapping a
parent directory would require platform-specific descriptor-relative filesystem
operations, which are not supplied here.

## Explicit recovery projection

The provider calls `projectRecoveryHistory({ messages })` from `index.ts` before
constructing its complete outbound payload. It returns:

```ts
{
  messages: ConversationMessage[];
  diagnostics: RecoveryDiagnostic[];
}
```

`PiConversationSchema`, `RecoveryDiagnosticSchema`, and the derived diagnostic
type are exported by `schema.ts`; the provider must use this same conversation
schema when validating unknown transformed history. The existing reconstruction
signature and return value are unchanged. Diagnostics must be surfaced by the
provider; recovery is not a hidden writer fallback.

Only Pi's explicit `error` and `aborted` assistant attempts are projected:

- Empty transport attempts are excluded, with an indexed diagnostic, so a later
  real user prompt does not inherit a permanently unusable empty assistant.
- Completed visible content and complete signed thinking remain verbatim.
  Their native assistant record has `stop_reason: null`, not a fake successful
  `end_turn`. Thinking still passes the same provenance/signature/model checks.
- Tool calls with immediately following, matching recorded results remain in
  their original order, with those actual results and error flags unchanged.
- Structurally valid unresolved calls belonging to that explicitly failed
  attempt are excluded and counted. Their execution outcome is **unknown**;
  recovery neither claims they did not execute nor fabricates a tool result.
- Ordinary incomplete tool turns are never repaired, even if a later unrelated
  empty cancellation marker exists. Without an attributable failed attempt,
  missing outcomes remain an explicit unsafe-history failure. Actual recorded
  cancellation/error tool results can always complete an otherwise valid pair.

Diagnostics contain only zero-based message index, failed stop reason, action,
excluded-unresolved-call count, and retained-result count. They do not contain
prompts, arguments, tool outputs, transport error text, or signatures. The
`excluded-empty-attempt` action describes an empty **projected** attempt; its
excluded-call count distinguishes a transport-only failure from unresolved calls.
Malformed IDs/arguments, duplicate or contradictory results, unknown fragments,
unsupported signatures, and foreign/unsigned thinking are not silently dropped.

## Startup diagnostic

```ts
checkLatestClaudeSession({ claudeConfigDir }): Promise<
  | { status: "matching"; filePath: string }
  | { status: "warning"; warning: string }
  | { status: "unavailable"; reason: string }
>
```

Read-only metadata discovery selects the most recently modified top-level
`projects/<directory>/<UUID>.jsonl`; owned reconstruction drafts are outside this
tree and can never supersede a runtime-written session in discovery. Subagents,
symlinks, credentials, and other config files are not read. Metadata enumeration
is bounded to 20,000 entries.
Only the selected file is opened, with no-follow, identity/change checks and an
8 MiB hard content-read limit. No latest session, excessive discovery, unreadable
metadata, oversized content, concurrent changes, or incomplete data is reported
as verified. Runtime inspection happens only when the integration calls this
function; development tests use temporary sanitized fixtures exclusively.

Warnings contain a redacted project path, UUID filename, line number, and a
bounded syntactically safe record type where available. They never echo JSON,
validation values, error payloads, attachment contents, or prompt text. Matching
means all records matched the **modeled envelope/content contract**, not proof of
Claude resumability or full validation of arbitrary native attachment payloads.
Native metadata is extensible; unknown record types or incompatible content
produce warnings. The integration emits warnings at startup. This diagnostic
never grants permissions and cannot authorize tool calls.

## Format research / attribution

Independent implementation; no runtime dependency on a session-file library and
no upstream implementation copied. Format research used the reviewed
`pi-claude-bridge` sources (MIT, copyright 2026 Eli Dickinson) and `cc-session-io`
README/declarations/path research (MIT, copyright 2024), including their minimal
user/assistant record examples, attachment parent-link discussion, and known
Bun/Node long-path hashing limitation. These projects are not official format
specifications. Drift is intentionally observable rather than hidden behind
compatibility fallbacks.
