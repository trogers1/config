# pi-skill-toggle

> Originally copied from [dmmulroy/.dotfiles](https://github.com/dmmulroy/.dotfiles/tree/main/home/.pi/agent/extensions/pi-skill-toggle), then adapted into this Pi package.

A Pi package that provides `/toggle-skills`, an interactive picker for choosing
whether each discovered skill is available for automatic model invocation or
only as an explicit slash command.

## Use

Start Pi, then run:

```text
/toggle-skills
```

The overlay lists the skill's current and desired mode, source, path,
description, and diagnostics.

- Type to filter.
- Use <kbd>↑</kbd>/<kbd>↓</kbd> to select a skill.
- Press <kbd>Space</kbd> to toggle an editable skill.
- Press <kbd>Ctrl</kbd>+<kbd>S</kbd> to save and reload Pi resources.
- Press <kbd>Esc</kbd> to discard changes.

The package changes only the `disable-model-invocation` frontmatter key:

```yaml
---
name: review
# Agent-invocable (the default): omit disable-model-invocation.
description: Review a change set.
---
```

```yaml
---
name: review
# Manual-only: available through /skill:review, but not automatic invocation.
description: Review a change set.
disable-model-invocation: true
---
```

Changes are written atomically and re-read before writing, so a skill changed
while the picker was open is skipped rather than overwritten. Saving triggers
Pi's normal resource reload, making the updated modes effective immediately.

## Discovery and safety

The picker scans the same supported locations as Pi:

| Source         | Location                                                      |
| -------------- | ------------------------------------------------------------- |
| User           | `$PI_CODING_AGENT_DIR/skills` (normally `~/.pi/agent/skills`) |
| Global         | `~/.agents/skills`                                            |
| Project        | `.pi/skills`                                                  |
| Legacy project | `.agents/skills`                                              |

It preserves Pi's discovery rules: user and `.pi/skills` root Markdown files
are eligible skills; global and legacy project roots require a `SKILL.md` in a
skill directory.

Skills without valid frontmatter, a required `description`, or write permission
are displayed with diagnostics and cannot be edited. Duplicate
`disable-model-invocation` keys are normalized when the skill is saved.

## Installation

This repository registers the package in `home/.pi/agent/settings.json`.
After applying the repository's normal symlink setup, restart Pi or run
`/reload`.

## Implementation conventions

Package-owned constructors and functions with multiple inputs use a single
named argument object. This keeps orchestration and UI calls legible and makes
future parameters additive rather than position-sensitive. For example:

```ts
const planner = new DefaultSkillTogglePlanner({ fs, codec, patcher });
const changes = await planner.plan({ records, drafts });
```

The extension's external Pi callbacks retain Pi's required positional API.

## Development

```bash
cd home/.pi/agent/packages/pi-skill-toggle
npm test
```

`npm test` runs the complete local gate before Vitest:

- strict TypeScript checking
- ESLint
- dependency-cruiser architecture checks
- Knip unused-code/dependency checks
- Prettier
- behavioral command tests plus focused frontmatter and discovery tests

Use `npm run test:watch` while iterating and `npm run fix:prettier` to apply
formatting fixes.
