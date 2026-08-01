# Taylor Pi Permissions

Pi package that mirrors the curated opencode permission posture and adds switchable profiles. Built-in profile names are reserved under the `builtin:` namespace and cannot be overridden by user configuration.

- `builtin:default`: normal Pi system prompt with the current curated permissions; dedicated `read` access to global Pi skills and the installed Pi README/docs is allowed even when they are outside the startup directory
- `builtin:worker`: default-like non-interactive subagent policy; rules that normally ask for confirmation deny with guidance instead
- `builtin:read-only`: edit/write tools are only allowed for `./handoff.md` and `./progress.md`; read access is limited to the startup directory tree and `/tmp`; bash is limited to inspection commands, non-destructive git history commands, and output redirection to `/tmp`, `./handoff.md`, or `./progress.md`
- `builtin:tests-hidden`: extends `builtin:default` for implementation-only work; test files cannot be read or edited, and prompt steering asks the model to fix the system rather than the tests and report tests it believes are incorrect
- `builtin:tests-only`: extends `builtin:default` for documentation-first test-authoring work; prompt steering makes documented behavior the spec (production code is only an interface reference), and only test files can be edited
- optional per-profile `color` and `emoji` metadata for the status line
- explicit deny rules for destructive git operations and protected paths
- automatic model steering and suggested alternatives for configured deny rules
- explicit allow rules for common read-only / low-risk commands
- confirmation for every unspecified bash command
- confirmation before configured tools access paths outside the directory where pi was started

The policy lives in `modules/policy.ts`; reusable runtime helpers also live in `modules/`. Pi discovers only the extension entrypoint in `extensions/`. The Socrates prompt lives in `prompts/socrates.md`.

## Required read-only tools

This package **requires and will activate** pi's built-in `read`, `grep`,
`find`, and `ls` tools. Deny guidance throughout the policy steers agents to
these tools (for example, restrictive profiles deny Bash path operands and
tell the agent to use `grep`/`find`/`ls` for discovery instead), so the gate
assumes they are callable.

On session start and on every profile switch, the extension therefore
activates any missing read tools. Activation is purely additive: tools
enabled by you or by other extensions are never removed, and nothing
changes when the read tools are already active. If a required tool is not
even registered, session start fails loudly — that means the installed pi
version no longer provides a tool this package depends on.

There is no opt-out from the activation itself. If a read tool should not be
usable, keep it active but deny its paths in your custom profile
configuration; context-scoped rules restrict a denial to one tool without
weakening the others:

```jsonc
{
  "profiles": {
    "default": {
      "extends": "default",
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

## Commands

- `/profile` shows the active profile and available profiles.
- `/profile <name>` switches to a profile.
- `/read-only` switches to the `builtin:read-only` permissions profile.

Profile changes are persisted in the Pi session, so resumed sessions restore their last selected profile.

### Directory-selected profiles

`directories` is an optional per-profile setting. When Pi starts or resumes in
a configured directory (including one of its descendants), that profile is
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
      "extends": "builtin:default",
      "directories": ["~/Code/client"],
    },
  },
}
```

`extends` is optional. When supplied, it names a built-in profile by its
canonical name (for example `builtin:default`) or another custom profile.
Custom profile names are exact: `extends: "default"` resolves only a custom
profile literally named `default`; it does not fall back to `builtin:default`.
Non-empty tool-rule arrays and path-rule arrays are appended to inherited
rules, so later rules continue to override earlier matches. An empty
custom-tool array deliberately clears that tool's inherited rules while keeping
the tool configured; because no rule then matches, calls default to `ask`. An
empty `tools.bash` array removes the inherited Bash command rules, which also
leaves Bash commands at the safe `ask` default. Without `extends`, the profile
is fully custom and must provide every required policy field. Directories may
be absolute, use `~`, or be relative to the directory where Pi was started.
Omit `directories` when no automatic selection is wanted. A missing config file
leaves the portable profiles active. An existing invalid config file keeps the
extension registered but blocks permissions until the file is fixed.
`PI_SUBAGENT_PROFILE` remains authoritative and overrides both directory and
persisted profile selection. TypeScript consumers should import the public
policy types from `taylor-pi-permissions/config`.

