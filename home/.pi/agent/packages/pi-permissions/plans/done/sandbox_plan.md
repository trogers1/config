# Sandbox Plan: Profile-Derived OS Containment for Bash

**Status:** fresh implementation plan — not implemented

**Updated:** 2026-07-21

Add optional kernel-enforced containment to `pi-permissions` so every approved
Bash command also runs inside a sandbox derived from the active permissions
profile.

The existing gate remains the semantic and UX layer: it parses the requested
operation, applies protected paths, evaluates path and command rules, prompts
for `ask`, and returns steering. The sandbox is the process boundary behind the
gate: it constrains effects the parser cannot see, including package scripts,
compilers, command substitutions, and descendant processes.

```text
requested Bash command
        │
        ▼
existing pi-permissions gate
  protectedPathRules → writePaths[bash] → command rules → allow/ask/deny
        │ approved
        ▼
resolved active profile → conservative SandboxSpec compiler
        │
        ▼
macOS/Linux backend → kernel-enforced process tree
```

This plan starts implementation from scratch, but restores the strongest ideas
from the original sandbox plan: per-profile posture, policy derivation, a
backend-neutral intermediate representation, fail-tight translation, coverage
reporting, `user_bash` containment, profile-switch integration, and honest
Bash-only scope. It updates those ideas for the current policy model and Pi's
current tool APIs.

## 1. Goals and non-goals

### Goals

- Every LLM `bash` call approved by the existing gate runs under the active
  profile's kernel sandbox when that profile enables sandboxing.
- User `!` and `!!` commands use the same sandbox resolution. They are not
  permission-gated because they are user-authored, but they are contained.
- Sandbox posture is part of `ProfilePolicy`, works in user JSONC profiles, and
  changes with `/profile` just like the rest of the safety posture.
- Filesystem posture is derived from the fully resolved profile wherever an
  equivalent OS rule can be proven. Configuration adds only capabilities that
  have no policy equivalent or explicit escape hatches for translation gaps.
- `PI_SUBAGENT_PERMISSIBLE_GLOBS` always narrows sandbox writes for scoped
  workers; it can never widen the profile.
- macOS and Linux are first-class targets behind one backend-neutral spec.
- Requested sandboxing fails closed when the backend or a required restriction
  cannot be established, unless the profile explicitly chooses a visible warn
  fallback.
- `/sandbox` and the system prompt explain the effective kernel boundary and
  any safe-but-inconvenient translation gaps.
- Zero Pi core changes.

### Non-goals for v1

- Sandboxing in-process `read`, `write`, `edit`, `grep`, `find`, or `ls` calls.
  They retain the existing path/protected-path gate.
- Containing arbitrary custom tools, extension code, or `pi.exec()` calls made
  by other extensions.
- Treating sandboxing as permission to auto-approve `ask` decisions.
- Dynamically widening the sandbox after an interactive approval.
- Reproducing command-rule semantics in the kernel.
- CPU, memory, disk-quota, or process-count controls unless the selected
  backend already provides them as a documented capability.
- Windows.

This is **Bash process containment**, not a whole-agent sandbox. A profile that
allows writes throughout the workspace still allows a sandboxed command to
damage that workspace. Trusted extensions can expose other host-side execution
paths. For hostile Pi packages, strict containment of the in-process file
tools, or an untrusted repository requiring a stronger boundary, run the whole
Pi process in Docker/OpenShell or route all built-ins through Gondolin.

## 2. Current-code constraints

The implementation must use the package as it exists now:

- `extensions/permissions.ts` owns active-profile selection, profile commands,
  the `tool_call` gate, protected-path handling, and
  `PI_SUBAGENT_PERMISSIBLE_GLOBS` enforcement.
- Profiles and rule sets compose through `extendProfile`; transforms rewrite
  inherited ordinary decisions but preserve `protectedPathRules`.
- Rules resolve by specificity first, literal character count second, and
  composed position only as a final tie-breaker. The sandbox compiler must not
  assume simple last-match ordering.
- Bash filesystem operands now use `writePaths` with context `bash`. The old
  `bashPathReferences`, `bashOutputRedirections`, protected-pattern helper, and
  `PI_SUBAGENT_WRITE_GLOBS` names no longer exist.
