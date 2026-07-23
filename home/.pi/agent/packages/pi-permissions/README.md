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

Configure directories directly on the applicable profiles in `modules/policy.ts`:

```ts
profiles: {
  "performance-review": extendProfile(baseProfile, {
    directories: ["~/Code/client"],
    // ...
  }),
  socrates: {
    directories: ["~/Code/client/docs"],
    // ...
  },
}
```

Directories may be absolute, use `~`, or be relative to the directory where Pi
was started. Omit `directories` when no automatic selection is wanted.
`PI_SUBAGENT_PROFILE` remains authoritative and overrides both directory and
persisted profile selection.

## Subagent environment

The package consumes the environment variables exported by `pi-permissions-subagents`:

- `PI_SUBAGENT_PROFILE` selects the initial profile and overrides directory and persisted profile selection in a resumed worker session. An unknown profile fails startup rather than silently granting the default policy.
- `PI_SUBAGENT_WRITE_GLOBS` is a comma-separated list of paths or glob patterns relative to Pi's startup directory. When present, `edit`, `write`, and path references in Bash commands are denied outside the declared scopes. Plain paths include their descendants; for example, `src` permits both `src` and `src/**`.

The write-scope layer is additional to the selected profile, so protected-path and command restrictions still apply inside an allowed scope. Pi's dedicated read tools retain the profile's normal read access.

Profile status metadata is configured per profile:

```jsonc
"socrates": {
  "color": "cyan", // defaults to blue when omitted
  "emoji": "🧠" // Optional. Have some fun if you want.
}
```

Supported colors: `black`, `red`, `green`, `yellow`, `blue`, `magenta`, `cyan`, `white`.

## Policy model

`tools` is a map of Pi tool names to ordered glob/pattern rules. Later matches override earlier matches.

- `bash` patterns match normalized shell command segments.
- Path tool patterns match paths relative to Pi's startup directory.
- Absolute path patterns such as `/tmp/**` match absolute paths; other patterns match paths relative to Pi's startup directory.
- Outside paths appear as `../...`, so `../**` gates external access.
- `*` is the default rule for a tool.
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

`bashPathReferences` separately gates path-looking tokens inside bash commands, because bash input is both command text and possible path access. Where `protectedPathPatterns` marks specific paths as sensitive across every tool, `bashPathReferences` controls reach: which parts of the filesystem bash commands may touch at all (for example, `../**` keeps bash inside the startup directory).

Each profile defines its protected glob patterns with `protectedPathPatterns`; these are the source of truth rather than an additional hard-coded `.env` policy. Narrow readable exceptions can follow them through `protectedPathExceptions`:

```ts
{
  protectedPathPatterns: ["**/.env*", "**/.db", "**/credentials.json"],
  protectedPathExceptions: ["**/.env.template"],
}
```

Patterns use the same path glob syntax and ordered last-match behavior as other policy rules. They apply to `read`, `grep`, `find`, `ls`, `edit`, and `write`, as well as Bash path references: discovery can disclose secrets, while mutation can damage them. A profile that omits a pattern does not protect that path beyond its ordinary tool rules. Dynamic or unrecognized shell reader forms still fail closed.

`bashOutputRedirections` gates shell output redirection targets. Absolute patterns such as `/tmp/**` match absolute target paths; other patterns match paths relative to Pi's startup directory. The default profile denies shell output redirection except to `/tmp/**`, so scratch output stays outside the project and intentional project writes go through Pi's write/edit tools.

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

These checks are guardrails against accidental exposure, not a security boundary
for arbitrary process execution. Keep secrets unavailable to the agent process
with filesystem permissions, environment isolation, or sandboxing when strict
isolation is required.
