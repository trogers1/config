# Git capabilities, repository scope, and runtime discovery

## Status and purpose

Design discussion and implementation plan; **not an approved permission change**.
The unresolved product question is whether a Git-capable profile should operate
only on the startup repository, on explicitly authorized repositories, or on any
repository. In particular, `builtin:git-full` may reasonably mean broad Git
command authority without implying a current-repository-only filesystem scope.
Do not remove its existing access until that meaning and migration are decided.

## Motivation

A `dev` launch from a linked worktree was reported to fail creating a branch lock
under the main checkout's `.git/refs/heads`. The active profile was reported as
`mcp-git-full`. Current code did not reproduce that failure: sandbox acceptance
coverage demonstrated shared-metadata branch creation and commits. Stale loaded
code or a different effective environment remains possible, not an established
root cause. Repository discovery is an architectural improvement, not a proven
fix for that particular report.

The tests now use shipped profiles and a self-contained composed fixture. Do not
introduce dependencies on personal profile names, configuration, or checkouts.

## Current implementation

- `modules/profiles.lib/base.ts` defines global Git metadata write patterns:
  `/**/.git` and `/**/.git/**`.
- `modules/profiles.lib/git.ts` gives those extra sandbox write roots to
  `builtin:committer` and `builtin:git-full`.
- The base posture waives the protected `.git` rules at the kernel layer so Git
  can inspect metadata. Agent-facing path protection remains in force.
- `modules/sandbox.lib/translate.ts` compiles configured roots; it does not
  discover the repository or read a worktree's `.git` indirection.
- Command permissions are separate: `ruleset:git-commit` and
  `ruleset:git-refs` add command rules, not those global write grants.
- `modules/runtimeRequirements.ts` already defines audited runtime requirements
  for Go caches and Vitest temporary paths. `modules/sandbox.lib/index.ts`
  resolves them before policy compilation, caching, and backend preparation.

Consequences:

1. Git mutation profiles can write matching metadata outside the startup
   workspace, subject to other denies and subagent scopes.
2. This is **not a Git-only kernel capability**. Any approved Bash process or
   descendant can use those writable roots, even if its source is opaque.
3. A differently named bare repository or separate Git directory may not match.
4. A metadata grant does not grant checkout writes, new worktree destinations,
   networking, credentials, or arbitrary Git command permissions.
5. Narrowing write grants alone would not isolate repository reads: the existing
   global kernel `.git` waiver is a separate dimension of the design.

## Separate the policy dimensions

Do not overload a profile name or a single `git: true` switch with all of these:

| Dimension            | Examples                                             | Independent policy question                        |
| -------------------- | ---------------------------------------------------- | -------------------------------------------------- |
| Command authority    | inspect, commit, rebase, branch, push, config, clone | Which operations may run?                          |
| Repository selection | startup repo, selected repo set, arbitrary repos     | Which repositories may they affect?                |
| Metadata access      | worktree Git dir, common Git dir, objects and refs   | Which exact runtime roots are required?            |
| Checkout access      | reset/checkout effects, worktree creation/removal    | Which working trees and destinations are writable? |
| External resources   | remotes, SSH agent, credentials, signing helpers     | Which network and helper capabilities exist?       |
| Delegated scope      | file-scoped child versus repository maintainer       | Which grants survive subagent narrowing?           |

“All Git commands” and “all repositories” are different promises. A full command
profile need not bypass protected secrets, explicit path denies, dependency
safeguards, or network policy. Conversely, a repository-scoped profile could
permit a broad command set inside its authorized repository.

`git-full` currently extends enumerated command rules; it is not an unconditional
allow for every Git subcommand, option, alias, helper, or global configuration
write. Decide whether to keep that meaning or introduce a genuinely broader
command tier as a separate change. Commands such as `git config --global`,
`clone`, `init --bare`, and `worktree add` demonstrate why metadata access alone
cannot deliver literal unrestricted Git functionality.

## Options and tradeoffs

### A. Preserve global metadata grants

Keep the current matching `.git` writes for mutation tiers.

**Pros:** preserves existing workflows; handles opaque wrappers and multiple
repositories without predicting targets; no discovery or invalidation machinery.

**Cons:** writable metadata across unrelated repositories; not Git-process-only;
misses nonstandard Git-directory names; still does not make all Git commands or
checkout destinations usable. The name-based scope is broad but incomplete.

This is a defensible compatibility posture if explicitly documented, but not a
solution to exact repository authorization.

### B. Resolve only the startup repository

Discover its per-worktree Git directory and shared common directory, then grant
those exact metadata roots to the relevant capability.

**Pros:** smallest predictable write boundary; handles linked worktrees, bare
repositories, and separate Git directories without naming assumptions; useful for
scoped implementation agents and single-repository sessions.

