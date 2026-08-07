# Taylor Pi Permissions

Pi package for best-effort guardrails, auto-pilot (steering), and permissions. Includes
switchable profiles and customizable, layered composition of shipped profiles, rule sets, and
transforms with custom rules and agent guidance.

At runtime the extension loads the shipped profile registry, optionally composes the user JSONC config, selects a profile (subagent environment > directory binding > persisted session > configured default), then applies the policy to every tool call. Permissions are evaluated in this order:

```mermaid
flowchart LR
  Input[Tool call] --> Protected[Protected-path rules]
  Protected -->|deny| Block[deny with guidance]
  Protected -->|allow/no deny| Paths[readPaths/writePaths]
  Paths --> Commands[Bash or custom-tool rules]
  Commands --> Result[allow / ask / deny]
```

For each rule collection, matching rules are ranked by literal segments, then literal characters, then later composed position. Therefore a broad wildcard is a fallback and inheritance ordering matters only for equivalent specificity.


Built-in profile, rule-set, and transform names are reserved under the `builtin:`,
`ruleset:`, and `transform:` namespaces respectively and cannot be overridden by user configuration.

## The specificity metric

Rules resolve by specificity, not by declaration order.

1. Collect every rule whose pattern matches the input.
2. Choose the rule with the most literal (non-wildcard) segments.
3. If two rules have the same number of literal segments, choose the one with
   the most literal characters.
4. If both metrics tie, the rule that appears later in the composed rule list
   wins.

`*`, `**`, and `?` contribute nothing to specificity, so `*` is a true
fallback: it only decides when no other rule matches. Order matters only as a
final tiebreak, which makes composition order-insensitive for rules of
different specificity.

## Profile catalog

| Profile                       | Purpose                                                                                            |
| ----------------------------- | -------------------------------------------------------------------------------------------------- |
| `builtin:default`             | general-purpose main session: shell, git, package-manager, and guard rule sets                     |
| `builtin:worker`              | default with `transform:deny-asks`; non-interactive subagents                                      |
| `builtin:read-only`           | inspection tools only; writes limited to tmp/handoff/progress                                      |
| `builtin:tests-only`          | default plus writes gated to test files                                                            |
| `builtin:tests-hidden`        | default plus test files protected from read and write                                              |
| `builtin:committer`           | default plus git-write rules (add/commit/rm/mv/reset/restore/checkout/rebase/cherry-pick/worktree) |
| `builtin:reviewer`            | read-only plus test/build run rules                                                                |
| `builtin:scribe-only`         | default plus writes gated to Markdown, docs/, and /tmp                                             |
| `builtin:deps-mutator`        | default plus package-manager mutation allows                                                       |
| `builtin:no-shell`            | default path policy with all Bash commands denied                                                  |
| `builtin:implementation-only` | default plus test-file write denies                                                                |
| `builtin:git-full`            | committer plus push/branch/tag/switch allows                                                       |

Dangerous or guardrail-loosening profiles are named to make their behavior
obvious (`deps-mutator`, `git-full`). Profiles may define optional `color`,
`emoji`, `directories`, and `promptFile` metadata.

## Commands

- `/profile` shows the active profile and available profiles.
- `/profile <name>` switches to a profile.
- `/read-only` switches to the `builtin:read-only` permissions profile.
- `/permissions explain <tool> <input>` explains which rule decided access for
  the given tool and input. For example:
  - `/permissions explain bash git status`
  - `/permissions explain read docs/readme.md`
  - `/permissions explain edit src/example.ts`

The output shows the active profile, the composition chain, every matching rule
ranked by specificity, the winning rule, which tiebreak fired, and any
protected-layer override that short-circuited the ordinary rule. For Bash, the
explainer also reflects shell read-validation, ordinary path-rule denies/asks
for operands, and the most-restrictive decision across compound commands. It
does not reflect the `PI_SUBAGENT_PERMISSIBLE_GLOBS` subagent narrowing layer.

Profile changes are persisted in the Pi session, so resumed sessions restore
their last selected profile.

