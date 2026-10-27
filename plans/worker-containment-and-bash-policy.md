# Worker containment and Bash policy consolidation

## Goal

Keep useful repository/instruction inspection, narrow task mutations, and explicit
approval for consequential actions. Replace redundant shell prediction only when
a verified OS boundary enforces the same guarantee. Do not force all tools through
Bash or silently reinterpret ordinary read policy as already kernel-enforced.

## Current boundary

- Only Bash execution and its descendants are sandboxed. Pi file tools, search
  subprocesses started by those tools, and extensions are outside that boundary.
- The Bash compiler constrains writes and protected reads, not ordinary readPaths.
- Worker write scopes narrow kernel writes and guard-level Bash operands; the
  latter additionally restrict reads/navigation. Removing them changes authority.
- The unavailable `warn` mode can execute locally. It must never be used for a
  request whose authorization depends on containment.
- Command approval is distinct from filesystem/network containment.

## Immediate discovery work

Behavioral guard and real-child lifecycle tests cover dedicated inspection of
installed skill/snippet roots without additional write, Bash, or grep grants.
Generated paths must match literally, including wildcard characters in real
filenames; user-authored glob rules keep their existing semantics. Independent
review is required before considering this change complete.

## Gate 1: establish containment-dependent execution

Progress: active-sandbox Bash approvals are now bound to tool-call ID, command,
working directory, policy revision and sandbox specification. Lifecycle regressions
cover disabling, unavailable warn fallback, command replacement and source revision
changes, plus nested and interleaved call isolation. Independent review approves
the execution binding, identity rework and all five real-backend fixture pairings,
with no remaining findings. Verification: 182 affected tests, six selected real OS
controls and real Pi/tmux guarded-child acceptance pass; static checks and diff
whitespace checks pass. Pending snapshots are intentionally retained until
execution/result: clearing them at a session boundary without proven cancellation
could erase the evidence forbidding local fallback. Dynamic-output relaxation and
its full kernel-negative matrix have not been implemented.

Before relaxing any dynamic output operand, make its authorization explicitly
conditional on an active, owned sandbox with adequate coverage. Execution must
recheck that condition and fail closed if the backend, profile, or ownership changes.
Do not turn the existing local fallback into an escape from that authorization.

Real-backend acceptance must establish allowed writes and actual denial of sibling,
protected, ask-only, symlink-target, traversal, and overwrite attempts. Include a
valid unsandboxed fixture control so shell errors cannot masquerade as containment.
Lifecycle tests must cover disabled/unavailable backends, warn fallback, competing
Bash ownership, and changes between gate and execution. Fake backends may induce
lifecycle failures but cannot certify kernel containment.

Do not relax dynamic input reads, generic filesystem arguments, or uncertain CWD
merely because kernel write containment works. Include a harmless external-read
counterexample showing the existing kernel specification's limitation. Treat PWD
as mutable shell data, not an authoritative directory.

## Gate 2: bounded whole-worker prototype

Target: one macOS worker, fixed launch policy, narrow literal write ownership,
real Pi/tmux, and a credential-free deterministic model gateway. No parallel/chain
support or production provider credentials in the first acceptance milestone.

### Required architecture

1. A trusted per-attempt supervisor outside the sandbox, separate from the parent's
   process-global Bash SandboxManager. It owns initialization, proxy lifetime,
   cleanup, startup stderr, and exit diagnostics. No unsandboxed fallback.
2. Containment starts before worker Pi or extension initialization. The worker's
   in-process tools, search binaries, extensions, Bash, and descendants share it.
3. A distinct whole-worker filesystem contract. Reuse validated policy definitions,
   but do not reuse the Bash-only compiler as though it already enforces all tools.
4. Split parent-owned authority/registry/loadout, child-owned outbox/session/temp,
   and parent-written reply inbox. Atomic writes require containing-directory
   authority; do not grant the whole orchestration run directory.
5. Minimal explicit environment; no ambient provider keys, SSH-agent sockets,
   tmux socket variables, or language-loader hooks. Audit inherited descriptors.
6. Parent-owned model gateway with no real credentials in the prototype worker.
   Prove actual provider streaming. Neither unrestricted network nor broad localhost
   access is an acceptable exact-endpoint restriction.
7. Preinstalled search binaries and curated read-only runtime/resources. No startup
   downloads, writable trusted executable roots, blanket home, or blanket /tmp.
8. Explicit externally-contained guard mode: retain tool/action policy without
   initializing a second sandbox. Worker profile switches or sandbox-off cannot
   widen the immutable outer envelope; widening requires parent approval/relaunch.
9. Fixed profile for the first prototype. Persisted human worker-profile authority
   must remain parent-owned or be brokered before that feature is enabled.

### Required real-child acceptance

- Extension initialization attempts prohibited access before session_start.
- Allowed and denied operations through read/write/edit/ls, rg/fd, Node fs, a probe
  extension, Bash, and grandchildren; verify host state and OS-denial evidence.
- Literal/glob paths, symlinks, traversal, new protected files, atomic replacement.
- Parent authority, sibling session/control data, and host tmux remain inaccessible.
- Model streaming succeeds; unrelated network, loopback and socket access fail.
- Sentinel parent credentials are absent from environment, readable files and logs.
- Sequential questions/replies, stale-ID rejection, steering, initial launch and warm
  resume preserve ownership and fail closed on supervisor/backend/startup failure.
- Background descendants cannot outlive cleanup uncontrolled; parent Bash and worker
  supervisor sandbox managers cannot reset/reconfigure each other.

## Approval policy retained throughout

Deployment, publishing, remote mutation, installation, destructive Git operations,
and authority expansion remain semantic approval decisions. A permitted write root
or network destination does not authorize every operation possible within it.

## Delivery order

1. Finish and review literal discovery grants.
2. Establish containment-dependent execution and its real-backend acceptance before
   removing any guard uncertainty checks.
3. Prototype supervisor/control-plane/model-gateway boundaries above, proving initial
   launch and warm resume before expanding functionality.
4. Only then simplify redundant guard behavior against the verified envelope.

The audits were source inspections, not evidence that new containment guarantees
have already been implemented or tested. Linux equivalence is not established;
macOS is the existing verified target.