User-defined profile names must not start with `builtin:`. Defining a profile
such as `builtin:default` in the user configuration is a hard validation error;
the extension remains registered but blocks every tool call until the reserved
name is removed. There are no legacy aliases: old unnamespaced built-in
selectors such as `worker` or `read-only` fail closed with the list of available
canonical names.

## Subagent environment

The package consumes the environment variables exported by `pi-permissions-subagents`:

- `PI_SUBAGENT_PROFILE` selects the initial profile and overrides directory and persisted profile selection in a resumed worker session. Use canonical built-in names such as `builtin:worker`; an unknown or unnamespaced old name like `worker` fails startup with the list of available profiles rather than silently granting the default policy.
- `PI_SUBAGENT_PERMISSIBLE_GLOBS` is a comma-separated list of paths or glob patterns relative to Pi's startup directory. When present, `edit`, `write`, Bash path references, and Bash output redirections are denied outside the declared scopes. Plain paths include their descendants; for example, `src` permits both `src` and `src/**`.

The permissible-scope layer only narrows the selected profile, so protected-path and command restrictions still apply inside an allowed scope. Pi's dedicated read tools retain the profile's normal read access.

Profile status metadata is configured per profile:

```jsonc
"socrates": {
  "color": "cyan", // defaults to blue when omitted
  "emoji": "🧠" // Optional. Have some fun if you want.
}
```

Supported colors: `black`, `red`, `green`, `yellow`, `blue`, `magenta`, `cyan`, `white`.

## Policy model

Profiles have one command-rule map and two ordered path-rule arrays. Later matches override earlier matches.

