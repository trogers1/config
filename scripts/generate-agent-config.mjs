#!/usr/bin/env node
// Renders agent-specific config from the shared sources in home/.agents.
//
//   home/.agents/skills/<name>    -> home/.claude/skills/<name> (relative symlink)
//   home/.agents/snippets/<id>.md -> home/.claude/skills/<id>/SKILL.md (manual-only /<id> wrapper)
//   home/.agents/agents/<name>.md -> home/.claude/agents/<name>.md
//                                 -> home/.pi/agent/packages/pi-guard-subagents/agents/<name>.md
//
// Only entries recorded in the generated ownership manifest are owned; siblings may be
// synchronized externally. Run --check to detect stale owned output.
// Repeat --skill <name> to generate/check only those shared skill links,
// preserving unrelated outputs (including externally synced resources).
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadSnippets,
  parseFrontmatter,
} from "../home/.claude/hooks/snippets.mjs";

const REPO_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const SHARED_DIR = join(REPO_DIR, "home/.agents");
const CLAUDE_SKILLS_DIR = join(REPO_DIR, "home/.claude/skills");
const CLAUDE_AGENTS_DIR = join(REPO_DIR, "home/.claude/agents");
const PI_AGENTS_DIR = join(
  REPO_DIR,
  "home/.pi/agent/packages/pi-guard-subagents/agents",
);
const OWNERSHIP_PATH = join(
  REPO_DIR,
  "scripts/generated-agent-config-ownership.json",
);
const OUTPUT_ROOTS = [CLAUDE_SKILLS_DIR, CLAUDE_AGENTS_DIR, PI_AGENTS_DIR];

// Persist portable repository paths even when native filesystem paths use \\.
function repositoryPath({ path }) {
  return relative(REPO_DIR, path).split(sep).join("/");
}

function readOwnership() {
  const stat = lstatSync(OWNERSHIP_PATH, { throwIfNoEntry: false });
  if (!stat) return [];
  if (!stat.isFile())
    throw new Error(
      `Generated ownership manifest must be a regular file: ${OWNERSHIP_PATH}`,
    );
  const paths = JSON.parse(readFileSync(OWNERSHIP_PATH, "utf8"));
  if (
    !Array.isArray(paths) ||
    paths.some((path) => {
      if (typeof path !== "string") return true;
      return !OUTPUT_ROOTS.some((root) => {
        const prefix = `${repositoryPath({ path: root })}/`;
        if (!path.startsWith(prefix)) return false;
        const name = path.slice(prefix.length);
        return root === CLAUDE_SKILLS_DIR
          ? /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)
          : /^[a-z0-9]+(?:-[a-z0-9]+)*\.md$/.test(name);
      });
    }) ||
    new Set(paths).size !== paths.length
  ) {
    throw new Error(`Invalid generated ownership manifest: ${OWNERSHIP_PATH}`);
  }
  return paths.map((path) => join(REPO_DIR, path));
}

// Pi runs OpenAI models and Claude runs Anthropic models from the same agent prompts.
const MODEL_TIERS = {
  default: { pi: "openai/gpt-6.1-sol", claude: "opus" },
  fast: { pi: "openai/gpt-6.1-sol", claude: "haiku" },
};
// Shared agent `tools` use Pi's tool names.
const CLAUDE_TOOLS = {
  read: "Read",
  grep: "Grep",
  find: "Glob",
  ls: "Glob",
  bash: "Bash",
};
const AGENT_FIELDS = new Set([
  "name",
  "description",
  "tools",
  "tier",
  "profile",
]);

