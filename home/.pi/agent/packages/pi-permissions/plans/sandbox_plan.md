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
- Sandbox posture is **per profile** and switches correctly on `/profile` at
  runtime, like every other part of this package.
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
      command → sandbox-exec -f <rendered.sb> /bin/sh -c '<quoted command>'
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
   * /tmp (resolved) and os.tmpdir() are always writable. When nothing
   * translates from edit/write ∪ bashOutputRedirections allow rules:
   * startupCwd is added only if the profile declares no edit/write rules
   * at all; a profile whose rules allow nothing derives a /tmp-only
   * writable set — never a startupCwd fallback — so an all-deny rule
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
   * missing, or profile fails a startup smoke test).
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

Proposed initial per-profile posture (tunable at implementation time):

| Profile     | sandbox                       | allowNetwork | Notes                                                                                              |
| ----------- | ----------------------------- | ------------ | -------------------------------------------------------------------------------------------------- |
| `default`   | seatbelt, writable cwd + /tmp | `true`       | everyday work; npm/curl keep working                                                               |
| `read-only` | seatbelt, writable /tmp only  | `false`      | strongest posture; cwd is read-only                                                                |
| `socrates`  | same as `read-only`           | `false`      |                                                                                                    |
| others      | inherit via `extendProfile`   | —            | `sandbox` flows through `extendProfile` like other non-`tools` fields; overrides replace wholesale |

`extendProfile` already spreads non-`tools` fields, so `sandbox` inherits
naturally; a derived profile replaces it by providing its own.

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
  // Allow-direction patterns. Concrete ones are pre-derived into `writable`
  // (literals/subpaths — every path sandbox can express those); non-concrete
  // allow globs are candidates the backend may attempt to express.
  // writable derives from edit/write ∪ bashOutputRedirections allow rules ∪
  // config.writablePaths ∪ /tmp (always) ∪ startupCwd (only when the
  // profile declares no edit/write rules at all — §4).
  writable: { literals: string[]; subpaths: string[] };
  candidateWritablePatterns: string[];
  allowNetwork: boolean;
  // Gate semantics with no filesystem-sandbox meaning (command rules, ask
  // decisions, redirection denies, bash path-reference rules) — true for
  // every backend, so classified here. Informational only; never notified.
  noSandboxMeaning: Array<{ construct: string; pattern: string }>;
};

