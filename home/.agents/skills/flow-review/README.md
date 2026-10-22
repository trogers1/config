# Flow review renderer

Private TypeScript package for turning a narrative code review into standalone,
offline HTML. This is a local tool, not a published package or web server.

## Setup (config maintenance only)

This is a shared installation used by reviews across repositories and worktrees.
Reviewing agents should use the installed CLI directly, not install or build this
package as part of each review. If it is missing or broken, report the error to the
user rather than switching profiles or retrying with elevated permissions.

The following commands are for an explicitly authorized installation/update in
the config-maintenance context, not for an application review. Avoid reinstalling
while another review is using the tool: `npm ci` replaces shared dependencies.

From this directory:

```sh
npm ci
npm run build
```

The initial dependency installation needs network access. Rendering and opening
the generated HTML do not. Rebuild after changing TypeScript sources. Nothing
needs to be installed separately for another worktree. Do not run setup as root.

## Use

```sh
npm run render -- /path/to/repository/flow.json /path/to/repository/flow.html
npm run validate -- /path/to/repository/flow.json
npm run example
```

The example writes `/tmp/float-comparisons.flow.html`. It is fictional, not evidence
from an actual MR. To invoke from a reviewed repository without changing directory:

```sh
node ~/.agents/skills/flow-review/dist/scripts/render_flow_html.js flow.json flow.html
```

## Authoring

- Lead with the conversational story and its ecosystem context, then group edits
  into themes with concrete code examples.
- Use `before` and `after` for unified diffs; a lone `before` is a deletion, a lone
  `after` an addition. Use `code` for unchanged explanatory excerpts. Do not add
  manual diff prefixes. Red/green lines and stronger changed-word shading show
  what changed while preserving syntax colors.
- Set `language` to a highlight.js language name or alias (`typescript`, `python`,
  `json`, `bash`, etc.). Omit it for plain text. Unknown names fail explicitly.
- Small diagrams show explicit status on both nodes and edges: added (green),
  modified (amber), removed (red/dashed), and unchanged (muted). Changed nodes link
  to evidence examples. Edges default to unchanged unless explicitly labeled.
- Prose is plain text, not HTML or Markdown. Code and prose are escaped. Native
  disclosure sections work offline, with JavaScript enhancing evidence navigation.

## Types and validation

`scripts/schema.ts` is the authoritative TypeBox schema. Types derive with
`Static<typeof Schema>`. Untrusted JSON enters through `parseOrThrow`/`parseReview`;
no unchecked casts or duplicated review interfaces are needed. `parseReview` also
checks cross-references and semantic invariants. Build regenerates
`scripts/flow.schema.json` as an agent-readable reference; do not edit that JSON.

Runtime dependencies are TypeBox (types and validation), highlight.js (syntax),
and diff (line/word comparison). They are installed normally, not vendored or
loaded through a VM. Only rendered markup and styles are embedded in output HTML.

```sh
npm run typecheck
npm test
```

The small CLI smoke suite exercises rendering, invalid-input rejection, and escaping.
Visual presentation is intended for human QA.
