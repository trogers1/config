import { existsSync, readFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import {
  CLAUDE_EXECUTABLE_ENV,
  CLAUDE_CLI_VERSION_CONTRACT,
  ClaudeCliVersionSchema,
  SDK_RUNTIME_METADATA,
} from "../extensions/cli.ts";
import { parseOrThrow } from "../extensions/validation.ts";
import { PROMPT, RESPONSE_TEXT } from "./contract.ts";
import { createFakeClaudeCli } from "./fixtures/claude-cli.ts";
import { configureFake, observations } from "./fixtures/fake-sdk.ts";
import { createTestSession, lastAssistant } from "./fixtures/session.ts";

vi.mock("@anthropic-ai/claude-agent-sdk", async () => ({
  query: (await import("./fixtures/fake-sdk.ts")).fakeQuery,
}));

let active: Awaited<ReturnType<typeof createTestSession>> | undefined;
const extraExecutions: string[] = [];
afterEach(() => {
  try {
    const markers = [active?.unexpectedClaudeExecution, ...extraExecutions];
    for (const marker of markers) if (marker) expect(existsSync(marker)).toBe(false);
  } finally {
    active?.dispose();
    active = undefined;
    extraExecutions.length = 0;
  }
});
async function setup() {
  configureFake({ next: "text" });
  active = await createTestSession();
  return active;
}

test("the owned provider selects the absolute user CLI and caches only its metadata inspection", async () => {
  const run = await setup();
  await run.session.prompt(PROMPT);
  expect(lastAssistant(run).stopReason, lastAssistant(run).errorMessage).toBe("stop");
  expect(observations[0]?.options.pathToClaudeCodeExecutable).toBe(run.claudeExecutable);
  await run.session.prompt("continue with the same installed CLI");
  expect(lastAssistant(run).stopReason, lastAssistant(run).errorMessage).toBe("stop");
  expect(observations[1]?.options.pathToClaudeCodeExecutable).toBe(run.claudeExecutable);
  if (!run.cliMetadataRequests) throw new Error("Missing metadata-only CLI fixture");
  expect(readFileSync(run.cliMetadataRequests, "utf8").trim().split("\n")).toHaveLength(1);
});

test("PATH discovery skips relative and project entries and selects the external installed CLI", async () => {
  const run = await setup();
  const project = createFakeClaudeCli({ directory: join(run.cwd, "project-cli") });
  extraExecutions.push(project.unexpectedExecution);
  delete process.env[CLAUDE_EXECUTABLE_ENV];
  if (!run.claudeExecutable) throw new Error("Missing installed CLI fixture");
  process.env.PATH = ["", ".", dirname(project.executable), dirname(run.claudeExecutable)].join(
    delimiter,
  );
  await run.session.prompt(PROMPT);
  expect(lastAssistant(run).stopReason, lastAssistant(run).errorMessage).toBe("stop");
  expect(observations[0]?.options.pathToClaudeCodeExecutable).toBe(run.claudeExecutable);
  expect(existsSync(project.metadataRequests)).toBe(false);
});

for (const selection of ["relative", "missing", "project", "absent-PATH", "invalid-metadata"]) {
  test(`${selection} CLI selection fails before SDK query; the packaged runtime is never a fallback`, async () => {
    const run = await setup();
    if (selection === "relative") process.env[CLAUDE_EXECUTABLE_ENV] = "./claude";
    else if (selection === "missing")
      process.env[CLAUDE_EXECUTABLE_ENV] = join(run.temp, "missing-cli");
    else if (selection === "absent-PATH") {
      delete process.env[CLAUDE_EXECUTABLE_ENV];
      process.env.PATH = ["", ".", run.cwd].join(delimiter);
    } else {
      const cli = createFakeClaudeCli({
        directory: join(selection === "project" ? run.cwd : run.temp, "alternate-cli"),
        ...(selection === "invalid-metadata" ? { output: "not official Claude CLI metadata" } : {}),
      });
      extraExecutions.push(cli.unexpectedExecution);
      process.env[CLAUDE_EXECUTABLE_ENV] = cli.executable;
    }
    await run.session.prompt(PROMPT);
    expect(lastAssistant(run).stopReason).toBe("error");
    expect(lastAssistant(run).errorMessage).toMatch(/Claude|CLAUDE/);
    expect(observations).toHaveLength(0);
  });
}

for (const { name, version, supported } of [
  {
    name: "official version immediately below the isolation capability floor",
    version: CLAUDE_CLI_VERSION_CONTRACT.minimumVersion.replace(/\d+$/, (patch) =>
      String(BigInt(patch) - 1n),
    ),
    supported: false,
  },
  {
    name: "exact isolation capability floor",
    version: CLAUDE_CLI_VERSION_CONTRACT.minimumVersion,
    supported: true,
  },
  {
    name: "current SDK-declared runtime version",
    version: SDK_RUNTIME_METADATA.claudeCodeVersion,
    supported: true,
  },
]) {
  test(`${name} is checked before SDK dispatch without substituting the bundled runtime`, async () => {
    const run = await setup();
    const cli = createFakeClaudeCli({
      directory: join(run.temp, "capability-checked-cli"),
      version,
    });
    extraExecutions.push(cli.unexpectedExecution);
    process.env[CLAUDE_EXECUTABLE_ENV] = cli.executable;
    await run.session.prompt(PROMPT);
    expect(existsSync(cli.metadataRequests)).toBe(true);
    if (supported) {
      expect(lastAssistant(run).stopReason, lastAssistant(run).errorMessage).toBe("stop");
      expect(run.session.getLastAssistantText()).toBe(RESPONSE_TEXT);
      expect(observations).toHaveLength(1);
      expect(observations[0]?.options.pathToClaudeCodeExecutable).toBe(cli.executable);
    } else {
      expect(lastAssistant(run).stopReason).toBe("error");
      expect(lastAssistant(run).errorMessage).toContain(CLAUDE_CLI_VERSION_CONTRACT.minimumVersion);
      expect(lastAssistant(run).errorMessage).toContain(
        CLAUDE_CLI_VERSION_CONTRACT.requiredCapability,
      );
      expect(observations).toHaveLength(0);
    }
  });
}

test("a different valid installed CLI version is selected instead of silently using the SDK's packaged version", async () => {
  const run = await setup();
  const version = parseOrThrow({
    value: SDK_RUNTIME_METADATA.claudeCodeVersion.replace(/\d+$/, (patch) =>
      String(Number(patch) + 1),
    ),
    schema: ClaudeCliVersionSchema,
    source: "different installed CLI fixture version",
  });
  const cli = createFakeClaudeCli({
    directory: join(run.temp, "different-installed-cli"),
    version,
  });
  extraExecutions.push(cli.unexpectedExecution);
  process.env[CLAUDE_EXECUTABLE_ENV] = cli.executable;
  await run.session.prompt(PROMPT);
  expect(lastAssistant(run).stopReason, lastAssistant(run).errorMessage).toBe("stop");
  expect(run.session.getLastAssistantText()).toBe(RESPONSE_TEXT);
  expect(observations[0]?.options.pathToClaudeCodeExecutable).toBe(cli.executable);
  expect(existsSync(cli.metadataRequests)).toBe(true);
});