translatePolicy(policy: ProfilePolicy, ctx: { startupCwd: string }): SandboxSpec
```

What the spec deliberately does NOT decide is _expressibility_: whether a
given glob can be enforced depends on the backend (Seatbelt has regexes;
bwrap has only literal bind-mounts — even `**/.env*` deny-reads would be
inexpressible there). Direction is known here and travels with each bucket;
the backend's expressibility filter (§5.3) assigns patterns it cannot
express to `uncovered` (restriction buckets) or `untranslatedAllows` (allow
buckets) and assembles the coverage report.

Report semantics (fail-tight rules and the translation table in §6):
`uncovered` holds only _actionable_ gaps — restrictions the author believes
are kernel-enforced but are not. `untranslatedAllows` is the safe direction:
the sandbox EPERMs what the gate permits — a UX rough edge, listed but never
notified. `noSandboxMeaning` reflects that the sandbox narrows what the gate
permits; it does not mirror gate semantics. (The default profile ships ~130
bash rules; reporting those as uncovered would make the report a constant,
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

- `shellQuote(command: string) → string` — single-quote escaping:
  `command.replaceAll("'", `'\''`)` wrapped in `'…'`. This is **the**
  security-critical function; see §7. Shared by any backend that wraps via
  `sh -c` (bwrap is `bwrap --bind … -- /bin/sh -c <quoted>` — the same
  two-parse problem as `sandbox-exec`), so it lives outside the Seatbelt
  module.

### 5.3 `modules/sandbox.lib/seatbelt.ts` — expressibility, rendering, detection, wrapping

- `filterExpressible(spec: SandboxSpec) → { denyRead: SeatbeltRule[];
allowRead: SeatbeltRule[]; writable; uncovered; untranslatedAllows }` —
  the proven-equivalent-subset check: globs Seatbelt's regex flavor can
  provably express translate; anything else is skipped and reported by the
  spec's direction tags (restriction buckets → `uncovered`, allow buckets →
  `untranslatedAllows`; v1 expresses no `candidateWritablePatterns`). Never
  approximated.
- `renderSeatbeltProfile(filtered, ctx: { startupCwd, home, tmpdir }) → string`
  — builds the `.sb` text from the base template (§6), resolving `~`,
  symlinks (`/tmp` → `/private/tmp`), and `denyReadPaths`.
- `detectSeatbelt(): { available: boolean; reason?: string }` — platform is
  `darwin`, `/usr/bin/sandbox-exec` exists, and a smoke test
  (`sandbox-exec -f <minimal.sb> /usr/bin/true` via `pi.exec` or
  `node:child_process` `execFileSync`) exits 0.
- `wrapCommand(command, profilePath) → string` —
  `sandbox-exec -f <profilePath> /bin/sh -c <shellQuote(command)>`
  (profilePath itself is extension-generated, never model-influenced).

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
- Profile cache: render the backend artifact (a `.sb` profile file for
  Seatbelt) into a `fs.mkdtempSync(join(os.tmpdir(), "pi-permissions-"))`
  dir; reuse per (profile, sandbox config) for the session; delete the temp
  dir on `session_shutdown`. Cached artifacts are opaque backend outputs (a
  bwrap backend would cache argv, not a file), so the cache shape survives
  a second backend. The startup profile translates eagerly at session start
  (the coverage notify needs the result); profiles switched into mid-session
  translate on first use.

The module's public API — and the only thing the extension layer (§5.5)
consumes, so wiring never names a backend (machine-enforced by the
lib-boundary dependency-cruiser rules, §5 intro):

```ts
export type SandboxState = {
  profile: string; policy: ProfilePolicy; startupCwd: string;
};
export type SandboxResolution =
  | { kind: "none" }        // active profile declares no sandbox
  | { kind: "unavailable"; reason: string; onUnavailable: "block" | "warn" }
  | { kind: "active"; wrap(command: string): string };
  // `wrap` closes over the backend's rendered artifact (profile file path
  // or bwrap argv) — callers never learn which backend answered.

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
     touching the gate).
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
   });

   pi.registerTool({
     ...createBashTool(startupCwd, {
       spawnHook: createSandboxSpawnHook(sandboxState),
     }),
   });
   ```
   (Spread pattern follows the Gondolin example; no `execute` override needed
   since behavior comes from options.)
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
   `SandboxSpec.writable` set_ (already cached per profile, §5.4) — never a
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

;; Read everything by default...
(allow file-read*)

;; ...except the translated deny-reads, then the translated exception allows.
${denyReadRules}                      ;; from protectedPathPatterns + config.denyReadPaths
${allowReadRules}                     ;; from protectedPathExceptions (last-match-wins,
                                      ;;  mirroring protectedExceptionRules ordering)

;; Writes: only the translated writable set.
${writeRules}                         ;; from edit/write ∪ bashOutputRedirections allow rules
                                      ;; ∪ config.writablePaths ∪ /tmp (always) ∪ startupCwd
                                      ;; (only when no edit/write rules exist — §4)

${networkRule}                        ;; (allow network*) OR nothing (denied by default)
```

Translation table — the ✅/❌ statuses are the **Seatbelt backend's
expressibility column**; a future bwrap backend gets its own column (no
regex → even basename globs like `**/.env*` would be ❌ there, which the
`uncovered` notify then surfaces by construction). Fail-tight: anything not
listed as translatable is _reported_, never approximated — failed
restrictions land in `uncovered`, failed allows in `untranslatedAllows`,
gate semantics in `noSandboxMeaning`:

