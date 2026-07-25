# Sandbox Plan: Bash Containment for pi-permissions (Option A)

**Status:** plan — not yet implemented
**Date:** 2026-07-21

Add optional OS-level sandboxing to `pi-permissions` so that every bash command
that passes the permission gate _also_ runs inside a kernel-enforced sandbox.
Gate first (UX and steering), sandbox second (containment when the gate is
wrong). macOS/Seatbelt first; a backend seam leaves room for Linux/bwrap later.

This plan implements **Option A** from the design discussion: per-command
sandbox wrapping via **tool override + `spawnHook`**, plus **`user_bash`
interception** so the user's own `!` commands get the same treatment.

---

## 1. Goals and non-goals

### Goals

- Every bash tool call that the gate approves (via `allow` or a confirmed `ask`)
  executes under `sandbox-exec` with a per-profile Seatbelt profile.
- User `!` / `!!` commands (`user_bash` event) are wrapped identically when the
  active profile configures a sandbox.
- Sandbox posture is **per profile**, is available to both shipped and
  user-owned JSONC profiles, and switches correctly on `/profile` at runtime,
  like every other part of this package.
- Fail closed: if a profile declares a sandbox but the backend is unavailable,
  bash is blocked with a clear reason (unless the profile explicitly opts into
  `warn` mode).
- Zero changes to pi core. Everything lives in this package.

### Non-goals (v1)

- Sandboxing the in-process file tools (`read`, `edit`, `write`, `grep`,
  `find`, `ls`). See §10 for why they are a smaller attack vector and what the
  future options are.
- Linux/Windows backends. The backend abstraction is designed for them, but
  only Seatbelt (macOS) is implemented.
- `autoAllowIfSandboxed` (auto-approving `ask` commands because they are
  contained). Deliberately excluded: it converts the sandbox from backstop to
  primary boundary. Can be revisited as an opt-in per-profile flag later.
- A **full** rule→sandbox compiler. The sandbox profile is _derived_ from the
  active policy where derivation is provably sound (§5.1, §6), but command
  rules and `ask` decisions have no filesystem-sandbox meaning, and exotic
  globs are skipped rather than approximated. The translator is partial and
  fail-tight by design; hand-authored `writablePaths`/`denyReadPaths` remain
  as additive escape hatches for what translation cannot express.

---

## 2. Design constraints discovered (from pi docs + installed package)

Verified against the installed
`@earendil-works/pi-coding-agent` (`dist/core/tools/bash.d.ts`,
`docs/extensions.md`, `docs/containerization.md`,
`examples/extensions/gondolin/index.ts`):

1. **Built-in tools are overridable.** `pi.registerTool()` with the same name
   replaces the built-in. The Gondolin example overrides all seven built-ins
   this way.
2. **Tool factories are public API.** `createBashTool(cwd, options)` returns
   the built-in bash tool definition; options include:
   ```ts
   interface BashSpawnContext {
     command: string;
     cwd: string;
     env: NodeJS.ProcessEnv;
   }
   type BashSpawnHook = (context: BashSpawnContext) => BashSpawnContext;
   interface BashToolOptions {
     operations?;
     commandPrefix?;
     shellPath?;
     spawnHook?;
   }
   ```
   `spawnHook` runs at spawn time and may rewrite command/cwd/env. This is the
   wrapping seam — it avoids mutating `event.input.command` inside `tool_call`
   and keeps quoting logic in exactly one place.
3. **`createLocalBashOperations()`** is exported for wrapping pi's standard
   local shell backend, and the **`user_bash`** event lets an extension return
   custom `operations` (or a full result) for `!` commands. Returning
   `undefined` keeps default behavior.
4. **Pi's own stance** (`docs/security.md`): pi ships no built-in sandbox;
   "real isolation needs to come from the operating system or a
   virtualization/container boundary." This plan adds the OS boundary for bash
   only, and documents the remainder honestly.
5. **Tool overrides are load-order-sensitive.** Another extension can replace
   `bash` after this package and bypass its spawn hook. When a sandbox is active,
   `tool_call` must verify through `pi.getAllTools()` that this package still
   owns the effective `bash` definition; if not, fail closed with an override
   conflict instead of assuming containment. Document that arbitrary custom
   extension tools which spawn processes are outside this bash-only boundary.

---

## 3. Design overview

```
LLM/user calls bash
        │
        ▼
tool_call handler (existing gate — UNCHANGED)
  • ripgrep glob validation/injection
  • gateBash(): read-command validation, command rules,
    bashPathReferences, bashOutputRedirections, ask prompts,
    guidance/alternatives on deny
        │ approved
        ▼
bash tool executes (overridden registration)
  • spawnHook fires with { command, cwd, env }
  • if active profile has sandbox config and backend available:
      profile policy + PI_SUBAGENT_WRITE_GLOBS → effective sandbox spec
      command → sandbox-exec -p '<quoted profile>' /bin/sh -c '<quoted command>'
    else:
      command unchanged (or blocked, per onUnavailable)
        │
        ▼
kernel enforces Seatbelt profile on the process tree:
  read-only outside writable roots, deny-listed reads, network policy
```

Profile switching needs no re-registration: the override is registered once at
load; the `spawnHook` closure reads the extension's current `activeProfile`
state at execution time.

---

## 4. Configuration schema

Extend `ProfilePolicy` in `modules/policyHelpers.ts`:

```ts
export type SandboxConfig = {
  /** Sandbox backend. "bwrap" reserved for a future Linux backend. */
  backend: "seatbelt";
  /**
   * Extra writable roots, ADDITIVE to the translated writable set (§6).
   * /tmp (resolved) and os.tmpdir() are baseline writable scratch roots,
   * still subject to mandatory protected-path write denies. When nothing
   * translates from edit/write ∪ bashOutputRedirections allow rules:
   * startupCwd is added only if the profile declares no edit/write rules
   * at all and no runtime subagent write scope is present; a profile whose
   * rules allow nothing derives a /tmp-only writable set — never a
   * startupCwd fallback — so an all-deny rule
   * layer cannot be re-widened by the default (fail-tight; see the
   * socrates bullet in §6). Supports ~ expansion, like other policy paths.
   */
  writablePaths?: string[];
  /**
   * Literal paths the sandbox must not read, ADDITIVE to the translated
   * protectedPathPatterns (§6). For things the translator cannot express.
   * Examples: "~/.ssh", "~/.aws", "~/.gnupg", "~/Library/Keychains".
   */
  denyReadPaths?: string[];
  /** Allow outbound network inside the sandbox. Default: true. */
  allowNetwork?: boolean;
  /**
   * Behavior when the backend is unavailable (non-macOS, sandbox-exec
   * missing, minimal detection fails, or the rendered effective profile fails
   * validation).
   * Default: "block" (fail closed, matching this package's ask-blocks-when-
   * non-interactive philosophy). "warn" runs unsandboxed with a status hint.
   */
  onUnavailable?: "block" | "warn";
};

export type ProfilePolicy = {
  // ...existing fields...
  sandbox?: SandboxConfig;
};
```

Typebox: add a `sandboxSchema` (optional, `additionalProperties: false`) to
`profileSchema`; `assertPolicyConfig` picks it up automatically.

Sandbox is **opt-in in v1**. Do not add it to the portable shipped profiles:
that would make installing this otherwise cross-platform package block every
bash command on Linux and Windows under the default `onUnavailable: "block"`
behavior. Document this recommended macOS user configuration instead:

| Profile     | sandbox                     | allowNetwork | Notes                                                                                        |
| ----------- | --------------------------- | ------------ | -------------------------------------------------------------------------------------------- |
| `default`   | seatbelt, derived writes    | `true`       | network works; package-manager caches outside derived roots may need explicit writable paths |
| `worker`    | inherit default             | `true`       | `PI_SUBAGENT_WRITE_GLOBS` further narrows project writes                                     |
| `read-only` | seatbelt, derived writes    | `false`      | cwd is read-only except `handoff.md` and `progress.md`; `/tmp` remains scratch               |
| `socrates`  | seatbelt, derived writes    | `false`      | `/tmp` only because the profile's edit/write rules allow nothing                             |
| others      | inherit via `extendProfile` | —            | overrides replace the inherited `sandbox` object wholesale                                   |

Users can add `sandbox` to built-in profiles through an extending profile in
`~/.pi/agent/permissions/profiles.jsonc`, then select that profile or make it
the configured default. Enabling sandboxing in shipped profiles is a separate,
explicit rollout decision after a Linux backend exists (or as a documented
macOS-only breaking change).

`extendProfile` already spreads non-`tools` fields, so `sandbox` inherits
naturally; a derived profile replaces it by providing its own. Both
`profileSchema` (resolved policies) and `profileConfigProfileSchema` (JSONC
profile definitions) must include the same `sandboxSchema`; the generated
`schemas/profiles.schema.json` remains the user-facing schema artifact.

### 4.1 Runtime subagent write constraints

`PI_SUBAGENT_WRITE_GLOBS` is a runtime constraint, not profile configuration.
When present, its normalized comma-separated scopes cap the sandbox's project
writable set in addition to the gate-layer checks already implemented by
`pi-permissions`:

- Derive writable paths from the profile's `edit`/`write`, redirection allows,
  and `sandbox.writablePaths` as usual.
- Intersect that derived set with the declared subagent scopes. A scope may
  narrow a broad profile root, but can never widen what the profile permits.
- Keep resolved `/tmp` and `os.tmpdir()` as the sandbox's documented baseline
  scratch exception. Subagent scopes constrain project/host writes, not sandbox
  runtime scratch space; mandatory protected-path denies still carve sensitive
  names out of scratch roots.
- If no write-scope variable is present, preserve ordinary profile behavior.
  If it is present but empty or no scope can be translated safely, derive no
  project writable roots (fail tight).
- Protected read rules and network posture remain profile-derived and are not
  weakened by write scopes.

Parsing and normalization must be shared with the existing gate implementation
rather than independently reimplemented in the sandbox. Move the current scope
parser/rule construction out of `extensions/permissions.ts` into the flat
`modules/subagentWriteScopes.ts` helper. It exposes normalized scopes separately
from conversion to gate `Rule[]`: the extension consumes both, while
`sandbox.lib` receives only normalized scopes through `SandboxState`. This is a
single-purpose shared module, not a second self-contained library, so it does
not acquire a `.lib/` directory or public `index.ts`. Commas in path names
remain unsupported because the producer's environment format is comma-delimited.

This closes an important gap for worker subprocesses: the gate catches explicit
out-of-scope Bash path tokens, while Seatbelt prevents implicit writes from
package scripts, compilers, and child processes whose target paths never appear
in the original command.

---

## 5. Components

New module directory `modules/sandbox.lib/` — a self-contained lib per
`docs/.lib_definition.md`. Two dependency-cruiser boundaries apply: the
existing `extensions/` imports `modules/`, never the reverse; and the
lib-boundary rules (`lib-public-entrypoint-only`, `lib-no-index-self-import`)
make the §5.4 seam machine-enforced — outside code can only import
`sandbox.lib/index.ts`, never a backend module directly. The backend seam is the **`SandboxSpec` IR** (§5.1), not a
directory-per-backend layout: the translator is backend-neutral, each
backend is one sibling module like `seatbelt.ts`, and `index.ts` dispatches
on `config.backend` (a switch, not a registry — extract a `SandboxBackend`
interface from the two concrete implementations when a second backend
exists, not before):

