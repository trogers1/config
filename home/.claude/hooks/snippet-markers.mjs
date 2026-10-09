#!/usr/bin/env node
// Claude UserPromptSubmit hook: `+name` anywhere in a prompt attaches the
// matching ~/.agents/snippets/<name>.md body as additional context.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { findMarkers, loadSnippets } from "./snippets.mjs";

const { prompt } = JSON.parse(readFileSync(0, "utf8"));
const snippets = loadSnippets(join(homedir(), ".agents", "snippets"));
const { matched, unknown } = findMarkers(prompt, snippets);

const output = {};
if (matched.length > 0) {
  const blocks = matched.map((s) => `<snippet name="${s.id}" placement="${s.placement}">\n${s.body}\n</snippet>`);
  output.hookSpecificOutput = {
    hookEventName: "UserPromptSubmit",
    additionalContext: [
      "The user attached these prompt snippets to their message with +name markers. Treat each as part of the message, placed before or after it as its placement says.",
      ...blocks,
    ].join("\n\n"),
  };
}
if (unknown.length > 0) {
  output.systemMessage = `Unknown snippet marker(s): ${unknown.map((id) => `+${id}`).join(", ")}. Available: ${snippets.map((s) => `+${s.id}`).sort().join(", ")}`;
}
if (Object.keys(output).length > 0) process.stdout.write(JSON.stringify(output));
