# Taylor Pi Permissions

Pi package that mirrors the curated opencode permission posture and adds switchable profiles:

- `default`: normal Pi system prompt with the current curated permissions
- `read-only`: no edit/write tools and only inspection-oriented bash plus non-destructive git history commands
- `socrates`: Socratic coaching prompt with read-only / no-edit permissions
- optional per-profile `color` and `emoji` metadata for the status line
- explicit deny rules for destructive git operations and protected paths
- automatic model steering and suggested alternatives for configured deny rules
- explicit allow rules for common read-only / low-risk commands
- confirmation for every unspecified bash command
- confirmation before configured tools access paths outside the directory where pi was started

Policy lives in `policy.ts`. The Socrates prompt lives in `prompts/socrates.md`.

## Commands

- `/profile` shows the active profile and available profiles.
- `/profile <name>` switches to a profile.
- `/read-only` switches to the read-only permissions profile.
- `/socrates` switches to the Socrates coaching profile.
- `/socrates-off` switches back to the configured default profile.

Profile changes are persisted in the Pi session, so resumed sessions restore their last selected profile.

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

`bashPathReferences` separately gates path-looking tokens inside bash commands, because bash input is both command text and possible path access.

In non-interactive contexts where confirmation is unavailable, `ask` decisions are blocked by default.