### 5.1 `modules/sandbox.lib/translate.ts` — policy → backend-neutral sandbox spec

Pure function, matching the package's existing derivation style
(`withProtectedPathPatterns`, `searchPolicy.ts`). **No Seatbelt types in its
signature** — the spec is what any filesystem-sandbox backend (Seatbelt
today, bwrap later) needs to know:

```ts
export type SandboxSpec = {
  // Restriction-direction patterns:
  denyReadPatterns: string[];   // protectedPathPatterns ∪ config.denyReadPaths
  allowReadPatterns: string[];  // protectedPathExceptions, ordered after denies
  // Ordered write policy, preserving both allow and deny decisions. A union of
  // allow rules is UNSOUND: later denies (including generated protected-path
  // denies) would be discarded and sensitive paths under an allowed cwd would
  // become writable. The translator conservatively normalizes the effective
  // union of edit, write, and redirection permissions; any region whose union
  // cannot be proven is omitted and reported as an untranslated allow.
  writeRules: Array<{
    decision: "allow" | "deny";
    pattern: string;
    source: "edit" | "write" | "redirection" | "config" | "scratch";
  }>;
  // Concrete effective allows are also materialized for prompt/status output
  // and runtime-scope intersection. They are a summary, not the renderer's
  // source of truth.
  writable: { literals: string[]; subpaths: string[] };
  candidateWritablePatterns: string[];
  allowNetwork: boolean;
  // Gate semantics with no filesystem-sandbox meaning (command rules, ask
  // decisions, redirection denies, bash path-reference rules) — true for
  // every backend, so classified here. Informational only; never notified.
  noSandboxMeaning: Array<{ construct: string; pattern: string }>;
};

translatePolicy(policy: ProfilePolicy, ctx: {
  startupCwd: string;
  writeScopes?: string[];
}): SandboxSpec
```

What the spec deliberately does NOT decide is _expressibility_: whether a
given glob can be enforced depends on the backend (Seatbelt has regexes;
bwrap has only literal bind-mounts — even `**/.env*` deny-reads would be
inexpressible there). Direction is known here and travels with each bucket;
the backend's expressibility filter (§5.3) assigns patterns it cannot
express to `uncovered` (restriction buckets) or `untranslatedAllows` (allow
buckets) and assembles the coverage report.

The write normalizer must preserve last-match policy behavior without claiming
that a naïve concatenation of the `edit`, `write`, and redirection rule lists is
their union. V1 may recognize the concrete shapes used by the shipped profiles
(cwd/subpath allows, literal-file carve-outs, protected-path denies, and `/tmp`)
and fail tight for other combinations. `config.writablePaths` is an explicit
additive allow, but generated protected-path write denies are appended after it
and remain mandatory. Runtime write scopes then intersect the effective project
allows; they never reorder or remove denies.

Report semantics (fail-tight rules and the translation table in §6):
`uncovered` holds only _actionable_ gaps — restrictions the author believes
are kernel-enforced but are not. This includes an unexpressible write deny;
silently dropping a deny would widen access. `untranslatedAllows` is the safe
direction: the sandbox EPERMs what the gate permits — a UX rough edge, listed
but never notified. `noSandboxMeaning` reflects that the sandbox narrows what
the gate permits; it does not mirror gate semantics. (The default profile ships
~130 bash rules; reporting those as uncovered would make the report a constant,
ignorable fixture.)

Surfacing:

- `/sandbox` debug command: the full report (all three lists) on demand.
- Proactive notify at the two moments the active `uncovered` set can change
  — session start (policy may have been edited since the last session) and
  `/profile` switch — and only when it is non-empty. Stateless: no
  last-notified set to track. The `noSandboxMeaning` split keeps `uncovered`
  empty in the steady state, so a non-empty notify is always actionable; a
  persistent gap nags until the author makes it translate (fix the glob, or
  express the path via `config.denyReadPaths`/`writablePaths`).
- Warn mode's session-start notify is about _availability_, not coverage
  (`sandbox backend unavailable; running unsandboxed` — §5.4). Keep the two
  messages separate: coverage matters when the sandbox is on, availability
  when it is off.

### 5.2 `modules/sandbox.lib/shell.ts` — quoting (backend-shared)

- `shellQuote(value: string) → string` — single-quote escaping:
  `value.replaceAll("'", "'\\''")` wrapped in `'…'`. The backslash must be
  present in the resulting string; the superficially similar template literal
  `` `'\''` `` evaluates to three quotes and is incorrect. This is **the**
  security-critical function; see §7. Shared by any backend that wraps via
  `sh -c` (bwrap is `bwrap --bind … -- /bin/sh -c <quoted>` — the same
  two-parse problem as `sandbox-exec`), so it lives outside the Seatbelt
  module.

### 5.3 `modules/sandbox.lib/seatbelt.ts` — expressibility, rendering, detection, wrapping

- `filterExpressible(spec: SandboxSpec) → { denyRead: SeatbeltRule[];
allowRead: SeatbeltRule[]; writeRules: SeatbeltRule[]; uncovered;
untranslatedAllows }` —
  the proven-equivalent-subset check: globs Seatbelt's regex flavor can
  provably express translate; anything else is skipped and reported by the
  spec's direction tags (restriction buckets → `uncovered`, allow buckets →
  `untranslatedAllows`; v1 expresses no `candidateWritablePatterns`). Never
  approximated.