- `readPaths` governs dedicated read tools and `cd` navigation. It is not a
  general Bash read allowlist. Arbitrary Bash reads are constrained by the
  protected-path layer, so v1's kernel read posture derives from
  `protectedPathRules`, not ordinary `readPaths`.
- Pi publicly supports `createBashTool()`, `BashOperations`,
  `createLocalBashOperations()`, built-in overrides, `user_bash`, and
  `getAllTools().sourceInfo`.
- Built-in overrides are load-order-sensitive. A competing `bash` override can
  bypass containment unless detected.
- The current integration harness does not model tool registration/execution,
  provenance, or `user_bash`; it must be extended before wiring is considered
  tested.

Upstream references to verify during implementation:

- Pi `docs/security.md` and `docs/containerization.md` for the security model;
- Pi `docs/extensions.md` for overrides, operations, events, and provenance;
- Pi `examples/extensions/sandbox/` for the current
  `@anthropic-ai/sandbox-runtime` integration; and
- Pi `examples/extensions/gondolin/` for complete built-in routing.

## 3. Profile configuration and composition

### 3.1 Schema

Add a backend-neutral `sandbox` field to both the resolved profile schema and
the user profile-definition schema in `modules/policyHelpers.ts`:

```ts
type SandboxConfig = {
  /** Network available to Bash and its descendants. Required and explicit. */
  network: "allow" | "deny";

  /** Explicit additive write roots when policy translation is too narrow. */
  extraWritePaths?: string[];

  /** Explicit additive read/write restrictions with no suitable policy rule. */
  extraDenyReadPaths?: string[];
  extraDenyWritePaths?: string[];

  /**
   * Exact inherited protected-deny patterns intentionally left gate-only.
   * Every waiver is reported by /sandbox and must match an existing deny.
   */
  kernelUnenforcedProtectedPaths?: string[];

  /** Default: block. Warn is a visible, explicit unsandboxed fallback. */
  onUnavailable?: "block" | "warn";
};

type ProfilePolicy = {
  // existing fields
  sandbox?: SandboxConfig | false;
};
```

Semantics:

- Omitted `sandbox` inherits the current composed value.
- `sandbox: false` explicitly disables an inherited sandbox.
- A `SandboxConfig` enables sandboxing and replaces an inherited config as one
  scalar value. It does not deep-merge. This matches other scalar profile
  metadata and prevents surprising half-merges of security settings.
- `network` is required so a profile author consciously chooses whether Bash
  can connect. Domain allowlists are deferred until a backend proves portable,
  testable semantics; v1 must still support complete allow/deny.
- Extra paths are additive inputs to the compiler, not a parallel full
  filesystem policy. Generated protected-path restrictions are applied after
  `extraWritePaths`, so an extra write root cannot silently reopen a protected
  secret.
- `kernelUnenforcedProtectedPaths` is an explicit compatibility waiver, not an
  allow rule. Each entry must exactly equal an effective protected `deny`
  pattern. The gate still enforces that rule, while `/sandbox` reports that the
  kernel does not. Typos and references to non-deny patterns are configuration
  errors.
- `additionalProperties: false` applies throughout. Extra filesystem paths
  reject NUL/newline, expand `~`, and resolve relative paths from Pi's startup
  cwd. Waiver entries are policy-pattern identifiers, not paths: preserve them
  byte-for-byte after rejecting hostile characters, then compare them for exact
  equality with effective deny-pattern strings.

`extendProfile` must preserve omitted sandbox values, accept explicit `false`,
and replace on an explicit object. Profile transforms leave sandbox metadata
unchanged. Add composition tests for inheritance, rightmost multi-extends,
explicit disable, replacement, and transforms.

The generated `schemas/profiles.schema.json` remains the only user-facing
schema artifact; no second sandbox config file or schema is added.

### 3.2 Rollout posture

Sandboxing is opt-in initially. Do not add it to portable shipped profiles
until both macOS and Linux backends pass acceptance tests and normal workflows
are understood.

A user can build a sandboxed profile family through ordinary inheritance:

```jsonc
{
  "profiles": {
    "sandboxed-default": {
      "extends": ["builtin:default"],
      "sandbox": {
        "network": "allow",
        "extraDenyReadPaths": ["~/Library/Keychains"],
        // Approved Git commands need implicit repository-metadata access.
        // Direct .git paths remain blocked by the permission gate.
        "kernelUnenforcedProtectedPaths": ["**/.git", "**/.git/**"],
      },
    },
    "sandboxed-worker": {
      "extends": ["sandboxed-default"],
      "transforms": ["transform:deny-asks"],
      "color": "magenta",
      "emoji": "⚙️",
    },
  },
}
```

