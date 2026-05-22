# Taylor Pi Permissions

Pi package that mirrors the curated opencode permission posture:

- explicit deny rules for destructive git operations and protected reads
- explicit allow rules for common read-only / low-risk commands
- confirmation for every unspecified bash command
- confirmation before filesystem tools access paths outside the directory where pi was started

In non-interactive contexts where confirmation is unavailable, `ask` decisions are blocked by default.
