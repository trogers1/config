import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import piSkillToggle from "./index.ts";
import type { SkillRecord, SkillToggleUiResult } from "./types.ts";

const temporaryDirectories: string[] = [];
const originalAgentDirectory = process.env.PI_CODING_AGENT_DIR;

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
  if (originalAgentDirectory === undefined)
    delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDirectory;
});

describe("pi-skill-toggle extension", () => {
  it.each([
    {
      initial: false,
      expected: true,
      from: "agent-invocable",
      to: "manual-only",
    },
    {
      initial: true,
      expected: false,
      from: "manual-only",
      to: "agent-invocable",
    },
  ] as const)(
    "changes a $from skill to $to through /toggle-skills",
    async ({ initial, expected }) => {
      const root = createTemporaryDirectory();
      const agentDirectory = join(root, "agent");
      const skillDirectory = join(agentDirectory, "skills", "review");
      const skillPath = join(skillDirectory, "SKILL.md");
      mkdirSync(skillDirectory, { recursive: true });
      process.env.PI_CODING_AGENT_DIR = agentDirectory;
      writeFileSync(skillPath, skillFile(initial));

      const skill = record(
        skillPath,
        agentDirectory,
        initial ? "manual-only" : "agent-invocable",
      );
      const uiResult: SkillToggleUiResult = {
        action: "apply",
        drafts: [
          { skill, desiredMode: expected ? "manual-only" : "agent-invocable" },
        ],
      };
      const harness = createCommandHarness(root, uiResult);

      piSkillToggle(harness.api);
      await harness.run("toggle-skills");

      expect(
        readFileSync(skillPath, "utf8").includes(
          "disable-model-invocation: true",
        ),
      ).toBe(expected);
      expect(harness.reload).toHaveBeenCalledOnce();
      expect(harness.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("Pi Skill Toggle applied 1 change"),
        "info",
      );
    },
  );

  it("rejects /toggle-skills outside interactive mode without scanning or reloading", async () => {
    const harness = createCommandHarness(
      process.cwd(),
      { action: "cancel", drafts: [] },
      false,
    );
    piSkillToggle(harness.api);

    await harness.run("toggle-skills");

    expect(harness.ui.notify).toHaveBeenCalledWith(
      "/toggle-skills requires interactive mode",
      "error",
    );
    expect(harness.reload).not.toHaveBeenCalled();
  });
});

function createTemporaryDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), "pi-skill-toggle-"));
  temporaryDirectories.push(root);
  return root;
}

function skillFile(manualOnly: boolean): string {
  return [
    "---",
    "name: review",
    "description: Review changes.",
    ...(manualOnly ? ["disable-model-invocation: true"] : []),
    "---",
    "# Review",
    "",
  ].join("\n");
}

function record(
  path: string,
  agentDirectory: string,
  mode: SkillRecord["mode"],
): SkillRecord {
  return {
    id: path,
    name: "review",
    description: "Review changes.",
    filePath: path,
    baseDir: join(agentDirectory, "skills", "review"),
    source: { kind: "user", root: join(agentDirectory, "skills") },
    editable: true,
    mode,
    diagnostics: [],
  };
}

function createCommandHarness(
  cwd: string,
  result: SkillToggleUiResult,
  hasUI = true,
) {
  const commands = new Map<
    string,
    { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }
  >();
  const reload = vi.fn().mockResolvedValue(undefined);
  const ui = { notify: vi.fn(), custom: vi.fn().mockResolvedValue(result) };
  const context = {
    cwd,
    hasUI,
    ui,
    reload,
  } as unknown as ExtensionCommandContext;
  const api = {
    registerCommand(
      name: string,
      command: {
        handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
      },
    ) {
      commands.set(name, command);
    },
  } as unknown as ExtensionAPI;
  return {
    api,
    reload,
    ui,
    async run(name: string) {
      const command = commands.get(name);
      if (!command) throw new Error(`Command not registered: ${name}`);
      await command.handler("", context);
    },
  };
}