## Required read-only tools

This package **requires and will activate** pi's built-in `read`, `grep`,
`find`, and `ls` tools. Deny guidance throughout the policy steers agents to
these tools, so the gate assumes they are callable.

On session start and on every profile switch, the extension activates any
missing read tools. Activation is purely additive: tools enabled by you or by
other extensions are never removed. If a required tool is not even registered,
session start fails loudly — the installed pi version no longer provides a tool
this package depends on.

There is no opt-out from the activation itself. If a read tool should not be
usable, keep it active but deny its paths in your custom profile configuration.
Context-scoped rules restrict a denial to one tool without weakening the
others:

```jsonc
{
  "profiles": {
    "custom-default": {
      "extends": ["builtin:default"],
      "readPaths": [
        {
          "pattern": "**",
          "decision": "deny",
          "contexts": ["grep"],
          "guidance": "The grep tool is disabled here; search with Bash ripgrep instead.",
        },
      ],
    },
  },
}
```

## Rule sets

Shipped profiles are composed from reusable **rule sets** in
`modules/ruleSets.lib/`. Rule sets are partial policies: they add `tools`,
`readPaths`, `writePaths`, and `protectedPathRules`, but no scalars
(color/emoji/promptFile) and no transforms.

Rule sets are addressable from JSONC through the reserved `ruleset:` namespace,
interchangeably with profiles in `extends`:

```jsonc
{
  "profiles": {
    "custom": {
      "extends": [
        "builtin:read-only",
        "ruleset:test-run",
        "ruleset:shell-guards",
      ],
    },
  },
}
```

Shipped rule sets include:

- `ruleset:shell` — base shell command rules.
- `ruleset:git` — base git inspection rules.
- `ruleset:git-commit` — committer posture: add/commit/rm/mv/reset/restore/
  checkout/rebase/cherry-pick/worktree plus `/dev/null` writes.
- `ruleset:git-refs` — push/branch/tag/switch.
- `ruleset:packageManagers` — base package-manager posture: unknown commands
  ask, queries allow, publish/credentials deny.
- `ruleset:deps-mutations-guard` — deny install/add/update/remove families
  (the `builtin:default` posture).
- `ruleset:deps-mutations-allow` — allow install/add/update/remove families
  (the `builtin:deps-mutator` posture).
- `ruleset:shell-guards` — destructive shell guards (`find -delete`, `git
fsck --lost-found`, etc.).
- `ruleset:path-guards` — default read paths, write paths, and protected-path
  rules.
- `ruleset:read-only-shell` — inspection-only Bash posture with explicit
  mutation denies.
- `ruleset:read-only-path` — read-only path posture with writes limited to
  tmp/handoff/progress and the standard protected-path layer.
- `ruleset:test-run` — npm/pnpm/yarn test and run, cargo build/test/check/
  clippy, go.
- `ruleset:docs-write` — writes gated to Markdown, docs/, and /tmp.
- `ruleset:test-write-protection` — test-file write denies.

When authoring a from-scratch profile, include `ruleset:shell-guards` so the
destructive shell guards stay in force. The two deps-mutations rule sets are
decision twins generated from one subcommand table.

## Multi-extends and transforms

A profile may declare `extends: string[]` and `transforms: string[]`.
`extends` folds left-to-right through `extendProfile`; the declaring profile's
own rules are applied last. This is concatenation, not intersection:
extending `builtin:read-only` then `builtin:default` re-opens Bash because the
default bash rules are appended after the read-only rules.

Transforms are applied once, after the full `extends` fold and in listed order,
but **before** the declaring profile's own rules. They normalize inherited
ordinary policy only: Bash, custom-tool, `readPaths`, and `writePaths` rules.
They never alter `protectedPathRules`; protected rules allow only `allow` or
`deny`, remain an independent first-stage safety layer, and continue to compose
through normal protected-rule specificity. Rules authored directly on the
profile are deliberate final overrides.

Shipped transforms:

- `transform:deny-asks` — every inherited ordinary `ask` becomes `deny`
  (non-interactive policy; what `builtin:worker` uses).
- `transform:allow-asks` — every inherited ordinary `ask` becomes `allow`
  (auto-approve; pair with containment).
- `transform:ask-all` — every inherited ordinary `allow` becomes `ask`
  (paranoid supervision; inherited denies unchanged).
- `transform:deny-all` — every inherited ordinary rule decision becomes
  `deny`.

```jsonc
{
  "profiles": {
    "worker-like": {
      "extends": ["builtin:default"],
      "transforms": ["transform:deny-asks"],
    },
  },
}
```

A profile's own `tools.bash`, `readPaths`, `writePaths`, and custom-tool rules
are composed after the transformed inherited ordinary policy. Its
`protectedPathRules` are appended to the unchanged inherited protected layer.
Local rules win equal-specificity ties; a local rule must be more specific to
outrank a more-specific inherited rule.

## Protected-path rules

Protected paths are configured with `protectedPathRules: Rule[]`, where each
rule has `pattern` and `decision` (`allow` or `deny` only; `ask` is rejected).
They apply across contexts: `read`, `grep`, `find`, `ls`, `edit`, `write`, and
Bash path references. A deny short-circuits every stage.

Protected rules concatenate under `extends` like every other rule array. To
weaken an inherited deny, author a more-specific allow:

```jsonc
{
  "protectedPathRules": [
    { "pattern": "**/.env*", "decision": "deny" },
    { "pattern": ".env.template", "decision": "allow" },
  ],
}
```

Exact-pattern conflicts across layers are load errors. To redefine a protected
pattern wholesale, write a from-scratch profile that owns its list.

## Directory-selected profiles

`directories` is an optional per-profile setting. When Pi starts or resumes in a
configured directory (including one of its descendants), that profile is
selected automatically. The most-specific directory wins; profiles declared
later break a tie. This selection takes precedence over a profile saved in the
session, so a resumed session receives the policy appropriate to its current
directory.

The package ships portable profiles only. Add custom profiles and directory
bindings in the user-owned JSON file
`~/.pi/agent/permissions/profiles.jsonc`. The package reads it synchronously;
configuration is data, not executable code. Add the bundled schema as
`$schema` to get completion and validation in JSON-aware editors:

```jsonc
{
  "$schema": "https://example.com/pi-permissions/profiles.schema.json",
  "defaultProfile": "client-work",
  "profiles": {
    "client-work": {
      "extends": ["builtin:default"],
      "directories": ["~/Code/client"],
    },
  },
}
```

`extends` is optional. When supplied, it names a built-in profile by its
canonical name (for example `builtin:default`), a shipped rule set by its
`ruleset:` name, or another custom profile. Custom profile names are exact:
`extends: ["default"]` resolves only a custom profile literally named
`default`; it does not fall back to `builtin:default`. Without `extends`, the
profile is fully custom and must provide every required policy field.
Directories may be absolute, use `~`, or be relative to the directory where Pi
was started. Omit `directories` when no automatic selection is wanted. A missing
config file leaves the portable profiles active. An existing invalid config file
keeps the extension registered but blocks permissions until the file is fixed.
`PI_SUBAGENT_PROFILE` remains authoritative and overrides both directory and
persisted profile selection. TypeScript consumers should import the public
policy types from `taylor-pi-permissions/config`.

User-defined profile names must not start with `builtin:`, `ruleset:`, or
`transform:`. Defining a profile such as `builtin:default` in the user
configuration is a hard validation error; the extension remains registered but
blocks every tool call until the reserved name is removed. There are no legacy
aliases: old unnamespaced built-in selectors such as `worker` or `read-only`
fail closed with the list of available canonical names.

## Subagent environment

The package consumes the environment variables exported by
`pi-permissions-subagents`:

- `PI_SUBAGENT_PROFILE` selects the initial profile and overrides directory and
  persisted profile selection in a resumed worker session. Use canonical built-in
  or custom profile names such as `builtin:worker` or `client-work`; an unknown
  or unnamespaced old name like `worker` fails startup with the list of available
  profiles rather than silently granting the default policy.