Switching to an explicitly unsandboxed profile is a legitimate change in safety
posture, just like switching from `read-only` to `default`. The UI must make the
change visible, and the new gate and sandbox resolution must switch together.

## 4. Backend-neutral compilation

### 4.1 `SandboxSpec`

Create `modules/sandbox.lib/translate.ts` with no Seatbelt, bubblewrap, or
third-party runtime types in its public signature:

```ts
type SandboxSpec = {
  profile: string;

  // Bash reads are allowed by default, then protected denies/exceptions apply.
  readRules: Array<{
    decision: "allow" | "deny";
    pattern: string;
    source: "protected" | "config";
  }>;

  // Writes are denied by default. Only proven effective allows are opened.
  writeRules: Array<{
    decision: "allow" | "deny";
    pattern: string;
    source: "writePaths" | "protected" | "config" | "subagent";
  }>;

  writable: {
    literals: string[];
    subpaths: string[];
  };

  network: "allow" | "deny";
};

type CoverageReport = {
  /** Required restrictions the backend/compiler could not prove. Blocks. */
  uncoveredRestrictions: Array<CoverageItem>;

  /** Profile-authorized restrictions intentionally left gate-only. */
  waivedRestrictions: Array<CoverageItem>;

  /** Gate may allow these, but the kernel remains tighter. Informational. */
  untranslatedAllows: Array<CoverageItem>;

  /** Policy concepts with no kernel-filesystem meaning. Informational. */
  noKernelMeaning: Array<CoverageItem>;
};
```

`translatePolicy(policy, context)` returns the spec plus compiler coverage.
Backend preparation adds backend-specific expressibility coverage before a
sandbox becomes active.

Coverage has directional semantics:

- Dropping a restriction can widen access. Any uncovered effective restriction
  makes sandbox resolution unavailable and follows `onUnavailable`.
- A restriction is omitted only when the resolved profile explicitly names it
  in `kernelUnenforcedProtectedPaths`. Keep the sandbox active and report it
  separately under `waivedRestrictions`; it is not an automatic coverage gap
  or a concept with no kernel meaning.
- Dropping an allow only makes the sandbox tighter. Keep the sandbox active,
  report the path under `untranslatedAllows`, and explain likely EPERM failures.
- Command rules, prompts, guidance, and other non-filesystem concepts belong in
  `noKernelMeaning`, but do not emit one item per Bash command rule. That would
  turn the report into noise.

No rule is approximated. The compiler either proves equivalent behavior for a
supported shape or reports it in the direction-appropriate bucket.

### 4.2 Write derivation from current `writePaths`

The compiler derives Bash writable regions from the fully composed
`writePaths` policy using only rules eligible for context `bash`:

- a rule without `contexts` applies;
- a rule containing `bash` applies; and
- rules restricted to `edit`/`write` do not widen Bash.

Current path evaluation falls back to `allow`, while the kernel sandbox starts
from deny-write. The compiler therefore materializes only host regions that can
be proven writable:

1. the startup cwd regions allowed by the effective Bash-context policy;
2. explicit absolute allows such as `/tmp/**`;
3. `sandbox.extraWritePaths`; then
4. all effective ordinary/protected denies are carved back out.

V1 supports the concrete policy shapes used by shipped profiles and common
custom profiles: startup-cwd/subpath roots, literal files, absolute roots,
`/**` descendants, basename/file globs that the chosen backend can express,
and more-specific deny/allow carve-outs. A custom pattern outside the proven
subset is classified by direction rather than guessed.

Important consequences:

- `default` can derive a writable startup cwd and configured temp roots without
  granting writes to the rest of the host.
- `read-only` derives only `/tmp`, `/private/tmp`, `handoff.md`, and
  `progress.md` from its current `writePaths`; there is no fallback that reopens
  the cwd.
- `scribe-only`, test-focused, and implementation-only profiles retain their
  Bash-context path restrictions. Context-specific dedicated-tool allows do not
  leak into Bash.