- `renderSeatbeltProfile(filtered, ctx: { startupCwd, home, tmpdir }) → string`
  — builds the inline Seatbelt profile text from the base template (§6),
  resolving `~`, symlinks (`/tmp` → `/private/tmp`), and `denyReadPaths`.
  Seatbelt string and regex literals require dedicated escaping; no path or
  glob may be interpolated directly into Lisp source.
- `detectSeatbelt(): { available: boolean; reason?: string }` — platform is
  `darwin`, `/usr/bin/sandbox-exec` exists, and a minimal smoke test via
  `node:child_process.execFileSync` exits 0.
- `validateSeatbeltProfile(profile: string)` — smoke-tests **each rendered
  profile**, not only a minimal backend profile. A minimal detection probe
  cannot catch syntax/escaping errors introduced by translated policy data.
- `wrapCommand(command, profile) → string` —
  `sandbox-exec -p <shellQuote(profile)> /bin/sh -c <shellQuote(command)>`.
  Use inline `-p` rather than a profile file beneath `/tmp`: because `/tmp` is
  intentionally writable, a sandboxed command could replace a cached `.sb`
  file and grant a later command a forged profile. Validate practical command
  length during implementation; if inline profiles exceed the host limit,
  switch the bash override to argv-based `BashOperations` or use a profile
  descriptor outside every allowed write root—never a writable cached file.

The Seatbelt template lives as a TS template literal in this module — not as
shipped asset files — so it is typechecked, unit-tested, and needs no
`package.json` `files` changes. Glob → Seatbelt-regex reuses the semantics
of `globToRegExpSource` (pathPolicy.ts), but only for patterns proven
equivalent in Seatbelt's regex flavor; anything else is reported by
direction, never approximated.

### 5.4 `modules/sandbox.lib/index.ts` — dispatch, caching, resolution, spawn hook

- Backend dispatch on `config.backend`: a `switch` selecting the backend
  module (`seatbelt` only in v1; `bwrap` remains a reserved config value).
  Detection results cached per session.
- Effective-state cache: cache the translated spec, coverage report, validated
  rendered Seatbelt profile **string**, and resolution per profile policy +
  normalized runtime write scopes. Including scopes in the key prevents a
  broad state from being reused for a constrained subagent. Do not write the
  Seatbelt profile into a scratch directory (§5.3). Backend detection is cached
  per extension instance; rendered-profile validation is cached per effective
  state. Clear all caches on `session_shutdown`/reload.
- Resolve eagerly at `session_start` and immediately after every profile switch,
  because coverage notifications and status need the new resolution then—not
  only on the first later bash call. The spawn hook still resolves defensively
  from current state so runtime switching cannot use stale state.

The module's public API — and the only thing the extension layer (§5.5)
consumes, so wiring never names a backend (machine-enforced by the
lib-boundary dependency-cruiser rules, §5 intro):

```ts
export type SandboxState = {
  profile: string;
  policy: ProfilePolicy;
  startupCwd: string;
  writeScopes?: string[]; // normalized PI_SUBAGENT_WRITE_GLOBS
};
export type CoverageReport = {
  uncovered: Array<{ construct: string; pattern: string; reason: string }>;
  untranslatedAllows: Array<{ construct: string; pattern: string; reason: string }>;
  noSandboxMeaning: Array<{ construct: string; pattern: string }>;
};
export type SandboxResolution =
  | { kind: "none" }        // active profile declares no sandbox
  | { kind: "unavailable"; reason: string; onUnavailable: "block" | "warn" }
  | { kind: "active"; spec: SandboxSpec; report: CoverageReport; wrap(command: string): string };
  // `wrap` closes over the backend's validated rendered artifact (inline
  // profile text today; potentially bwrap argv later). Callers never learn
  // which backend answered.

resolveSandbox(state: SandboxState): SandboxResolution  // uses the caches above
```

- `createSandboxSpawnHook(getState: () => SandboxState) : BashSpawnHook`
  — the closure handed to `createBashTool`. Decision order inside the hook
  is the four `SandboxResolution` cases:
  1. `none` → return context unchanged.
  2. `active` → return `{ ...ctx, command: res.wrap(ctx.command) }`.
  3. `unavailable` + `"block"` (default) → return a command that fails
     loudly and explains why, e.g.
     `echo 'pi-permissions: sandbox backend unavailable; bash blocked by active profile' >&2; exit 126`
     (a spawned-command failure surfaces naturally in the tool result without
     touching the gate). Quote this fixed diagnostic with `shellQuote`; do not
     interpolate backend error text into executable shell source.
  4. `unavailable` + `"warn"` → unchanged command; the extension also sets a
     status-line hint (§5.5 item 5) and fires a one-time session-start
     notify: `sandbox backend unavailable; running unsandboxed`. Warn's only
     standing signal is otherwise a yellow hint that is easy to miss
     mid-session — the notify makes the quiet failure loud. Coverage
     reporting stays out of this message (§5.1).

### 5.5 `extensions/permissions.ts` — wiring

1. At load, after `assertPolicyConfig`:
   ```ts
   // Shared by the spawn hook and the user_bash handler — one state shape,
   // one decision path (§5.4).
   const sandboxState = (): SandboxState => ({
     profile: activeProfile,
     policy: withProtectedPathPatterns(activePolicy(activeProfile)),
     startupCwd,
     writeScopes: subagentWriteScopes,
   });

   pi.registerTool({
     ...createBashTool(startupCwd, {
       spawnHook: createSandboxSpawnHook(sandboxState),
     }),
   });
   ```
   (Spread pattern follows the Gondolin example; no `execute` override needed
   since behavior comes from options.) Record enough source identity to verify
   on every sandboxed `tool_call` that this remains the effective `bash`
   registration (§2 item 5); an override conflict blocks before execution.