**Cons:** breaks multi-repository workflows; starting outside a repository needs
an explicit behavior; cannot transparently handle later `init`/`clone`, arbitrary
`git -C`, or a wrapper selecting a different repository. Shared metadata still
permits repository-wide effects across worktrees, not just the current branch.

Do not silently make this the meaning of every Git profile.

### C. Authorize an explicit set of repositories

Resolve metadata for the startup repository plus declaratively selected checkout
or repository paths. Prefer repository selectors over hand-maintained `.git`
paths so callers do not need to know the storage layout.

**Pros:** supports deliberate multi-repository workflows with exact roots;
auditable; can combine with explicit checkout/destination grants.

**Cons:** configuration and approval friction; new repositories need a policy
update; selectors must define absent paths and repository replacement behavior;
listing a repository must not accidentally authorize its whole parent directory.

A discovery/approval flow could update that declared set and prepare a new
sandbox. An ordinary one-command approval must not silently widen the persistent
session boundary.

### D. Separate repository scope from Git command tiers

Keep command tiers and choose independently between current-repository,
explicit-repositories, and broad metadata scope. Names and configuration syntax
are intentionally not prescribed yet; derive any new schema/types from one
authoritative definition.

**Pros:** makes the tradeoff explicit; allows `git-full` command authority with
either narrow or broad repository selection; supports a compatibility migration
without treating every Git workflow alike.

**Cons:** adds a policy axis, composition rules, UI, and test cases; broad mode
still requires an honest definition of supported repository layouts and ancillary
writes. Conflicting parent scopes need documented resolution, not implicit union
that unexpectedly widens a child.

**Provisional direction:** D is the most expressive model; B and C are useful
scope choices rather than mandatory restrictions on `git-full`. Preserve current
behavior until the default is selected. If scope configuration proves premature,
start with explicit opt-in repository-scoped capability rather than changing all
existing profiles.

### E. Discover targets automatically for each command

Inspect `git -C`, `--git-dir`, `--work-tree`, environment overrides, and cwd changes
before running a command; prepare a command-specific boundary.

**Pros:** potentially ergonomic for direct, statically understood Git commands.

**Cons:** discovery is not authorization. Automatically granting every requested
repository defeats repository scoping. Opaque `dev`/Python/Node/shell wrappers,
Git aliases, and repositories created mid-command cannot be fully inferred.
Parsing all Git behavior would duplicate Git and become a brittle security
boundary. Temporary grants also complicate concurrency and approval semantics.

Not recommended as the foundational design. A future direct-command adapter may
select among already authorized repositories, but must not auto-authorize them.

## Runtime resolver architecture

Prefer named, audited capability resolvers over executable callbacks on rules.
Profiles remain serializable declarations. Resolver code returns validated
requirements and provenance; it must not incrementally mutate active grants.

1. Resolve profile composition, command tier, repository scope, and subagent scope.
2. Resolve selected runtime capabilities against the immutable startup workspace
   and any explicitly authorized repository selectors.
3. Discover and validate repository identity and metadata paths.
4. Compile a complete desired policy, preserving explicit denies.
5. Prepare and activate through the existing serialized sandbox lifecycle.
6. Report effective roots and their provenance in `/sandbox`.

Switching away recomputes policy without the capability. It must revoke old
access; running an “enable Git” callback once is insufficient. Startup, reload,
profile switching, sandbox overrides, and child inheritance must use the same
resolution path. Keep I/O discovery separate from the pure policy compiler.

### Discovery details to establish with a spike

- Use Git's own discovery with explicit argv and cwd, including
  `rev-parse --absolute-git-dir` and an absolute form of `--git-common-dir`.
  Canonicalize and deduplicate existing directories; handle spaces and relative
  worktree indirections without shell interpolation.
- Distinguish a normal “not a repository” result from permission errors,
  malformed metadata, missing directories, timeout, and unavailable Git. Never
  recover from failed discovery by opening an ancestor or global `.git` glob.
- Set a documented environment for discovery. Ambient `GIT_DIR`,
  `GIT_WORK_TREE`, and related overrides must not silently retarget a grant.
  Decide how intentional explicit overrides are authorized for execution.
- Discovery is read-only and must not invoke hooks, create directories, change
  configuration, initialize repositories, or disable Git ownership checks.
  Treat repository-derived paths as authorization inputs, not inherently trusted
  merely because Git printed them.
- Determine whether repository indirections outside the selected checkout are
  authorized automatically, require confirmation, or must fit an allowed root.
  Separate Git directories are legitimate, but a replaced `.git` pointer must
  not silently redirect an old authorization to an unrelated repository.
- Include resolved roots and repository identity in the sandbox cache key.
  Define refresh/revalidation when metadata or symlinks change; canonicalization
  alone is not a complete defense against concurrent replacement.
- Establish cold-start read access needed for discovery before relaxing any
  protected metadata rules. Keep errors fail-closed rather than bypassing a
  protected read to make initialization succeed.