- `ask` compiles as kernel-deny, including as a carve-out from a broader allow.
  A more-specific ordinary `allow` inside an ask region may reopen only the
  proven descendant. If the user approves an ask-only path, the command may
  still receive EPERM because v1 does not dynamically widen the sandbox.
- No implicit scratch path is added. Current profiles already declare their
  intended `/tmp` access; deriving it avoids a second source of truth.

The compiler must use current specificity semantics. Do not concatenate rules
and assume the last textual entry wins. For every opened region, it must prove
that higher-specificity ordinary rules, protected rules, and runtime scope
constraints are preserved by the emitted spec.

### 4.3 Protected-path derivation

`protectedPathRules` are the source for kernel read denials and mandatory write
carve-outs:

- effective protected `deny` rules become both read and write restrictions;
- a protected `allow` only cancels the matching protected deny; it never grants
  write access by itself. A write exception opens only when the ordinary
  Bash-context `writePaths` result is independently `allow`;
- more-specific protected `allow` exceptions are restored only where the
  backend can prove equivalent precedence;
- an unexpressible protected deny blocks activation rather than silently
  weakening the promised boundary; and
- an unexpressible protected allow exception is safe tightening, so it remains
  active but appears under `untranslatedAllows`.

This preserves the current default protections for `.env*`, credentials,
cloud configs, SSH/GPG material, key files, and repository metadata without a
hand-maintained sandbox copy.

`.git` exposes an unavoidable compatibility choice. The current gate protects
direct `.git` path requests while approved Git commands access repository
metadata implicitly. A path-only kernel policy cannot distinguish `git status`
from an arbitrary process reading the same files. By default the compiler
therefore enforces the inherited `.git` deny and normal Git commands may fail.
A profile that needs Git must explicitly list the exact inherited `.git` deny
patterns in `kernelUnenforcedProtectedPaths`. Those rules remain active in the
gate and appear prominently in `/sandbox` as profile-authorized kernel coverage
waivers. The compiler never inserts this waiver automatically.

Ordinary `readPaths` are not compiled in v1. They govern dedicated tools and
`cd`, while Bash's broad runtime reads need system libraries, executables, and
toolchains. A future read-allowlist compiler would require an explicit baseline
of runtime system paths and separate compatibility work.

### 4.4 Subagent narrowing

Move `PI_SUBAGENT_PERMISSIBLE_GLOBS` parsing out of
`extensions/permissions.ts` into `modules/subagentScopes.ts`. The shared result
feeds:

1. the existing gate rules for `edit`, `write`, Bash references, and
   redirections; and
2. sandbox write narrowing.

Keep gate behavior unchanged in the extraction commit.

When the environment variable is present, its effective roots intersect every
profile-derived/configured project write. It never unions with profile writes,
never removes protected denies, and never affects network or protected reads.
There is no `ignore` option.

Support only scope forms whose meaning the compiler and selected backend can
prove equivalent. Unsupported scope globs make the sandbox unavailable and
fail closed with guidance to use representable scopes; they are never
approximated. Comma-containing path names remain unsupported because the
producer format is comma-delimited.

This is a key defense for workers: the gate catches explicit path operands,
while the kernel stops implicit writes by package scripts and child processes
whose targets never appeared in the original command.

## 5. Backend decision and runtime boundary

### 5.1 Contract spike before commitment

Do not assume either a third-party runtime or hand-written OS adapters. First
compare:

1. an exact-pinned `@anthropic-ai/sandbox-runtime` adapter, based on Pi's
   current sandbox example; and
2. thin direct adapters over macOS Seatbelt and Linux bubblewrap.

The runtime may provide maintained cross-platform rendering, detection,
lifecycle, and network mediation. Direct adapters may provide better control,
clearer profile switching, fewer global-state risks, and stronger alignment
with the compiler's precedence requirements.

Choose only after executable spikes establish:

- macOS and Linux prerequisite/detection behavior;
- whether required protected deny/allow exceptions and write carve-outs can be
  represented exactly;
- process-global state and whether profiles can switch safely;
- command execution without unsafe nested-shell quoting;
- environment propagation, streaming, cancellation, timeout, and process-tree
  termination;
- network allow and deny semantics;
- symlink behavior and path canonicalization;
- child/grandchild inheritance; and
- dependency maintenance, packaging, and licensing cost.