2. `pi.on("user_bash", ...)` — resolves through the same `SandboxResolution`
   cases as the spawn hook (§5.4), so the two call sites cannot drift:
   ```ts
   const local = createLocalBashOperations();
   pi.on("user_bash", () => {
     const res = resolveSandbox(sandboxState());
     switch (res.kind) {
       case "none":
         return undefined; // default behavior
       case "active":
         return {
           operations: {
             exec: (command, cwd, options) =>
               local.exec(res.wrap(command), cwd, options),
           },
         };
       case "unavailable":
         return res.onUnavailable === "warn" ? undefined : blockedResult();
     }
   });
   ```
   Note: `user_bash` commands are the _user's own_ — gating stays unchanged;
   this only adds containment. `blockedResult()` returns
   `{ result: { output: "...blocked...", exitCode: 126, cancelled: false, truncated: false } }`.
3. `before_agent_start`: when the active profile has a sandbox, append a
   short note to the system prompt _generated from the translated
   `SandboxSpec.writable` set_ (already cached per effective state, §5.4) — never a
   hardcoded root list. A static "working directory and /tmp" sentence is
   wrong in both directions: it over-promises for `read-only`/`socrates`
   (whose cwd is read-only — the model would misread the resulting EPERMs as
   flakiness, the exact failure this note exists to prevent) and
   under-promises for profiles with `writablePaths` or broader edit/write
   rules. Rendered from the spec, the note cannot drift from enforcement —
   same philosophy as §6's "no hand-maintained copies of policy" — and
   because `before_agent_start` fires per turn, `/profile` switches are
   handled for free. Shape:

   > Bash commands run inside a kernel sandbox. Writable locations:
   > <derived roots>. Writes anywhere else fail with "Operation not
   > permitted" — use the write/edit tools for project files.

   `<derived roots>` renders `writable.subpaths` as roots, collapses
   `writable.literals` to "specific files in <dir>" (read-only renders as
   "Writable locations: handoff.md, progress.md, /tmp"), merges the two
   macOS temp roots into "/tmp and the system temp dir", and caps the list
   when the writable set is large. Optionally append one short read-side clause ("some paths are read-denied at the kernel level") so a failed `cat .env` does not look like a missing file.

4. `tool_result` (small, optional in v1): if a bash result's output matches
   the sandbox's denial signatures, append one line of steering ("blocked
   by sandbox; allowed writes are <roots>" — the same derived roots as item
   3). The baseline signature is kernel EPERM (`Operation not permitted`),
   which is backend-neutral (a bwrap denial surfaces the same syscall
   error); wrapper-specific stderr is exported by the backend module
   (Seatbelt: `sandbox-exec: .* deny`) and consumed via `index.ts`, never
   hardcoded here. Low cost, consistent with the package's
   teach-don't-just-block UX.
5. Status line: when sandbox is active, append to the existing profile status
   (e.g. `profile: default ⛨`); when configured-but-unavailable in `warn`
   mode, show a yellow `sandbox: off` hint.

---

## 6. Seatbelt profile design

The profile is **derived from the active policy** by `translate.ts` into a
`SandboxSpec`, filtered for expressibility and rendered by `seatbelt.ts`
(per profile; `${...}` substituted at render):

```lisp
(version 1)
(deny default)

;; Process basics: spawn, exec, signal own children, sysctl reads, TTY.
(allow process-exec process-fork signal sysctl-read mach-lookup file-ioctl)

;; Minimal runtime devices required by ordinary CLI programs. Use exact
;; literals only; do not allow the whole /dev subtree.
(allow file-read* file-write* (literal "/dev/null"))
(allow file-read* (literal "/dev/zero") (literal "/dev/random") (literal "/dev/urandom"))

;; Read everything by default...
(allow file-read*)

;; ...except the translated deny-reads, then the translated exception allows.
${denyReadRules}                      ;; from protectedPathPatterns + config.denyReadPaths
${allowReadRules}                     ;; from protectedPathExceptions (last-match-wins,
                                      ;;  mirroring protectedExceptionRules ordering)

;; Writes: only the translated writable set.
${writeRules}                         ;; ordered effective allow + deny rules from
                                      ;; edit/write/redirection/config, including
                                      ;; protected-path write denies; project allows
                                      ;; intersect PI_SUBAGENT_WRITE_GLOBS, then
                                      ;; /tmp scratch is added without removing denies

${networkRule}                        ;; (allow network*) OR nothing (denied by default)
```

Translation table — the ✅/❌ statuses are the **Seatbelt backend's
expressibility column**; a future bwrap backend gets its own column (no
regex → even basename globs like `**/.env*` would be ❌ there, which the
`uncovered` notify then surfaces by construction). Fail-tight: anything not
listed as translatable is _reported_, never approximated — failed
restrictions land in `uncovered`, failed allows in `untranslatedAllows`,
gate semantics in `noSandboxMeaning`:

| Policy construct                                                 | Seatbelt translation                                                                                                                                                                                                                                                                                                                 | Status                                                                                         |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `protectedPathPatterns` basename globs (`**/.env*`)              | `(deny file-read* (regex ...))`                                                                                                                                                                                                                                                                                                      | ✅                                                                                             |
| Rooted/literal protected paths (`**/credentials.json`, `~/.ssh`) | deny-read subpath/literal                                                                                                                                                                                                                                                                                                            | ✅                                                                                             |
| `protectedPathExceptions` (`.env.template`)                      | backend-equivalent allow-read exception to the protected deny                                                                                                                                                                                                                                                                        | ✅ only after executable precedence tests prove equivalence                                    |
| edit/write ordered path rules                                    | conservative effective union across both tools; preserve allow carve-outs and later denies, including generated protected-path mutation denies                                                                                                                                                                                       | ✅ proven concrete patterns; failed allows → `untranslatedAllows`; failed denies → `uncovered` |
| `bashOutputRedirections` **allow** targets (`/tmp/**`)           | participate in the effective write union using the same relative-to-startup-cwd and last-match policy semantics                                                                                                                                                                                                                      | ✅ proven concrete patterns; others → `untranslatedAllows`                                     |
| `bashOutputRedirections` **deny** rules (`**` deny)              | none — the kernel cannot distinguish `> f` from `tee f` or `sed -i`; gating writes by mechanism is gate-layer UX only                                                                                                                                                                                                                | ❌ `noSandboxMeaning`                                                                          |
| `bashPathReferences` **allow** rules                             | none — read-intent allows: a bare path token carries no read/write distinction at the gate, but the kernel distinguishes operations, and reads are already default-allowed. Unioning them into writable would re-widen the write surface the sandbox exists to narrow (read-only's `*` path allow would make the whole cwd writable) | ❌ `noSandboxMeaning`                                                                          |
| `bashPathReferences` **deny** rules (`../**` deny)               | the write half is inherited from the writable derivation (default-deny); the read half would require a per-profile read allow-list (breaks system/toolchain reads), which v1's default-allow read model rejects. Express bash read-restrictions as `protectedPathPatterns` instead — those translate (above)                         | ❌ `noSandboxMeaning`                                                                          |
| `config.writablePaths` / `config.denyReadPaths`                  | additive literals before runtime scope capping; write scopes may narrow `writablePaths`, while deny-read paths remain additive                                                                                                                                                                                                       | ✅                                                                                             |
| `PI_SUBAGENT_WRITE_GLOBS`                                        | authoritative runtime cap on project writable literals/subpaths; intersect with all profile-derived writable roots, never union; unsupported scope globs fail tight and appear in `untranslatedAllows`                                                                                                                               | ✅ concrete paths/prefixes; others reported                                                    |
| bash command rules (`git push *`)                                | none — command semantics are invisible to a filesystem sandbox                                                                                                                                                                                                                                                                       | ❌ `noSandboxMeaning`                                                                          |
| `ask` decisions (any tool)                                       | none — the kernel cannot prompt; the sandbox only ever _narrows_ what `allow` permits                                                                                                                                                                                                                                                | ❌ `noSandboxMeaning`                                                                          |
| Globs outside the proven-equivalent subset                       | skipped, reported by direction — restriction globs → `uncovered`, allow globs → `untranslatedAllows`                                                                                                                                                                                                                                 | ❌                                                                                             |

Details that matter:

- **Rule semantics must be verified, not assumed:** before implementing the
  renderer, add a macOS executable test that probes overlapping
  allow/deny/allow rules for both literals and subpaths. Seatbelt's operation
  and filter precedence is the security boundary; do not rely on textual
  "last match wins" without evidence. `translate.ts` preserves package policy
  order, while `seatbelt.ts` is responsible for compiling it into equivalent
  Seatbelt precedence or marking the construct uncovered. The intended
  derivation is **base verdict + effective ordered rules**:
  the base rule carries the default decision (`allow file-read*` for reads,
  `deny default` for writes) and translated effective rules preserve policy
  outcomes, so mixed allow/deny postures survive translation (deny-reads follow
  `(allow file-read*)`; exception allows follow the denies; write allows
  follow the default deny). The same pattern extends to write-side
  carve-outs later (allow cwd, then deny `.git` after it — the Codex-style
  hardening below). Two common patterns do NOT fit: IAM-style
  explicit-deny-always-wins would break `protectedPathExceptions`, and
  first-match-wins (firewall-style) would invert policy order.
- **Path resolution:** resolve symlinks before rendering (`/tmp` →
  `/private/tmp`; macOS temp dirs live under `/var/folders/...`), expand `~`,
  and `path.realpathSync` the startup cwd. Unresolved symlinked roots silently
  mis-sandbox.
- **No hand-maintained copies of policy.** The `.env*` deny-read regex that
  an earlier draft hardcoded is instead _translated_ from the active profile's
  `protectedPathPatterns`. Those patterns must also produce write denies;
  translating them only on the read side would let a broad cwd write allow
  mutate files that the gate protects from mutation.
- **Derived writable example:** the `read-only` profile's edit/write rules
  (allow only `handoff.md` and `progress.md`) translate to a cwd that is
  read-only except those two literals — the kernel backstops the rule layer
  precisely, with no duplicated config.
- **Subagent intersection example:** the `worker` profile may derive the whole
  startup cwd as writable, but `PI_SUBAGENT_WRITE_GLOBS=src/auth,tests/auth`
  renders only those two subtrees (plus sandbox scratch directories) writable.
  A package script attempting to generate `src/billing/client.ts` receives
  EPERM even though that target never appeared in the Bash command. A scope
  cannot re-allow a path denied by the profile.
- **All-deny profiles stay tight:** socrates's edit/write rules allow
  nothing, so nothing translates — and the result must be /tmp-only, with no
  `startupCwd` fallback. Otherwise an all-deny rule layer gets a writable cwd
  at the kernel layer: socrates
  would be strictly weaker than `read-only` despite §4's "same as
  `read-only`" posture. Fail-tight means deriving nothing yields nothing.
- **`bashPathReferences` mostly does NOT translate, by design.** The gate
  sees path _tokens_ and cannot tell a read from a write; the kernel sees
  _operations_ and can — that distinction is the sandbox's whole value. So
  allows never widen writable, write-denies are inherited from the writable
  derivation, and read-denies beyond `protectedPathPatterns` are gate-only
  in v1: the kernel does not confine reads beyond the protected set, so
  read-only's "can only read inside the startup directory and /tmp" guidance
  is enforced by the gate alone. A per-profile read allow-list à la Codex is
  possible future hardening, at the cost of maintaining a system-reads
  allow-list.
- **Known rough edge:** an `ask`-approved bash write — or a write permitted
  by an allow rule whose pattern failed to translate (`untranslatedAllows`) —
  outside the translated writable set fails with EPERM (the gate said yes,
  the sandbox says no — approvals do not expand the sandbox, same trade Codex
  makes). Mitigated by the coverage report, the system-prompt note, and
  additive `writablePaths`. Codex v2's "request-permissions" flow (approvals
  that _do_ expand the sandbox) is future work.