- `PI_SUBAGENT_PERMISSIBLE_GLOBS` is a comma-separated list of paths or glob
  patterns relative to Pi's startup directory. When present, `edit`, `write`,
  Bash path references, and Bash output redirections are denied outside the
  declared scopes. Plain paths include their descendants; for example, `src`
  permits both `src` and `src/**`.

The permissible-scope layer only narrows the selected profile, so
protected-path and command restrictions still apply inside an allowed scope.
Pi's dedicated read tools retain the profile's normal read access.

Profile status metadata is configured per profile:

```jsonc
"socrates": {
  "color": "cyan",
  "emoji": "🧠"
}
```

Supported colors: `black`, `red`, `green`, `yellow`, `blue`, `magenta`, `cyan`,
`white`.

## Policy model

Profiles have one command-rule map, two ordered path-rule arrays, and an
optional protected-path-rule array. Resolution is specificity-first; order only
breaks ties.

- `tools.bash` patterns match normalized shell command segments.
- Other `tools.<name>` entries configure custom tools by matching glob patterns
  against named input properties. The built-in path tools cannot be configured
  here; they use the path arrays below.
- `readPaths` applies only to the dedicated `read`, `grep`, `find`, and `ls`
  tools, which this package activates automatically.
- `writePaths` applies to `edit`, `write`, and every Bash filesystem operand,
  including Bash readers and both input and output redirections. Bash is
  deliberately treated as write-capable even for apparently read-only commands.
  The one carve-out is `cd`: it mutates nothing and every later operand is gated
  individually against the tracked directory, so its target is gated against
  `readPaths` with the `ls` context instead.
- A path rule can set `contexts` to restrict itself to particular consumers.
  Valid read contexts are `read`, `grep`, `find`, and `ls`; valid write
  contexts are `edit`, `write`, and `bash`. A rule without `contexts` applies to
  every consumer of its array.
- Absolute path patterns such as `/tmp/**` match absolute paths; other patterns
  match paths relative to Pi's startup directory.
- Outside paths appear as `../...`, so `../**` gates external access.
- `*` is the default rule for a path array.
- Deny rules can include `guidance` and `alternatives`; these are returned in the
  blocked tool result, so Pi automatically gives them to the model without
  another prompt.

For example:

```ts
{
  pattern: "npx vitest *",
  decision: "deny",
  guidance: "Use the repository's configured test script instead.",
  alternatives: ["npm test -- <requested test filters>"],
}
```

Because matching is specificity-first, steering comes only from the rule that
made the final deny decision. For compound bash commands, steering from each
denied segment is combined and deduplicated.

### Custom tools

Any tool name other than `bash` and the reserved path tools (`read`, `grep`,
`find`, `ls`, `edit`, and `write`) can have profile rules. A custom rule's
optional `match` object maps dot-separated input property paths to glob
patterns. Every property matcher must match; a rule without `match` is a
catch-all. Values are matched as strings, while non-string values use their JSON
representation. Matching rules resolve by specificity, with later rules breaking
ties; a configured custom tool with no matching rule defaults to `ask`. If a
tool has no configured rules at all, this package does not add a custom-tool
policy for it.

```jsonc
"tools": {
  "deploy": [
    { "decision": "ask" },
    {
      "decision": "deny",
      "match": {
        "environment": "production",
        "metadata.team": "platform-*"
      },
      "guidance": "Production deployments require explicit approval."
    },
    {
      "decision": "allow",
      "match": { "environment": "staging" }
    }
  ]
}
```

Built-in path tool names are rejected under `tools` so stale per-tool path
configuration cannot silently bypass `readPaths` or `writePaths`.