If the third-party runtime passes, pin its exact version in `dependencies`,
commit the lockfile, and keep it private behind `sandbox.lib`. If it cannot
represent required restrictions or safely switch profiles, implement direct
backend adapters instead. The rest of the plan depends only on `SandboxSpec`.

### 5.2 Backend interface

The internal interface should be capability-oriented:

```ts
interface SandboxBackend {
  probe(): Promise<BackendProbe>;
  prepare(spec: SandboxSpec): Promise<PreparedSandbox>;
  dispose(): Promise<void>;
}

type PreparedSandbox = {
  backend: "macos" | "linux";
  report: CoverageReport;
  operations: BashOperations;
  denialSignatures: RegExp[];
};
```

`prepare` must validate the complete rendered/effective policy, not only a
minimal backend smoke test. Generated policy artifacts stay in memory or in a
location outside every sandbox-writable root. Never cache a reusable policy
file under writable `/tmp`.

Path handling must expand `~`, resolve the real startup cwd, account for macOS
`/tmp` symlinks, and prevent symlink traversal from turning an allowed root into
an outside write.

### 5.3 Use `BashOperations`, not `spawnHook`

Override `bash` with `createBashTool()` and execute through a prepared
`BashOperations` implementation. Prefer delegating the backend-wrapped command
to `createLocalBashOperations()` so Pi retains process-group termination,
streaming, timeout, environment, and shell behavior:

```ts
const local = createLocalBashOperations();

const sandboxed: BashOperations = {
  async exec(command, cwd, options) {
    const wrapped = await runtimeAdapter.wrap(command);
    return local.exec(wrapped, cwd, options);
  },
};
```

The actual adapter may use an argv-based launcher if that avoids another shell
parse. Preserve `cwd`, `env`, `onData`, `signal`, and `timeout` exactly. Do not
mutate `event.input.command` to add containment, and do not add a generic
package-owned quoting layer unless the chosen direct backend proves one is
unavoidable and behavioral tests cover it.

The gate and `/permissions explain` continue to inspect the user's command
(apart from the existing protected ripgrep-glob injection), not a wrapper.

## 6. Sandbox library and resolution

Use the repository's `.lib` boundary:

```text
modules/
  sandbox.lib/
    index.ts          # small public API
    types.ts          # SandboxSpec, resolution, reports
    translate.ts      # resolved profile → backend-neutral spec
    backend.ts        # selected runtime/direct adapter boundary
    operations.ts     # BashOperations integration
  subagentScopes.ts   # shared gate/runtime scope parser
```

If direct OS adapters win the spike, add private `seatbelt.ts` and `bwrap.ts`
siblings. If the third-party runtime wins, add only its private adapter. Outside
code imports only `sandbox.lib/index.ts`; internal files never import the lib's
index. Add a `sandbox-lib-no-index-self-import` dependency-cruiser rule.

Public API:

```ts
type SandboxState = {
  profile: string;
  policy: ProfilePolicy;
  startupCwd: string;
  subagentScopes?: NormalizedSubagentScopes;
  configurationError?: string;
};

type SandboxResolution =
  | { kind: "none" }
  | {
      kind: "unavailable";
      reason: string;
      onUnavailable: "block" | "warn";
      report?: CoverageReport;
    }
  | {
      kind: "active";
      spec: SandboxSpec;
      report: CoverageReport;
      prepared: PreparedSandbox;
    };

resolveSandbox(state: SandboxState): Promise<SandboxResolution>;
clearSandboxCaches(): Promise<void>;
```

Cache backend probes and prepared states by the complete effective input:
resolved profile sandbox/filesystem policy, canonical startup cwd, and
normalized subagent scopes. Never reuse an unconstrained artifact for a scoped
worker. Clear caches and dispose backend state on `session_shutdown`/reload.

Resolution occurs eagerly at session start and after every profile switch so UI
and coverage are current. The Bash execute path resolves defensively from the
current state before every call; it must never run under the previous profile's
broader sandbox during a transition.

Resolution rules:

1. any profile/configuration error → unavailable with mandatory block;
2. no error and no sandbox on the active profile → ordinary local Bash;
3. active and fully prepared → sandbox operations;
4. unavailable + default `block` → Bash/user Bash fail with exit 126 and a
   stable explanation; and
5. unavailable + explicit `warn` → unsandboxed Bash, one warning notification,
   and persistent yellow status.

