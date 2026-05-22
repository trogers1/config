# Taylor Pi Permissions

Pi package that mirrors the curated opencode permission posture:

- explicit deny rules for destructive git operations and protected paths
- explicit allow rules for common read-only / low-risk commands
- confirmation for every unspecified bash command
- confirmation before configured tools access paths outside the directory where pi was started

Policy lives in `policy.jsonc`.

## Policy model

`tools` is a map of Pi tool names to ordered glob/pattern rules. Later matches override earlier matches.

- `bash` patterns match normalized shell command segments.
- Path tool patterns match paths relative to Pi's startup directory.
- Outside paths appear as `../...`, so `../**` gates external access.
- `*` is the default rule for a tool.

`bashPathReferences` separately gates path-looking tokens inside bash commands, because bash input is both command text and possible path access.

In non-interactive contexts where confirmation is unavailable, `ask` decisions are blocked by default.
