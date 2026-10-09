#!/usr/bin/env node
// Renders agent-specific config from the shared sources in home/.agents.
//
//   home/.agents/skills/<name>    -> home/.claude/skills/<name> (relative symlink)
//   home/.agents/snippets/<id>.md -> home/.claude/skills/<id>/SKILL.md (manual-only /<id> wrapper)
//   home/.agents/agents/<name>.md -> home/.claude/agents/<name>.md
//                                 -> home/.pi/agent/packages/pi-guard-subagents/agents/<name>.md
//
// Every file under the output roots is generated. Run with --check to fail
// when the committed output differs from what the sources produce.
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSnippets, parseFrontmatter } from "../home/.claude/hooks/snippets.mjs";

const REPO_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const SHARED_DIR = join(REPO_DIR, "home/.agents");
const CLAUDE_SKILLS_DIR = join(REPO_DIR, "home/.claude/skills");
const CLAUDE_AGENTS_DIR = join(REPO_DIR, "home/.claude/agents");
const PI_AGENTS_DIR = join(REPO_DIR, "home/.pi/agent/packages/pi-guard-subagents/agents");
const OUTPUT_ROOTS = [CLAUDE_SKILLS_DIR, CLAUDE_AGENTS_DIR, PI_AGENTS_DIR];

// Pi runs OpenAI models and Claude runs Anthropic models from the same agent prompts.
const MODEL_TIERS = {
  default: { pi: "openai/gpt-6.1-sol", claude: "opus" },
  fast: { pi: "openai/gpt-5.6-terra", claude: "haiku" },
};
// Shared agent `tools` use Pi's tool names.
const CLAUDE_TOOLS = { read: "Read", grep: "Grep", find: "Glob", ls: "Glob", bash: "Bash" };
const AGENT_FIELDS = new Set(["name", "description", "tools", "tier", "profile"]);

function frontmatter(fields) {
  return ["---", ...Object.entries(fields).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}: ${v}`), "---", ""].join("\n");
}

function renderAgent(file) {
  const { meta, body } = parseFrontmatter(file, readFileSync(join(SHARED_DIR, "agents", file), "utf8"));
  for (const key of Object.keys(meta)) if (!AGENT_FIELDS.has(key)) throw new Error(`${file}: unknown field ${key}`);
  if (meta.name !== file.slice(0, -".md".length)) throw new Error(`${file}: name must match the file name`);
  if (!meta.description) throw new Error(`${file}: missing description`);
  const tier = MODEL_TIERS[meta.tier];
  if (!tier) throw new Error(`${file}: tier must be one of ${Object.keys(MODEL_TIERS).join(", ")}`);
  const tools = meta.tools?.split(",").map((t) => t.trim());
  const claudeTools = tools?.map((t) => {
    if (!CLAUDE_TOOLS[t]) throw new Error(`${file}: no Claude mapping for tool ${t}`);
    return CLAUDE_TOOLS[t];
  });
  return {
    pi: frontmatter({ name: meta.name, description: meta.description, tools: tools?.join(", "), model: tier.pi, profile: meta.profile }) + body,
    claude: frontmatter({ name: meta.name, description: meta.description, tools: claudeTools && [...new Set(claudeTools)].join(", "), model: tier.claude }) + body,
  };
}

function expectedOutputs() {
  const outputs = new Map();
  const skills = readdirSync(join(SHARED_DIR, "skills")).filter((name) => existsSync(join(SHARED_DIR, "skills", name, "SKILL.md")));
  for (const name of skills) {
    const path = join(CLAUDE_SKILLS_DIR, name);
    outputs.set(path, { symlink: relative(CLAUDE_SKILLS_DIR, join(SHARED_DIR, "skills", name)) });
  }
  for (const snippet of loadSnippets(join(SHARED_DIR, "snippets"))) {
    if (skills.includes(snippet.id)) throw new Error(`snippet ${snippet.id} collides with the shared skill of the same name`);
    const description = `Snippet (${snippet.placement}): ${snippet.description || snippet.name}`;
    outputs.set(join(CLAUDE_SKILLS_DIR, snippet.id, "SKILL.md"), {
      content: frontmatter({ name: snippet.id, description: JSON.stringify(description), "disable-model-invocation": true }) + `\n${snippet.body}\n`,
    });
  }
  for (const file of readdirSync(join(SHARED_DIR, "agents")).filter((f) => f.endsWith(".md"))) {
    const rendered = renderAgent(file);
    outputs.set(join(PI_AGENTS_DIR, file), { content: rendered.pi });
    outputs.set(join(CLAUDE_AGENTS_DIR, file), { content: rendered.claude });
  }
  return outputs;
}

/** Map every file and symlink under the output roots (symlinks are not followed). */
function actualOutputs() {
  const actual = new Map();
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) actual.set(path, { symlink: readlinkSync(path) });
      else if (stat.isDirectory()) walk(path);
      else actual.set(path, { content: readFileSync(path, "utf8") });
    }
  };
  for (const root of OUTPUT_ROOTS) if (existsSync(root)) walk(root);
  return actual;
}

const expected = expectedOutputs();
if (process.argv.includes("--check")) {
  const actual = actualOutputs();
  const stale = [...new Set([...expected.keys(), ...actual.keys()])].filter(
    (path) => JSON.stringify(expected.get(path)) !== JSON.stringify(actual.get(path)),
  );
  if (stale.length > 0) {
    console.error(`Generated agent config is stale; run scripts/generate-agent-config.mjs:\n${stale.map((p) => `  ${relative(REPO_DIR, p)}`).join("\n")}`);
    process.exit(1);
  }
} else {
  for (const root of OUTPUT_ROOTS) rmSync(root, { recursive: true, force: true });
  for (const [path, output] of expected) {
    mkdirSync(dirname(path), { recursive: true });
    if (output.symlink) symlinkSync(output.symlink, path);
    else writeFileSync(path, output.content);
  }
}