Invalid sandbox schema and invalid `PI_SUBAGENT_PROFILE` follow the package's
existing fail-closed configuration path and are passed into sandbox resolution;
they cannot opt into warn. The fallback `genericPolicyConfig` must never make a
configuration error resolve as `none`.

## 7. Extension wiring

### 7.1 Tool registration and ownership

If any configured profile can enable sandboxing, register one Bash override at
extension load based on `createBashTool(startupCwd)`. Its execute closure reads
the current active profile and resolution:

- `none` uses the captured local Bash tool;
- `active` executes with prepared sandbox operations;
- blocked unavailable throws/returns the normal Bash failure shape without
  invoking local operations; and
- warn unavailable uses local Bash only after emitting the required state.

Registering once permits `/profile` switching without replacing the tool again.
When sandboxing is active, verify at session start and every Bash `tool_call`
that this package still owns the effective `bash` definition through documented
`getAllTools().sourceInfo`. If a later extension replaced it, block before
execution. The contract spike must establish the stable provenance comparison;
do not inspect undocumented registries or compare function identity.

### 7.2 Existing gate

Keep the current `tool_call` pipeline and gate ordering unchanged. For Bash:

1. reject global profile/config errors;
2. enforce `PI_SUBAGENT_PERMISSIBLE_GLOBS`;
3. inject protected ripgrep exclusions;
4. run `gateBash()`; then
5. ensure the current sandbox resolution/ownership permits execution.

The tool's execute path repeats the final sandbox-state check so containment
does not rely solely on event ordering.

### 7.3 `user_bash`

Always register one `user_bash` handler, even when no loaded fallback profile
currently enables sandboxing, so invalid profile configuration and an invalid
`PI_SUBAGENT_PROFILE` cannot bypass fail-closed behavior. It uses the same
resolution:

- `none` returns `undefined` for Pi's default behavior;
- `active` returns the prepared sandbox operations;
- blocked unavailable returns a complete exit-126 result; and
- warn unavailable returns `undefined` only with visible warning state.

Pi does not expose handler provenance equivalent to tool `sourceInfo`. Test
multiple-handler ordering during the contract spike and document the
composition guarantee. Do not claim unconditional `!` containment in the
presence of arbitrary other extensions; strict users need whole-process
containment.

### 7.4 Profile switching

Update every profile-switch path (`/profile`, `/read-only`, `/socrates`, and
`/socrates-off`) through one async activation helper:

1. select the target policy and allocate a monotonically increasing activation
   generation;
2. mark sandbox state transitioning so Bash cannot use the previous artifact;
3. resolve/prepare the target sandbox;
4. commit and persist the profile only if its generation is still current;
5. dispose any prepared state produced by a superseded generation;
6. update status and coverage notifications; and
7. if preparation failed, keep the selected profile active but Bash blocked (or
   visibly warn only when configured).

Serialize activation commits or use the generation check above so overlapping
profile commands cannot complete out of order and install stale state. Do not
silently roll back to a different, potentially weaker profile and do not allow
commands under the old sandbox while the new profile is active.

Session restore and directory/subagent-selected profiles perform the same eager
resolution during `session_start`.

### 7.5 Explainability and steering

Add `/sandbox` to show:

- active profile and sandbox state;
- backend/prerequisite status;
- effective writable literals/subpaths;
- network allow/deny;
- effective subagent scope;
- prominent `waivedRestrictions`, followed by `uncoveredRestrictions`,
  `untranslatedAllows`, and summarized `noKernelMeaning`;
- effective Bash tool provenance; and
- warn-mode fallback, if any.

Never print generated backend policy, file contents, or environment values.

When sandboxing is active, `before_agent_start` appends a short note generated
from the resolved `SandboxSpec`, for example:

> Bash commands run in a kernel sandbox. Writable locations: `<derived>`. Other
> writes fail with “Operation not permitted.” Bash network access is denied.
> Dedicated file tools are permission-gated but are not inside this process
> sandbox. Kernel waivers: `<explicit profile waivers, when nonempty>`.

Because it is generated from the effective spec on every turn, profile switches
cannot leave stale guidance.

Optionally, `tool_result` can recognize backend denial signatures exported
through `PreparedSandbox` and append one concise steering line with the effective
writable roots. Keep this optional until real backend output proves signatures
stable enough to avoid false positives.

Use a separate sandbox status key or append a lock to the profile status:

- active: `sandbox: <backend> 🔒`;
- active with waivers: yellow `sandbox: <backend> 🔒 ⚠ <n> waived`;
- blocked: `sandbox: blocked`;
- warn fallback: yellow `sandbox: off` plus a one-time notification; and
- no sandbox: clear the sandbox status.

## 8. Failure and coverage behavior

| Condition                                              | Behavior                                                                    |
| ------------------------------------------------------ | --------------------------------------------------------------------------- |
| Active profile has no sandbox or `sandbox: false`      | Existing gate/local Bash behavior                                           |
| Invalid profile sandbox schema or subagent profile     | Existing invalid-permissions fail-closed path; user Bash also exits 126     |
| Explicit valid protected-path waiver                   | Active; gate-only restriction reported under `waivedRestrictions`           |
| Backend unsupported, missing, or initialization fails  | `onUnavailable`; default block                                              |
| Compiler/backend cannot enforce a required restriction | Unavailable; default block with coverage reason                             |
| Compiler/backend cannot express an allow               | Active but tighter; report under `untranslatedAllows`                       |
| Kernel denies an operation                             | Command fails naturally; optional steering                                  |
| Profile changes                                        | Old prepared artifact becomes unusable immediately; target resolves eagerly |
| Subagent scopes are unsupported by backend/compiler    | Block; never approximate or ignore                                          |
| Competing Bash override owns the active tool           | Block sandboxed Bash calls                                                  |
| Non-interactive mode                                   | Same sandbox behavior; no prompt is required                                |
| Session shutdown/reload                                | Dispose backend and clear all effective-state caches                        |

Availability and coverage notifications are distinct:

- availability says the requested sandbox is not running; and
- coverage says which policy construct could not be represented, which allow
  remains intentionally tighter, and which restriction the profile explicitly
  waived from kernel enforcement.

Do not emit noisy coverage for command rules or `ask` in general. Surface only
actionable restrictions and path allows that explain real EPERM behavior.

## 9. Testing strategy

Favor behavioral tests at the package boundary. Keep unit tests for pure,
exhaustive compiler/schema logic; do not prove runtime behavior with mocks.

### 9.1 Pure unit tests

- TypeBox schema acceptance/rejection and `sandbox: false` composition.
- Path normalization, `~`, canonical roots, and hostile input rejection.
- Specificity-aware compiler primitives and supported pattern classification.
- Directional coverage: missing restrictions block; missing allows remain tight.
- Broad allow plus `ask` carve-out plus a more-specific allowed descendant.
- Protected deny/allow exception compilation, including that a protected allow
  never grants an ordinary write.
- Kernel-waiver validation preserves exact pattern strings, rejects unknown
  denies, enforces `.git` by default, and reports valid waivers separately.
- Bash-context filtering: edit/write-only rules never widen Bash.
- Subagent scope intersection never widens profile/config writes.

### 9.2 Behavioral extension integration tests

Extend `integrationTests/support/extensionHarness.ts` to execute registered
tools and model `sourceInfo`, `user_bash`, asynchronous resolution, and
shutdown.

Through the extension's public behavior, cover:

- a profile without sandbox leaves Bash behavior unchanged;
- a sandboxed profile overrides Bash but retains built-in input/result shapes;
- gate deny happens before sandbox execution;
- gate allow/approved ask reaches prepared operations exactly once;
- blocked resolution never invokes unsandboxed local operations;
- invalid profile configuration and invalid `PI_SUBAGENT_PROFILE` make
  `user_bash` return exit 126 even though loading fell back to
  `genericPolicyConfig`;
- explicit warn fallback does invoke local operations and emits persistent
  warning UI;
- `/profile` immediately changes the effective sandbox and never reuses the old
  broader artifact;
- overlapping profile activations cannot commit out of order, and superseded
  prepared states are disposed;
- restored, directory-selected, and `PI_SUBAGENT_PROFILE` profiles resolve the
  correct sandbox;
- subagent scopes constrain an implicit child-process write;
- competing Bash ownership blocks execution;
- `user_bash` follows the same active/blocked/warn resolution;
- an explicit `.git` waiver removes only its named kernel restrictions while
  direct `.git` operands remain blocked by the gate; and
- `/sandbox`, prompt guidance, status, and coverage prominently distinguish
  explicit waivers from automatic translation gaps.

