# Narrative review example

`float-comparisons.flow.json` is fictional. Its snippets, source paths, baseline
names, and conclusions are not evidence from a real MR.

After `npm ci` and `npm run build` in the skill directory:

```sh
npm run example
```

Open `/tmp/float-comparisons.flow.html`. Read the story, compare the before/after
flow diagrams, then select a colored node to reveal its code evidence. Code samples
show syntax colors, red deletions, green additions, and inline changed-word emphasis.
The example uses explicitly labeled Python-style pseudocode.

The main document stays focused on two connected themes. Deeper review notes,
verification, and file coverage remain secondary. All colors have accompanying
text labels; changed nodes and arrows are distinguished from existing context.

Use `scripts/schema.ts` as the authoritative TypeBox contract and
`scripts/flow.schema.json` as its generated JSON reference. See the package
`README.md` and `SKILL.md` for authoring and invocation instructions.