- `tools.bash` patterns match normalized shell command segments.
- Other `tools.<name>` entries configure custom tools by matching glob patterns against named input properties. The built-in path tools cannot be configured here; they use the path arrays below.
- `readPaths` applies only to the dedicated `read`, `grep`, `find`, and `ls` tools, which this package activates automatically (see [Required read-only tools](#required-read-only-tools)).
- `writePaths` applies to `edit`, `write`, and every Bash filesystem operand, including Bash readers and both input and output redirections. Bash is deliberately treated as write-capable even for apparently read-only commands. The one carve-out is `cd`: it mutates nothing and every later operand is gated individually against the tracked directory, so its target is gated against `readPaths` with the `ls` context instead — changing directory repositions operand-less readers such as bare `ls`.
- A path rule can set `contexts` to restrict itself to particular consumers. Valid read contexts are `read`, `grep`, `find`, and `ls`; valid write contexts are `edit`, `write`, and `bash`. A rule without `contexts` applies to every consumer of its array.
- Absolute path patterns such as `/tmp/**` match absolute paths; other patterns match paths relative to Pi's startup directory.
- Outside paths appear as `../...`, so `../**` gates external access.
- `*` is the default rule for a path array.
- Deny rules can include `guidance` and `alternatives`; these are returned in the blocked tool result, so Pi automatically gives them to the model without another prompt.

For example:

```ts
{
  pattern: "npx vitest *",
  decision: "deny",
  guidance: "Use the repository's configured test script instead.",
  alternatives: ["npm test -- <requested test filters>"],
}
```

Because later matching rules win, steering comes only from the rule that made the final deny decision. For compound bash commands, steering from each denied segment is combined and deduplicated.

### Custom tools

Any tool name other than `bash` and the reserved path tools (`read`, `grep`, `find`, `ls`, `edit`, and `write`) can have profile rules. A custom rule's optional `match` object maps dot-separated input property paths to glob patterns. Every property matcher must match; a rule without `match` is a catch-all. Values are matched as strings, while non-string values use their JSON representation. Later matching rules win, and a configured custom tool with no matching rule defaults to `ask`. If a tool has no configured rules at all, this package does not add a custom-tool policy for it.

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

Built-in path tool names are rejected under `tools` so stale per-tool path configuration cannot silently bypass `readPaths` or `writePaths`.

Bash syntax is parsed with `unbash`; that proves the shell structure and token boundaries, not the executable semantics of every word. Limited command adapters add command-specific meaning for a small shipped surface, mainly ripgrep/readers, package managers, and Git, so only clearly understood operands can be treated less conservatively: ripgrep patterns, Git revisions, and package manager script names after `run`/`run-script` are proven non-paths, while package manager directory options such as `--prefix` stay gated paths. All Bash filesystem operands except `cd` targets, including input and output redirections, use `writePaths` and the `bash` context. Parser errors and semantic uncertainty ask interactively and block non-interactively. This intentionally avoids guessing whether an arbitrary command, script, argument, or substitution will mutate a path. Bash command rules remain a separate layer: they decide whether the operation itself is allowed, while `writePaths` decides where an allowed command may access the filesystem. Profiles can deny shell readers such as `grep` with guidance toward Pi's dedicated read tools when they want broader read access than Bash access.

For example, this permits dedicated edits throughout `src`, while allowing Bash only in `src/generated`:

```jsonc
"writePaths": [
  { "pattern": "src/**", "decision": "allow", "contexts": ["edit", "write"] },
  { "pattern": "src/generated/**", "decision": "allow", "contexts": ["bash"] }
]
```

Each profile defines its protected paths with `protectedPathRules`; these rules are the source of truth rather than an additional hard-coded `.env` policy. Use `allow` rules for narrow exceptions:

```ts
{
  protectedPathRules: [
    { pattern: "**/.env*", decision: "deny" },
    { pattern: "**/.db", decision: "deny" },
    { pattern: "**/credentials.json", decision: "deny" },
    { pattern: "**/.env.template", decision: "allow" },
  ],
}
```

Protected-path rules use the same path glob syntax as other policy rules. They apply specificity-first resolution, using order only as the final tie-breaker. They apply to `read`, `grep`, `find`, `ls`, `edit`, and `write`, as well as Bash path references: discovery can disclose secrets, while mutation can damage them. A profile that omits a protected rule does not protect that path beyond its ordinary tool rules. Dynamic or unrecognized shell reader forms, and parser errors, fail closed: interactive sessions can ask, while non-interactive sessions block.

The built-in test-focused profiles recognize conventional `test`, `tests`, `__tests__`, and `integrationTests` directories, plus `*.test.*`, `*.spec.*`, `*_test.*`, and `*.cy.*` file names. `builtin:tests-hidden` denies both dedicated reads and mutations for these paths. `builtin:tests-only` retains the default read policy and limits dedicated edits/writes and analyzable Bash filesystem references to those test paths and `/tmp` scratch output; its Bash denial guidance steers inspection to the dedicated `read`, `grep`, `find`, and `ls` tools.

Bash output redirection targets use the same `writePaths` rules and `bash` context as every other Bash path. Absolute and relative targets use the same matching rules as `edit` and `write`; context-specific rules may still distinguish dedicated mutations from Bash access.

The standard profiles configure `.env*` files and directories as protected and `.env.template` as an explicit exception. Search safeguards are derived from the active profile rather than hard-coded to `.env`: the built-in `grep` tool combines all configured protected patterns into one exclusion glob, while Bash `rg`/`ripgrep` receives one exclusion glob per pattern. Pi's built-in `grep` accepts only one glob, so an include glob that could overlap a protected path is denied with guidance to use Bash `rg` instead. For example, `rg --glob '**/*.ts' 'PATTERN' .` retains the caller's TypeScript filter and receives protected exclusions afterward, so those exclusions cannot be re-included. Exceptions are not injected as positive globs — ripgrep treats any positive glob as a whitelist for implicit searches, which would hide every non-exception file — and they remain reachable because ripgrep searches explicitly named paths regardless of globs. Raw `grep` and `git grep` are denied because their recursive behavior cannot be safely rewritten across supported platforms.

In non-interactive contexts where confirmation is unavailable, `ask` decisions are blocked by default.

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
