// Shared snippet parsing for the Claude `+name` marker hook and
// scripts/generate-agent-config.mjs. The file format matches the Pi
// prompt-snippets extension, which reads the same ~/.agents/snippets files.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const SNIPPET_ID = /^[a-z][a-z0-9-]*$/;
const MARKER = /(?<=^|\s)\+([a-z][a-z0-9-]*)(?=$|[\s.,;:!?)])/g;
const DEFAULT_ORDER = 9999;

export function parseFrontmatter(source, raw) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) throw new Error(`${source}: missing frontmatter`);
  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z][\w-]*)\s*:\s*(.*)$/);
    if (!kv) throw new Error(`${source}: unparseable frontmatter line: ${line}`);
    meta[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, "");
  }
  return { meta, body: match[2] };
}

/** Load snippets sorted for application: prepend group, then append group, each by (order, id). */
export function loadSnippets(dir) {
  const snippets = readdirSync(dir)
    .filter((file) => file.endsWith(".md"))
    .map((file) => {
      const id = file.slice(0, -".md".length);
      if (!SNIPPET_ID.test(id)) throw new Error(`${file}: snippet file names must match ${SNIPPET_ID}`);
      const { meta, body } = parseFrontmatter(file, readFileSync(join(dir, file), "utf8"));
      const placement = meta.placement ?? "append";
      if (placement !== "prepend" && placement !== "append") throw new Error(`${file}: invalid placement ${placement}`);
      const order = meta.order === undefined ? DEFAULT_ORDER : Number(meta.order);
      if (!Number.isInteger(order)) throw new Error(`${file}: invalid order ${meta.order}`);
      if (!body.trim()) throw new Error(`${file}: empty snippet body`);
      return { id, name: meta.name ?? id, description: meta.description ?? "", placement, order, body: body.trim() };
    });
  const byOrder = (a, b) => a.order - b.order || a.id.localeCompare(b.id);
  return [
    ...snippets.filter((s) => s.placement === "prepend").sort(byOrder),
    ...snippets.filter((s) => s.placement === "append").sort(byOrder),
  ];
}

/** Find `+id` markers in a prompt; `unknown` holds marker-shaped tokens that match no snippet. */
export function findMarkers(prompt, snippets) {
  const ids = new Set([...prompt.matchAll(MARKER)].map((m) => m[1]));
  return {
    matched: snippets.filter((s) => ids.has(s.id)),
    unknown: [...ids].filter((id) => !snippets.some((s) => s.id === id)),
  };
}
