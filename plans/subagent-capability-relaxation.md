# Selective relaxation of subagent restrictions

## Goal

Give subagents useful orchestration and explicitly approved tools without
inheriting the parent's entire extension environment or expanding its authority.
Start with tools-only codemode; keep model-provider access, MCP, and nested
subagent delegation separate.

## Current baseline

- Children launch with `--no-extensions`, an explicit tool list, Guard, and the
  child runtime. Ordinary children have neither codemode nor built-in MCP.
- Codemode's nested tool calls use the normal execution/Guard pipeline, but its
  classifier/image globals bypass ordinary tool authorization.
- Parent profile selection overrides agent frontmatter today. A reviewer label
  therefore does not establish an enforced read-only policy.
- Backing extensions are trusted host code. Entry-file digests do not sandbox
  initialization, dependencies, or internal filesystem/network operations.

## Plan

### 1. Define and persist approved child capabilities

- Extend the existing validated loadout rather than introducing a parallel
  permissions system. Derive supported tools/types from existing definitions.
- Represent tools-only codemode explicitly; do not disguise it as an ordinary
  filesystem built-in or enable extension discovery to obtain it.
- Preserve explicit tool/backing-extension selection and loadout authority checks
  on launch, reload, and resume. Do not infer permission from tool visibility.

### 2. Enable tools-only codemode

- Use Pi's public `createCodemodeExtension({ models: false })` factory through a
  trusted, explicitly loaded backing extension.
- Keep `--no-extensions`; verify that no unrestricted duplicate codemode or MCP
  extension is loaded.
- Keep normal `on` presentation: direct tools remain visible, codemode provides
  batching/filtering, and every nested tool operation remains independently gated.
- Make this the default orchestration capability for built-in agents only after
  the real-child tests below pass. It must not add filesystem or shell authority.

### 3. Enforce role and task ceilings

- Narrow inherited parent permissions with role restrictions and delegated scope;
  never replace a restrictive parent with a more permissive child profile.
- Enforce reviewer read-only behavior across Bash as well as write/edit tools.
- Require explicit custom-tool approval in restricted children instead of
  allowing missing custom-tool policy by default.
- Keep extension mappings user-controlled/protected and document their trusted
  host-code boundary. Tool-name approval is not internal-operation sandboxing.

### Approved runtime scratch-space exception

Current-user OS temporary-directory access is approved separately from the
optional tool capabilities in this plan. Preserve an effective parent's existing
write authorization for the exact resolved current-user OS temp directory when
narrowing a child's task write scope. Do not grant all of `/var/folders`, preserve
all extra write roots, or add authority denied by the parent or a role ceiling.
Canonicalize the runtime root and keep protected-path denials effective.

This supports standard subprocesses, including macOS `mktemp -d`, which uses the
OS user-temp directory even when `TMPDIR` points to private agent scratch space.
Shared user-temp access is not per-agent isolation: it can affect temporary
artifacts of other processes running as the same user. Read-only role ceilings
must explicitly distinguish permitted scratch writes from forbidden task-file
mutation; this exception must not silently override those ceilings.

Verify real system `mktemp` through the scoped sandbox, restrictive-parent
preservation, and continued denial of unrelated cache, protected, and
out-of-scope task writes. This approval does not enable codemode, MCP, nested
delegation, or the other capability changes below.

### 4. Add optional tools individually, not wholesale inheritance

- Reuse the approved backing-extension mechanism for specific justified tools.
- Keep MCP absent by default. Any later MCP support needs explicit executable-tool
  filtering: Pi's ordinary `--tools` handling has an MCP exception.
- Keep classifier/image-model calls disabled until a real pre-dispatch provider,
  destination, data-egress, and spending authorization boundary exists.
- Keep nested delegation disabled; descendant authority propagation and lifecycle
  limits are separate work.

## Verification and rollout

Drive the generated production child command with a deterministic local provider;
no paid calls or real external services. Cover:

- Parallel permitted calls and filtered results through codemode.
- Unavailable tools, protected reads, denied Bash, and out-of-scope writes.
- Disabled model globals, absent MCP, and rejected recursive delegation.
- Reviewer mutation denial despite a permissive parent; parent restrictions still
  hold when a role would otherwise permit an operation.
- Launch, reload, and resume preserving the same approved capability set.
- Nested denials remaining observable even when scripts catch errors; earlier
  successful operations are not represented as rolled back.

Run package static checks and focused/full suites; report unrelated failures
separately. Have two independent reviewers inspect the same final snapshot before
rollout. Ship tools-only codemode and permission-ceiling changes in small,
separately reviewable steps; do not enable broader tools to work around failures.

## Relevant implementation

- `home/.pi/agent/packages/pi-guard-subagents/extensions/index.ts`
- `home/.pi/agent/packages/pi-guard-subagents/extensions/interactive/{launcher,types,child-runtime}.ts`
- `home/.pi/agent/packages/pi-guard/extensions/guard.ts`
- Existing detailed model-boundary plan:
  `home/.pi/agent/packages/pi-guard/plans/codemode-guard-boundaries-and-transparency.md`

Except for the separately approved runtime scratch-space exception above, this
is a plan only; no other subagent capability changes are authorized by this file.
