# Taylor Pi Permissions

Pi package that mirrors the curated opencode permission posture and adds switchable profiles:

- `default`: normal Pi system prompt with the current curated permissions
- `worker`: default-like non-interactive subagent policy; rules that normally ask for confirmation deny with guidance instead
- `read-only`: edit/write tools are only allowed for `./handoff.md` and `./progress.md`; read access is limited to the startup directory tree and `/tmp`; bash is limited to inspection commands, non-destructive git history commands, and output redirection to `/tmp`, `./handoff.md`, or `./progress.md`
- `socrates`: Socratic coaching prompt with read-only / no-edit permissions
- optional per-profile `color` and `emoji` metadata for the status line
- explicit deny rules for destructive git operations and protected paths
- automatic model steering and suggested alternatives for configured deny rules
- explicit allow rules for common read-only / low-risk commands
- confirmation for every unspecified bash command
- confirmation before configured tools access paths outside the directory where pi was started

The policy lives in `modules/policy.ts`; reusable runtime helpers also live in `modules/`. Pi discovers only the extension entrypoint in `extensions/`. The Socrates prompt lives in `prompts/socrates.md`.

## Commands

- `/profile` shows the active profile and available profiles.
- `/profile <name>` switches to a profile.
- `/read-only` switches to the read-only permissions profile.
- `/socrates` switches to the Socrates coaching profile.
- `/socrates-off` switches back to the configured default profile.

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
  "profiles": {
    "client-work": {
      "extends": "default",
      "directories": ["~/Code/client"],
    },
  },
}
```

`extends` is optional. When supplied, it names a built-in profile or another
custom profile, and its rules are appended to inherited rules so later rules
continue to override earlier matches. Without it, the profile is fully custom
and must provide every required policy field. Directories may be absolute, use
`~`, or be relative to the directory where Pi was started. Omit `directories`
when no automatic selection is wanted. A missing config file leaves the
portable profiles active. An existing invalid config file keeps the extension
registered but blocks permissions until the file is fixed. `PI_SUBAGENT_PROFILE`
remains authoritative and overrides both directory and persisted profile
selection. TypeScript consumers should import the public policy types from
`taylor-pi-permissions/config`.

## Subagent environment

The package consumes the environment variables exported by `pi-permissions-subagents`:

- `PI_SUBAGENT_PROFILE` selects the initial profile and overrides directory and persisted profile selection in a resumed worker session. An unknown profile fails startup rather than silently granting the default policy.
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
- `readPaths` applies only to the dedicated `read`, `grep`, `find`, and `ls` tools.
- `writePaths` applies to `edit`, `write`, and every Bash filesystem operand, including Bash readers and both input and output redirections. Bash is deliberately treated as write-capable even for apparently read-only commands.
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

Bash syntax is parsed with `unbash`; that proves the shell structure and token boundaries, not the executable semantics of every word. Limited command adapters add command-specific meaning for a small shipped surface, mainly ripgrep/readers and Git, so only clearly understood operands can be treated less conservatively. All Bash filesystem operands, including input and output redirections, use `writePaths` and the `bash` context. Parser errors and semantic uncertainty ask interactively and block non-interactively. This intentionally avoids guessing whether an arbitrary command, script, argument, or substitution will mutate a path. Bash command rules remain a separate layer: they decide whether the operation itself is allowed, while `writePaths` decides where an allowed command may access the filesystem. Profiles can deny shell readers such as `grep` with guidance toward Pi's dedicated read tools when they want broader read access than Bash access.

For example, this permits dedicated edits throughout `src`, while allowing Bash only in `src/generated`:

```jsonc
"writePaths": [
  { "pattern": "src/**", "decision": "allow", "contexts": ["edit", "write"] },
  { "pattern": "src/generated/**", "decision": "allow", "contexts": ["bash"] }
]
```

Each profile defines its protected glob patterns with `protectedPathPatterns`; these are the source of truth rather than an additional hard-coded `.env` policy. Narrow readable exceptions can follow them through `protectedPathExceptions`:

```ts
{
  protectedPathPatterns: ["**/.env*", "**/.db", "**/credentials.json"],
  protectedPathExceptions: ["**/.env.template"],
}
```

Patterns use the same path glob syntax and ordered last-match behavior as other policy rules. They apply to `read`, `grep`, `find`, `ls`, `edit`, and `write`, as well as Bash path references: discovery can disclose secrets, while mutation can damage them. A profile that omits a pattern does not protect that path beyond its ordinary tool rules. Dynamic or unrecognized shell reader forms, and parser errors, fail closed: interactive sessions can ask, while non-interactive sessions block.

Bash output redirection targets use the same `writePaths` rules and `bash` context as every other Bash path. Absolute and relative targets use the same matching rules as `edit` and `write`; context-specific rules may still distinguish dedicated mutations from Bash access.

The standard profiles configure `.env*` files and directories as protected and `.env.template` as an explicit exception. Search safeguards are derived from the active profile rather than hard-coded to `.env`: the built-in `grep` tool combines all configured protected patterns into one exclusion glob, while Bash `rg`/`ripgrep` receives one exclusion per pattern followed by configured exceptions. Caller-supplied globs must be demonstrably unable to match any protected path. Raw `grep` and `git grep` are denied because their recursive behavior cannot be safely rewritten across supported platforms.

In non-interactive contexts where confirmation is unavailable, `ask` decisions are blocked by default.

## Protected shell reads

Bash protects `.env*` basename and glob expressions as well as paths with a
slash. This includes forms such as `cat .env`, `head .env.local`, and
`sed -n '1,20p' **/.env*`; a direct `.env.template` path is the sole intended
exception.

`cat`, `head`, `tail`, `sed`, `nl`, `sort`, `wc`, and `file` are permitted only
when their supported syntax identifies every input as a concrete, policy-approved
path. Dynamic operands, globs (other than a protected expression that is denied),
pipelines, substitutions, loops, `xargs`, `eval`, and shell interpreter `-c`
forms fail closed without a confirmation prompt. Use Pi's `read` tool (with its
`offset` and `limit` options), `grep`, or `find` followed by explicit `read`
calls instead.

These checks are guardrails against accidental exposure, not a kernel-complete
filesystem boundary for arbitrary process execution. Keep secrets unavailable to
the agent process with filesystem permissions, environment isolation, or
sandboxing when strict isolation is required.