| Policy construct                                                 | Seatbelt translation                                                                                                                                                                                                                                                                                                                 | Status                                              |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| `protectedPathPatterns` basename globs (`**/.env*`)              | `(deny file-read* (regex ...))`                                                                                                                                                                                                                                                                                                      | ✅                                                  |
| Rooted/literal protected paths (`**/credentials.json`, `~/.ssh`) | deny-read subpath/literal                                                                                                                                                                                                                                                                                                            | ✅                                                  |
| `protectedPathExceptions` (`.env.template`)                      | allow-read placed after denies (same last-match-wins semantics as the rule lists)                                                                                                                                                                                                                                                    | ✅                                                  |
| edit/write `allow` path patterns                                 | writable literals/subpaths, unioned across both tools                                                                                                                                                                                                                                                                                | ✅ concrete patterns; others → `untranslatedAllows` |
| `bashOutputRedirections` **allow** targets (`/tmp/**`)           | writable literals/subpaths, unioned with the edit/write allows — same `evaluatePathByPattern` semantics (relative to startup cwd, last-match-wins)                                                                                                                                                                                   | ✅ concrete patterns; others → `untranslatedAllows` |
| `bashOutputRedirections` **deny** rules (`**` deny)              | none — the kernel cannot distinguish `> f` from `tee f` or `sed -i`; gating writes by mechanism is gate-layer UX only                                                                                                                                                                                                                | ❌ `noSandboxMeaning`                               |
| `bashPathReferences` **allow** rules                             | none — read-intent allows: a bare path token carries no read/write distinction at the gate, but the kernel distinguishes operations, and reads are already default-allowed. Unioning them into writable would re-widen the write surface the sandbox exists to narrow (read-only's `*` path allow would make the whole cwd writable) | ❌ `noSandboxMeaning`                               |
| `bashPathReferences` **deny** rules (`../**` deny)               | the write half is inherited from the writable derivation (default-deny); the read half would require a per-profile read allow-list (breaks system/toolchain reads), which v1's default-allow read model rejects. Express bash read-restrictions as `protectedPathPatterns` instead — those translate (above)                         | ❌ `noSandboxMeaning`                               |
| `config.writablePaths` / `config.denyReadPaths`                  | additive literals                                                                                                                                                                                                                                                                                                                    | ✅                                                  |
| bash command rules (`git push *`)                                | none — command semantics are invisible to a filesystem sandbox                                                                                                                                                                                                                                                                       | ❌ `noSandboxMeaning`                               |
| `ask` decisions (any tool)                                       | none — the kernel cannot prompt; the sandbox only ever _narrows_ what `allow` permits                                                                                                                                                                                                                                                | ❌ `noSandboxMeaning`                               |
| Globs outside the proven-equivalent subset                       | skipped, reported by direction — restriction globs → `uncovered`, allow globs → `untranslatedAllows`                                                                                                                                                                                                                                 | ❌                                                  |

Details that matter:

- **Rule order:** in Seatbelt, the _last_ matching rule wins — the same
  semantics as this package's rule lists ("later matching rules override
  earlier ones"). The derivation pattern is **base verdict + ordered rules**:
  the base rule carries the default decision (`allow file-read*` for reads,
  `deny default` for writes) and translated rules append in policy order, so
  mixed allow/deny postures survive translation (deny-reads follow
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
  an earlier draft of this plan hardcoded is instead _translated_ from the
  active profile's `protectedPathPatterns`, so the two layers cannot drift.
- **Derived writable example:** the `read-only` profile's edit/write rules
  (allow only `handoff.md` and `progress.md`) translate to a cwd that is
  read-only except those two literals — the kernel backstops the rule layer
  precisely, with no duplicated config.
- **All-deny profiles stay tight:** socrates's edit/write rules allow
  nothing, so nothing translates — and the fallback must be /tmp-only, not
  the §4 nothing-translates default including startupCwd. Otherwise an
  all-deny rule layer gets a writable cwd at the kernel layer: socrates
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
- **`.git`:** v1 leaves `.git` writable inside a writable cwd (the agent's
  normal workflow needs it). Codex-style read-only re-mounting of `.git`
  inside writable roots is a documented future hardening step.
- **Reference:** `/Users/taylorrogers/code/open-source/codex/codex-rs` (local research checkout) contains a
  production Seatbelt generator worth consulting during implementation.

---

## 7. Command wrapping and escaping (critical)

The wrapped command is parsed by pi's shell first, then the inner
`/bin/sh -c` parses the original text. Correctness of `shellQuote` is the
security boundary between those two parses.

Rules:

- Only single-quote wrapping: `'` → `'\''`. Never double-quote wrapping
  (leaves `$()`, backticks, and `\` live for the outer shell).
- The sandbox profile path is extension-generated (temp dir, no
  model-influenced segments), so it needs no quoting beyond a defensive check
  that it contains no whitespace/quotes.
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
| Rendered profile has a Seatbelt syntax error                              | caught by the session-start smoke test → same path as unavailable                                                                                    |
| Sandboxed operation denied by kernel                                      | command fails with EPERM; optional `tool_result` steering appends the allowed roots (§5.5 item 4)                                                    |
| Profile switched at runtime                                               | next spawn hook call reads new profile state; rendered profiles cached per profile                                                                   |
| Session ends                                                              | temp dir with `.sb` files removed in `session_shutdown`                                                                                              |
| Non-interactive (`-p`, json/rpc)                                          | unchanged semantics: sandbox still applies (it is not a prompt); `block` mode just fails the command                                                 |

---

## 9. Testing plan

- **Unit (vitest, existing layout):**
  - `shellQuote`/`wrapCommand` corpus incl. §7 table (behavioral, via real
    `sh -c` on macOS dev machines; string-equality assertions elsewhere).
  - `renderSeatbeltProfile`: substitution, symlink resolution, `~` expansion,
    deny-order after allow, network on/off.
  - `translatePolicy` (backend-neutral): redirect allow targets union into
    the writable set; all-deny edit/write profiles derive a /tmp-only
    writable set (no startupCwd widening); direction tags travel with each
    pattern bucket; command rules, ask decisions, redirect denies, and
    `bashPathReferences` rules land in `noSandboxMeaning`;
    `bashPathReferences` never widens writable (read-only's `*` path allow
    keeps cwd read-only).
  - `filterExpressible` (Seatbelt): proven-equivalent globs translate;
    non-concrete restriction globs → `uncovered`; non-concrete allow globs
    (any tool) → `untranslatedAllows`; nothing is approximated.
  - `detectSeatbelt`: mock platform/availability for block/warn branches.
- **Integration (existing `integrationTests/` harness):**
  - Registering the extension replaces `bash` in `pi.getAllTools()` and the
    spawn hook wraps commands only when the active profile declares a sandbox.
  - `/profile` switch changes wrap behavior on the next call.
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
2. `modules/sandbox.lib/translate.ts` (`SandboxSpec`) + unit tests (direction
   tags, writable derivation incl. read-only literals, `noSandboxMeaning`
   classification).
3. `modules/sandbox.lib/shell.ts` (`shellQuote`) + `modules/sandbox.lib/seatbelt.ts`
   (`filterExpressible`, `renderSeatbeltProfile`, `detectSeatbelt`,
   `wrapCommand`) + unit tests.
4. `modules/sandbox.lib/index.ts`: backend dispatch, detection cache,
   profile cache, `resolveSandbox`, `createSandboxSpawnHook`.
5. `extensions/permissions.ts`: tool override registration, `user_bash`
   handler, `/sandbox` coverage-report command, system-prompt note, status
   hints, warn-mode availability notify, shutdown cleanup.
6. Wire `sandbox` configs into `modules/policy.ts` profiles.
7. Integration tests + `sandbox/verify.sh` + README "Sandboxing" section
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