- **Runtime compatibility:** a deny-default write profile needs exact baseline
  device access (for example `/dev/null`) and inherited stdout/stderr behavior,
  covered by executable smoke tests. Home-directory caches such as `~/.npm`
  remain read-only unless explicitly added to `writablePaths`; `allowNetwork`
  alone does not guarantee every package-manager workflow succeeds.
- **`.git`:** v1 leaves `.git` writable inside a writable cwd (the agent's
  normal workflow needs it). Codex-style read-only re-mounting of `.git`
  inside writable roots is a documented future hardening step.
- **Reference:** consult a currently available production Seatbelt generator
  during implementation (for example Codex's `codex-rs` macOS sandbox code).
  Do not encode a developer-specific absolute checkout path in the plan.

---

## 7. Command wrapping and escaping (critical)

The wrapped command is parsed by pi's shell first, then the inner
`/bin/sh -c` parses the original text. Correctness of `shellQuote` is the
security boundary between those two parses.

Rules:

- Only single-quote wrapping: `'` → `'\''`. Never double-quote wrapping
  (leaves `$()`, backticks, and `\` live for the outer shell).
- Both the inline profile and original command are shell-quoted. Never splice
  profile text, backend diagnostics, paths, or model-controlled text into the
  outer shell unquoted.
- Newlines in commands are legal inside single quotes — keep them literal.

Required unit tests (`modules/sandbox.lib/shell.test.ts`), each asserting the
_spawned_ command's behavior, not just string equality:

| Input                        | Must hold after two shell parses              |
| ---------------------------- | --------------------------------------------- |
| `echo 'hi'`                  | exact preservation                            |
| `echo "a 'b' c"`             | exact preservation                            |
| `echo $(touch /tmp/ESCAPED)` | substitution runs **inside** the sandbox only |
| `` echo `id` ``              | same                                          |
| `printf 'a\nb'`              | newlines intact                               |
| `echo $HOME`                 | expands inside sandbox (env passes through)   |
| `git log --format='%s'`      | quoting intact                                |

Plus property-style tests: for a corpus of nasty strings, `sh -c
<wrapped>` must behave identically to direct `sh -c <original>` (modulo
sandbox denials).

---

## 8. Failure modes

| Failure                                                                   | Behavior                                                                                                                                             |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backend unavailable (binary missing, wrong platform, or smoke test fails) | `onUnavailable`: default `block` (spawned command exits 126 with explanation); `warn` runs unsandboxed + status hint + one-time session-start notify |
| Rendered profile has a Seatbelt syntax/escaping error                     | caught by per-effective-state rendered-profile validation → same path as unavailable                                                                 |
| Sandboxed operation denied by kernel                                      | command fails with EPERM; optional `tool_result` steering appends the allowed roots (§5.5 item 4)                                                    |
| Profile switched at runtime                                               | switch handler eagerly resolves/report/statuses the new state; next spawn hook also reads it defensively                                             |
| Subagent write scopes present                                             | project writable roots are the fail-tight intersection of profile-derived writes and normalized scopes; `/tmp` remains scratch                       |
| Session ends                                                              | in-memory detection/effective-state caches cleared in `session_shutdown`; no writable profile artifact remains                                       |
| Non-interactive (`-p`, json/rpc)                                          | unchanged semantics: sandbox still applies (it is not a prompt); `block` mode just fails the command                                                 |

---

## 9. Testing plan

- **Unit (vitest, existing layout):**
  - `shellQuote`/`wrapCommand` corpus incl. §7 table (behavioral, via real
    `sh -c` on macOS dev machines; string-equality assertions elsewhere).
  - `renderSeatbeltProfile`: substitution, symlink resolution, `~` expansion,
    Seatbelt literal/regex escaping (quotes, backslashes, newlines, parentheses),
    precedence-equivalent deny/allow behavior, and network on/off.
  - `translatePolicy` (backend-neutral): redirect allows participate in the
    conservative effective write union; runtime write scopes intersect that set
    before the `/tmp` scratch exception is added; absent scopes preserve normal
    profile behavior, empty/untranslatable scopes produce no project writable
    roots, and scopes never widen profile permissions. All-deny edit/write
    profiles derive a /tmp-only writable set (no startupCwd widening);
    direction tags travel with each pattern bucket; command rules, ask
    decisions, redirect denies, and `bashPathReferences` rules land in
    `noSandboxMeaning`; `bashPathReferences` never widens writable
    (read-only's `*` path allow keeps cwd read-only).
  - `filterExpressible` (Seatbelt): proven-equivalent globs translate;
    non-concrete restriction globs and write denies → `uncovered`;
    non-concrete allows → `untranslatedAllows`; nothing is approximated.
  - Effective write derivation: later protected-path denies remain denied under
    a broad cwd allow; read-only literal carve-outs survive; edit/write union is
    proven rather than implemented as `allowRules(edit) ∪ allowRules(write)`.
  - `detectSeatbelt`: mock platform/availability for block/warn branches;
    validate every rendered profile independently from the minimal probe.
  - macOS-only executable tests establish the renderer's behavior for
    overlapping allow/deny/allow literals and subpaths, inherited stdout/stderr,
    and exact baseline devices (`/dev/null`, randomness) without a broad `/dev`
    write allow.
- **Integration (existing `integrationTests/` harness):**
  - Registering the extension replaces `bash` in `pi.getAllTools()` and the
    spawn hook wraps commands only when the active profile declares a sandbox;
    a later competing `bash` override is detected and sandboxed calls fail closed.
  - `/profile` switch changes wrap behavior on the next call.
  - `PI_SUBAGENT_WRITE_GLOBS=src/auth,tests/auth` produces a rendered artifact
    whose project write allows contain only those subtrees; an implicit child
    process write outside them fails while `/tmp` remains writable. Cache tests
    prove constrained and unconstrained states cannot share an artifact.
  - `user_bash` returns wrapped operations for sandboxed profiles, `undefined`
    otherwise.
  - Fail-closed: with detection forced unavailable, wrapped command is the
    exit-126 stub.
  - Warn: with detection forced unavailable and `onUnavailable: "warn"`,
    commands pass through unwrapped and exactly one session-start
    availability notify fires.
  - Coverage: the uncovered notify fires at session start and on `/profile`
    switch exactly when the active profile's `uncovered` is non-empty.
- **Manual macOS smoke script** (`scripts/verify-sandbox.sh`, run by hand,
  not CI — CI may be Linux): under a rendered default-profile sandbox assert
  `touch /tmp/ok` succeeds, `touch "$HOME/nope"` fails, `cat ~/.ssh/config`
  fails, `cat project/.env` fails, and `curl https://example.com` succeeds /
  fails per `allowNetwork`.

## 10. Rollout

1. `policyHelpers.ts`: `SandboxConfig` type + schema + tests.
2. Extract shared `PI_SUBAGENT_WRITE_GLOBS` parsing/normalization from the
   extension, then add `modules/sandbox.lib/translate.ts` (`SandboxSpec`) + unit
   tests (direction tags, writable derivation incl. read-only literals and
   runtime-scope intersection, `noSandboxMeaning` classification).
3. `modules/sandbox.lib/shell.ts` (`shellQuote`) + `modules/sandbox.lib/seatbelt.ts`
   (`filterExpressible`, `renderSeatbeltProfile`, `detectSeatbelt`,
   `wrapCommand`) + unit tests.
4. `modules/sandbox.lib/index.ts`: backend dispatch, detection cache,
   effective-state cache (profile + sandbox config + write scopes),
   `resolveSandbox`, `createSandboxSpawnHook`.
5. `extensions/permissions.ts`: tool override registration, `user_bash`
   handler, `/sandbox` coverage-report command, system-prompt note, status
   hints, warn-mode availability notify, shutdown cleanup.
6. Add opt-in JSONC configuration examples; do **not** wire sandbox configs into
   portable `modules/policy.ts` profiles in v1. Regenerate and check
   `schemas/profiles.schema.json`.
7. Integration tests + `scripts/verify-sandbox.sh` + README "Sandboxing" section
   (what is covered: bash + `!`; what is not: in-process file tools; the
   partial-translator contract and coverage report; fail modes; configuration
   reference).
8. Manual verification pass on macOS across all profiles.

---

## 11. Future work: per-call sandboxing for the built-in file tools

**Deliberately deferred.** Possible paths, in increasing isolation:

1. **Per-call sandboxed helpers (operations overrides).** Re-register
   `read`/`write`/`edit`/`grep`/`find`/`ls` via the same mechanism used here
   for bash (`createReadTool(cwd, { operations })` etc.), implementing each
   operation (`readFile`, `writeFile`, `access`, `stat`, `readdir`, `glob`) by
   spawning a tiny helper process under `sandbox-exec`. Cost: a process spawn
   on the hottest tools in the system plus content serialization over stdio —
   real latency and a lot of plumbing for marginal gain.
2. **Gondolin micro-VM** (pi's documented tool-routing pattern). Route all
   tools into a Linux VM with the cwd mounted. Strong isolation and a working
   upstream example, but adds QEMU, a VM boot per session, and a Linux guest
   on a macOS host (toolchain/native-module mismatch for builds and tests).
   Its workspace mount also writes through to the host, so it protects
   everything _outside_ the cwd more than the cwd itself.
3. **Whole-process sandbox** (pi's documented containerization patterns:
   Docker, OpenShell, or launching pi under Seatbelt). Covers every tool
   uniformly because pi itself is inside — but it is fixed at launch, cannot
   switch per profile, and must leave pi's own state (`~/.pi`) writable.

**Why these stay "potential" rather than planned:** the file tools are a much
smaller attack vector than bash. A `read`/`write`/`edit` call takes a single
path and performs a single filesystem effect — there is no shell grammar to
evade, no subprocess tree, no arbitrary code execution, no way to chain a
download into an execution. The gate's job on that surface (match one path
against ordered rules, protected patterns included) is simple and auditable,
and the blast radius of a single call is exactly the one path named. Bash is
the opposite: it is arbitrary code execution where the gate's static parse is
inherently outmatched (postinstall scripts, substitutions, pipelines), which
is precisely where kernel containment pays for itself. Sandboxing the file
tools would harden against residual risks — an over-broad path rule, a
symlink race, a write to a sensitive-but-allowed location — and should be
revisited if those risks become load-bearing, but it is defense-in-depth
polish on an already narrow surface, not the missing wall.