Bash syntax is parsed with `unbash`; that proves the shell structure and token
boundaries, not the executable semantics of every word. Limited command
adapters add command-specific meaning for a small shipped surface, mainly
ripgrep/readers, package managers, and Git, so only clearly understood operands
can be treated less conservatively: ripgrep patterns, Git revisions, and package
manager script names after `run`/`run-script` are proven non-paths, while
package manager directory options such as `--prefix` stay gated paths. All Bash
filesystem operands except `cd` targets, including input and output redirections,
use `writePaths` and the `bash` context. Parser errors and semantic uncertainty
ask interactively and block non-interactively. This intentionally avoids
guessing whether an arbitrary command, script, argument, or substitution will
mutate a path. Bash command rules remain a separate layer: they decide whether
the operation itself is allowed, while `writePaths` decides where an allowed
command may access the filesystem. Profile and rule-set bash rules resolve
specificity-first; order only breaks specificity ties. Profiles can deny shell
readers such as `grep` with guidance toward Pi's dedicated read tools when they
want broader read access than Bash access.

For example, this permits dedicated edits throughout `src`, while allowing Bash
only in `src/generated`:

```jsonc
"writePaths": [
  { "pattern": "src/**", "decision": "allow", "contexts": ["edit", "write"] },
  { "pattern": "src/generated/**", "decision": "allow", "contexts": ["bash"] }
]
```

The built-in test-focused profiles recognize conventional `test`, `tests`,
`__tests__`, and `integrationTests` directories, plus `*.test.*`, `*.spec.*`,
`*_test.*`, and `*.cy.*` file names. `builtin:tests-hidden` denies both
dedicated reads and mutations for these paths. `builtin:tests-only` retains the
default read policy and limits dedicated edits/writes and analyzable Bash
filesystem references to those test paths and `/tmp` scratch output; its Bash
denial guidance steers inspection to the dedicated `read`, `grep`, `find`, and
`ls` tools.

Bash output redirection targets use the same `writePaths` rules and `bash`
context as every other Bash path. Absolute and relative targets use the same
matching rules as `edit` and `write`; context-specific rules may still
distinguish dedicated mutations from Bash access.

The standard profiles configure `.env*` files and directories as protected and
`.env.template` as an explicit exception. Search safeguards are derived from the
active profile rather than hard-coded to `.env`: the built-in `grep` tool
combines all configured protected patterns into one exclusion glob, while Bash
`rg`/`ripgrep` receives one exclusion glob per pattern. Pi's built-in `grep`
accepts only one glob, so an include glob that could overlap a protected path
is denied with guidance to use Bash `rg` instead. For example,
`rg --glob '**/*.ts' 'PATTERN' .` retains the caller's TypeScript filter and
receives protected exclusions afterward, so those exclusions cannot be
re-included. Exceptions are not injected as positive globs — ripgrep treats any
positive glob as a whitelist for implicit searches, which would hide every
non-exception file — and they remain reachable because ripgrep searches
explicitly named paths regardless of globs. Raw `grep` and `git grep` are
denied because their recursive behavior cannot be safely rewritten across
supported platforms.

In non-interactive contexts where confirmation is unavailable, `ask` decisions
are blocked by default.

## Protected shell reads

Bash protects `.env*` basename and glob expressions as well as paths with a
slash. This includes forms such as `cat .env`, `head .env.local`, and
`sed -n '1,20p' **/.env*`; a direct `.env.template` path is the sole intended
exception.

Supported shell readers are allowed only when their adapters can identify their
filesystem operands. Static operands are evaluated against `writePaths` using
the Bash context. Ambiguous or dynamic filesystem operands require confirmation
when an interactive UI is available and are blocked non-interactively.
Separately, unsupported reader compositions—such as unbounded globs, pipelines,
substitutions, loops, `xargs`, `eval`, and shell-interpreter `-c` forms—may be
rejected directly when they cannot be analyzed safely. Use Pi's dedicated
`read`, `grep`, or `find` tools when broader read behavior is needed.

These checks are guardrails against accidental exposure, not a kernel-complete
filesystem boundary for arbitrary process execution. Keep secrets unavailable to
the agent process with filesystem permissions, environment isolation, or
sandboxing when strict isolation is required.