Use a fake backend at the `SandboxBackend` boundary for deterministic extension
integration. Do not mock the policy evaluator or compiler in tests that assert
policy-to-sandbox behavior.

### 9.3 Real OS-backed acceptance tests

Run executable acceptance tests on both macOS and Linux for the selected
backend implementation:

- allowed write succeeds;
- write outside derived roots fails;
- a broad write allow is narrowed by an `ask` region while a more-specific
  allowed descendant reopens correctly;
- a more-specific/protected deny beats a broad write allow;
- protected read deny and allow exception behave correctly;
- `.git` is kernel-denied by default, while an explicit exact waiver restores
  ordinary Git behavior without changing the permission gate;
- read-only literal write carve-outs work while the rest of cwd remains
  read-only;
- a package script/grandchild cannot write outside the effective roots;
- `PI_SUBAGENT_PERMISSIBLE_GLOBS=src/auth,tests/auth` blocks an implicit write
  to `src/billing`;
- network allow succeeds and network deny fails;
- env, streaming output, cancellation, timeout, and process-tree termination
  match local Bash behavior;
- symlink traversal cannot escape a permitted root; and
- profile re-preparation does not leak the previous profile's permissions.

A skipped acceptance test must print the missing prerequisite and must not count
as backend verification. At least one macOS and one Linux CI/manual release job
must pass before enabling sandboxing in shipped profiles.

## 10. Implementation sequence

1. **Backend contract spike:** compare exact-pinned sandbox-runtime with thin
   Seatbelt/bwrap adapters; record the choice in executable contract tests and
   implementation comments.
2. **Profile schema:** add `SandboxConfig | false`, composition semantics,
   generated schema coverage, and examples.
3. **Shared subagent scopes:** extract current
   `PI_SUBAGENT_PERMISSIBLE_GLOBS` parsing without behavior changes.
4. **Compiler:** add `SandboxSpec`, current-policy translation, specificity and
   context handling, directional coverage, protected paths, and subagent
   intersection.
5. **Backend:** implement the selected private adapter(s), validation,
   operations, cache keys, and cleanup.
6. **Harness:** add tool registration/execution, provenance, `user_bash`, and
   async lifecycle support.
7. **Extension wiring:** register the Bash override, integrate all profile
   activation paths, enforce ownership/fail-closed states, and add `/sandbox`,
   prompt guidance, and status.
8. **Behavioral and OS acceptance tests:** prove end-to-end profile switching,
   child-process containment, network, symlinks, and failure modes.
9. **Documentation and opt-in rollout:** update README with schema, examples,
   prerequisites, coverage semantics, warn mode, and the Bash-only boundary.
10. **Shipped-profile decision:** only after macOS/Linux evidence, decide
    whether and how to enable sandboxing in portable built-ins.

Run after every implementation slice:

```sh
npm run check:all
npm test
```

## 11. Completion criteria

The work is complete when:

- the active profile is the single source of truth for both gate and sandbox
  posture;
- every approved effective `bash` call in a sandboxed profile executes through
  a prepared OS backend;
- `!`/`!!` use the same resolution under documented extension-composition
  assumptions;
- the compiler derives current Bash writes and protected reads/writes without
  stale policy fields or ordering assumptions;
- unrepresentable restrictions never silently widen the kernel boundary;
- unrepresentable allows fail tight and are explainable;
- profile switches cannot execute under a stale broader artifact;
- subagent scopes always narrow and cannot be bypassed by configuration;
- network allow/deny is enforced by real OS tests;
- disabled/unsandboxed profiles preserve existing behavior;
- all static checks, integration tests, and macOS/Linux acceptance tests pass;
  and
- README distinguishes Bash process containment from whole-process isolation.

## 12. Deferred hardening

- Domain-level network allowlists after portable backend semantics are proven.
- Dynamic sandbox expansion for explicitly approved `ask` paths.
- A system-read allowlist rather than read-all plus protected denies.
- Process-aware `.git` protection, or read-only `.git` treatment for profiles
  that do not require Git mutation, without breaking approved Git workflows.
- Sandboxed helper processes for dedicated file tools. This adds a process
  spawn and serialization to the hottest tools for less security benefit than
  containing arbitrary Bash.
- Full built-in routing through Gondolin or whole-process container/VM modes for
  users who need stronger isolation than this extension can provide.