### Kernel and scope constraints

- Exact metadata grants still apply to all approved processes inside that Bash
  sandbox, not exclusively the `git` executable. Hooks and helpers may also run.
- An exact write grant must not implicitly remove global protected read denies.
  Audit the current `.git` kernel waiver separately; narrowing it may require
  exact read exceptions and backend precedence tests. Do not claim strict
  repository isolation while unrelated metadata remains globally readable.
- Do not automatically treat Git metadata like a Go cache. Existing runtime
  requirements can survive file-scoped subagent narrowing. Decide explicitly
  whether a file-scoped child may mutate shared refs/index/history at all;
  repository maintenance authority is broader than file edit authority.
- A shared common directory allows effects on branches used by other worktrees.
  Exact path scope cannot enforce branch-level isolation.
- Worktree creation requires an authorized destination in addition to metadata
  writes. Clone/init and global config need their own approved roots. Object
  alternates, submodules, signing, and credential helpers must be inventoried;
  do not recursively open every referenced location.

## Decisions before implementation

1. Does `git-full` mean the current broad enumerated command tier, or a literal
   all-command tier? Which safeguards remain non-negotiable?
2. Is its default repository scope broad for compatibility, startup-only, or
   explicitly selected? Should committer and git-full differ in that default?
3. Is broad metadata scope an explicit supported opt-in? How are nonstandard
   Git directories covered without pretending a `.git` glob is universal?
4. Do command rule sets also declare metadata runtime capabilities, or do only
   complete profiles do so? Avoid a surprising command/filesystem mismatch while
   preserving the existing distinction deliberately if desired.
5. Can file-scoped subagents receive shared metadata writes, and under what
   explicit delegation? How does scope compose across parents and children?
6. How are new repositories and worktree destinations authorized during a
   session, and how is that expansion displayed and confirmed?

## Phased implementation plan

1. **Document the contract.** Resolve the decisions above; record compatibility
   and migration behavior. Do not infer filesystem authority from wildcard
   command matching or from a custom profile's name.
2. **Discovery spike.** Use disposable real repositories to validate path
   discovery, ownership/environment behavior, canonicalization, and backend
   read/write exception semantics. Confirm support before promising strict scope.
3. **Generalize runtime requirements minimally.** Extend the existing registry
   with contextual resolver output and provenance. Keep fixed cache requirements
   simple; avoid a generic plugin/callback framework for one dynamic use case.
4. **Wire scope and lifecycle.** Add only the approved declarative scope model,
   derive schema/types, integrate resolution before cache lookup/preparation,
   and cover revocation, failures, and delegated scope explicitly.
5. **Migrate grants.** Replace global write patterns only for modes selected to
   use exact roots. Retain broad behavior explicitly where approved; address read
   waivers separately. Update `/sandbox`, prompts, docs, and authoring UI/schema
   together so capability expansion is visible.
6. **Verify production behavior.** Run behavioral coverage and existing static
   checks; document unsupported operations rather than add silent fallbacks.

## Behavioral acceptance matrix

Drive the public extension lifecycle and real kernel backend with disposable
repositories and self-contained schema-valid profile fixtures, never personal
configuration or real workspaces. Lower-level discovery tests are appropriate
only for hard-to-reach parsing/error cases.

- Ordinary checkout and linked worktree: commit and ref-lock writes succeed for
  authorized mutation tiers, including an opaque child invoking Git.
- Shared metadata outside startup cwd: discover exact roots without opening the
  sibling checkout or unrelated repositories in narrow mode.
- Bare/separate Git directory, nested cwd, relative pointers, and paths with
  spaces: resolve the actual Git layout without assuming directory names.
- Broad versus explicit/current scope: verify the selected contract against a
  second repository, including direct commands and opaque children.
- Read-only profile: Git inspection succeeds but kernel metadata writes fail.
- Profile switch/reload: previous broader grants cannot survive activation of a
  narrower profile; failed preparation cannot use stale prepared state.
- Subagent scope: prove the chosen shared-metadata delegation policy rather than
  implicitly exempting it as a runtime cache.
- Protected data and explicit denies: remain denied even when metadata access is
  available; verify the separately chosen metadata-read policy.
- Worktree/clone/init: authorized destinations succeed and unauthorized checkout
  paths remain denied independently of metadata permissions.
- Not a repository, malformed pointer, discovery failure, unavailable Git, changed
  indirection, and environment overrides: explicit outcomes without broad fallback.
- `/sandbox`: accurately explains repository selection, exact/broad roots, kernel
  waivers, and restrictions the kernel cannot express.

## Non-goals

No chmod/chown recovery, sandbox disablement, permission bypass, automatic retry
of the reported dev launch, or changes to personal profiles. No promise that
filesystem scoping makes Git helpers, aliases, hooks, or arbitrary child processes
safe independently of the remaining command, filesystem, and network policy.