function frontmatter({ fields }) {
  return [
    "---",
    ...Object.entries(fields)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}: ${v}`),
    "---",
    "",
  ].join("\n");
}

function renderAgent({ file }) {
  const { meta, body } = parseFrontmatter(
    file,
    readFileSync(join(SHARED_DIR, "agents", file), "utf8"),
  );
  for (const key of Object.keys(meta))
    if (!AGENT_FIELDS.has(key))
      throw new Error(`${file}: unknown field ${key}`);
  if (meta.name !== file.slice(0, -".md".length))
    throw new Error(`${file}: name must match the file name`);
  if (!meta.description) throw new Error(`${file}: missing description`);
  const tier = MODEL_TIERS[meta.tier];
  if (!tier)
    throw new Error(
      `${file}: tier must be one of ${Object.keys(MODEL_TIERS).join(", ")}`,
    );
  const tools = meta.tools?.split(",").map((t) => t.trim());
  const claudeTools = tools?.map((t) => {
    if (!CLAUDE_TOOLS[t])
      throw new Error(`${file}: no Claude mapping for tool ${t}`);
    return CLAUDE_TOOLS[t];
  });
  return {
    pi:
      frontmatter({
        fields: {
          name: meta.name,
          description: meta.description,
          tools: tools?.join(", "),
          model: tier.pi,
          profile: meta.profile,
        },
      }) + body,
    claude:
      frontmatter({
        fields: {
          name: meta.name,
          description: meta.description,
          tools: claudeTools && [...new Set(claudeTools)].join(", "),
          model: tier.claude,
        },
      }) + body,
  };
}

function expectedOutputs({ skillNames }) {
  const outputs = new Map();
  const skills = readdirSync(join(SHARED_DIR, "skills")).filter((name) =>
    existsSync(join(SHARED_DIR, "skills", name, "SKILL.md")),
  );
  for (const name of skillNames) {
    if (!skills.includes(name))
      throw new Error(`Unknown shared skill: ${name}`);
  }
  const snippets = loadSnippets(join(SHARED_DIR, "snippets"));
  for (const snippet of snippets) {
    if (skills.includes(snippet.id))
      throw new Error(
        `snippet ${snippet.id} collides with the shared skill of the same name`,
      );
  }
  for (const name of skillNames.length ? skillNames : skills) {
    const path = join(CLAUDE_SKILLS_DIR, name);
    outputs.set(path, {
      symlink: relative(CLAUDE_SKILLS_DIR, join(SHARED_DIR, "skills", name)),
    });
  }
  if (skillNames.length) return outputs;
  for (const snippet of snippets) {
    const description = `Snippet (${snippet.placement}): ${snippet.description || snippet.name}`;
    outputs.set(join(CLAUDE_SKILLS_DIR, snippet.id, "SKILL.md"), {
      content:
        frontmatter({
          fields: {
            name: snippet.id,
            description: JSON.stringify(description),
            "disable-model-invocation": true,
          },
        }) + `\n${snippet.body}\n`,
    });
  }
  for (const file of readdirSync(join(SHARED_DIR, "agents")).filter((f) =>
    f.endsWith(".md"),
  )) {
    const rendered = renderAgent({ file });
    outputs.set(join(PI_AGENTS_DIR, file), { content: rendered.pi });
    outputs.set(join(CLAUDE_AGENTS_DIR, file), { content: rendered.claude });
  }
  return outputs;
}

/** Map every file and symlink under the output roots (symlinks are not followed). */
function actualOutputs({ roots }) {
  const actual = new Map();
  const walk = ({ dir }) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink())
        actual.set(path, { symlink: readlinkSync(path) });
      else if (stat.isDirectory()) walk({ dir: path });
      else actual.set(path, { content: readFileSync(path, "utf8") });
    }
  };
  for (const root of roots) {
    const stat = lstatSync(root, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink())
      actual.set(root, { symlink: readlinkSync(root) });
    else if (stat?.isDirectory()) walk({ dir: root });
    else if (stat) actual.set(root, { content: readFileSync(root, "utf8") });
  }
  return actual;
}

const skillNames = [];
let check = false;
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index++) {
  const arg = args[index];
  if (arg === "--check") check = true;
  else if (arg === "--skill") {
    const name = args[++index];
    if (!name || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name))
      throw new Error("--skill requires a shared skill name");
    if (!skillNames.includes(name)) skillNames.push(name);
  } else throw new Error(`Unknown option: ${arg}`);
}
const expected = expectedOutputs({ skillNames });
const previousRoots = readOwnership();
const currentRoots = [
  ...new Set(
    [...expected.keys()].map((path) =>
      basename(path) === "SKILL.md" ? dirname(path) : path,
    ),
  ),
];
// A scoped operation only changes selected entries; keep all other ownership.
const nextRoots = skillNames.length
  ? [...new Set([...previousRoots, ...currentRoots])]
  : currentRoots;
const manifest =
  JSON.stringify(
    nextRoots.map((path) => repositoryPath({ path })).sort(),
    null,
    2,
  ) + "\n";
expected.set(OWNERSHIP_PATH, { content: manifest });
const roots = [
  ...new Set([
    ...(skillNames.length ? currentRoots : [...previousRoots, ...currentRoots]),
    OWNERSHIP_PATH,
  ]),
];
if (check) {
  const actual = actualOutputs({ roots });
  const stale = [...new Set([...expected.keys(), ...actual.keys()])].filter(
    (path) =>
      JSON.stringify(expected.get(path)) !== JSON.stringify(actual.get(path)),
  );
  if (stale.length > 0) {
    const selection = skillNames.map((name) => ` --skill ${name}`).join("");
    console.error(
      `Generated agent config is stale; run scripts/generate-agent-config.mjs${selection}:\n${stale.map((path) => `  ${repositoryPath({ path })}`).join("\n")}`,
    );
    process.exit(1);
  }
} else {
  for (const root of roots) {
    if (root !== OWNERSHIP_PATH) rmSync(root, { recursive: true, force: true });
  }
  for (const [path, output] of expected) {
    mkdirSync(dirname(path), { recursive: true });
    if (output.symlink) symlinkSync(output.symlink, path);
    else writeFileSync(path, output.content);
  }
}
