import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { loadSkills } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, test, vi } from "vitest";
import {
  getCurrentSystemMessage,
  getCurrentSystemPrompt,
  getSystemMessageText,
} from "@earendil-works/pi-ai";
import { CLAUDE_BRIDGE_PROVIDER } from "../../pi-guard-subagents/extensions/interactive/provider-extensions.ts";
import { MCP_NAME } from "../extensions/mcp.ts";
import { PayloadSchema } from "../extensions/transcript.ts";
import { parseOrThrow } from "../extensions/validation.ts";
import {
  PROMPT,
  PROTECTED_CONTENT,
  READ_DEFINITION,
  RESPONSE_TEXT,
  SDK_USAGE,
  SKILL_READ_ARGS,
  PROTECTED_SKILL_ARGS,
  THINKING_SIGNATURE,
  THINKING_TEXT,
  WRITE_ARGS,
  WRITE_DEFINITION,
} from "./contract.ts";
import { configureFake, observations, type Scenario } from "./fixtures/fake-sdk.ts";
import { createTestSession, lastAssistant as assistant } from "./fixtures/session.ts";

vi.mock("@anthropic-ai/claude-agent-sdk", async () => ({
  query: (await import("./fixtures/fake-sdk.ts")).fakeQuery,
}));

let active: Awaited<ReturnType<typeof createTestSession>> | undefined;
afterEach(() => {
  active?.dispose();
  active = undefined;
});
async function setup({ scenario = "text" }: { scenario?: Scenario } = {}) {
  configureFake({ next: scenario });
  active = await createTestSession();
  return active;
}

for (const scenario of ["text", "empty", "thinking"] satisfies Scenario[]) {
  test(`${scenario}: real Pi receives one block despite early SDK assistant echo, and accurate usage`, async () => {
    const run = await setup({ scenario });
    await run.session.prompt(PROMPT);
    const message = assistant(run);
    expect(message.stopReason, message.errorMessage).toBe("stop");
    if (scenario === "thinking")
      expect(message.content).toEqual([
        { type: "thinking", thinking: THINKING_TEXT, thinkingSignature: THINKING_SIGNATURE },
        { type: "text", text: RESPONSE_TEXT },
      ]);
    expect(message.provider).toBe(CLAUDE_BRIDGE_PROVIDER);
    expect(message.stopReason).toBe("stop");
    expect(run.session.getLastAssistantText()).toBe(
      scenario === "empty" ? undefined : RESPONSE_TEXT,
    );
    if (scenario === "empty") expect(message.content).toEqual([{ type: "text", text: "" }]);
    expect(message.usage).toMatchObject({
      input: SDK_USAGE.input_tokens,
      output: SDK_USAGE.output_tokens,
      cacheRead: SDK_USAGE.cache_read_input_tokens,
      cacheWrite: SDK_USAGE.cache_creation_input_tokens,
      totalTokens: Object.values(SDK_USAGE).reduce((sum, count) => sum + count, 0),
    });
    expect(observations).toHaveLength(1);
    expect(observations[0]?.closed).toBe(true);
    const updates = run.events
      .filter((event) => event.type === "message_update")
      .map((event) => event.assistantMessageEvent.type);
    expect(updates.filter((type) => type === "text_start")).toHaveLength(
      updates.filter((type) => type === "text_end").length,
    );
    expect(
      run.events.filter(
        (event) => event.type === "message_end" && event.message.role === "assistant",
      ),
    ).toHaveLength(1);
  });
}

test("native base replaces only verified stock Pi preamble/docs and retains other structured instructions", async () => {
  const run = await setup();
  const original = run.session.agent.streamFunction;
  let expectedSystem = "";
  let sectionCount = 0;
  let guardSection = "";
  run.session.agent.streamFunction = (model, context, options) => {
    const current = getCurrentSystemMessage(context.messages);
    if (!current?.sections) throw new Error("Missing structured Pi prompt");
    const { preamble, docs, ...preserved } = current.sections;
    guardSection = preserved.pi_guard ?? "";
    expect(preamble).toBeTruthy();
    expect(docs).toBeTruthy();
    expectedSystem = getSystemMessageText({ ...current, sections: preserved });
    sectionCount = context.messages.reduce(
      (count, message) =>
        count + (message.role === "system" ? Object.keys(message.sections ?? {}).length : 0),
      0,
    );
    return original(model, context, options);
  };
  await run.session.prompt(PROMPT);
  expect(assistant(run).stopReason).toBe("stop");
  expect(sectionCount).toBeGreaterThan(0);
  expect(expectedSystem.length).toBeGreaterThan(0);
  expect(observations[0]?.options.systemPrompt).toEqual({
    type: "preset",
    preset: "claude_code",
    append: expectedSystem,
  });
  expect(guardSection.length).toBeGreaterThan(0);
  expect(expectedSystem).toContain(guardSection);
  expect(expectedSystem.isWellFormed()).toBe(true);
  expect(expectedSystem.includes("\u0000")).toBe(false);
});

for (const mode of ["customized", "opaque", "payload"]) {
  test(`${mode} prompt ownership preserves instructions verbatim with the native base`, async () => {
    configureFake({ next: "text" });
    const custom = "Keep this custom instruction, including literal /code and @shared.md.";
    active = await createTestSession({
      extensions: [
        (pi) => {
          pi.on("before_agent_start", (event) => {
            if (mode === "opaque") return { systemPrompt: custom };
            if (mode === "customized") {
              event.systemPromptOptions.customPrompt = custom;
              event.systemPromptOptions.sections.docs = custom;
              event.systemPromptOptions.sections.shared_reference = "Read @shared.md through Pi.";
              event.systemPromptOptions.contextFiles.push({ path: "AGENTS.md", content: custom });
            }
          });
          if (mode === "payload")
            pi.on("before_provider_request", (event) => {
              const payload = parseOrThrow({
                schema: PayloadSchema,
                value: event.payload,
                source: "opaque system rewrite fixture",
              });
              return { ...payload, systemPrompt: custom };
            });
        },
      ],
    });
    const run = active;
    const original = run.session.agent.streamFunction;
    let expected = custom;
    run.session.agent.streamFunction = (model, context, options) => {
      if (mode !== "payload") expected = getCurrentSystemPrompt(context.messages);
      return original(model, context, options);
    };
    const literal = "Already expanded snippet: /code @shared.md <snippet>literal</snippet>";
    await run.session.prompt(literal);
    expect(assistant(run).stopReason).toBe("stop");
    expect(observations[0]?.options.systemPrompt).toEqual({
      type: "preset",
      preset: "claude_code",
      append: expected,
    });
    expect(JSON.stringify(observations[0]?.inputs).split(literal)).toHaveLength(2);
  });
}

test("Pi-managed skill references load files only through guarded Pi reads", async () => {
  configureFake({ next: "skill-files" });
  const allowed = "Follow the permitted skill instructions.";
  const protectedBody = "Protected skill instructions must never reach the model.";
  active = await createTestSession({
    extensions: [
      (pi) => {
        pi.on("before_agent_start", (event, ctx) => {
          const loaded = loadSkills({
            cwd: ctx.cwd,
            agentDir: dirname(ctx.cwd),
            skillPaths: [join(ctx.cwd, "skills")],
            includeDefaults: false,
          });
          expect(loaded.diagnostics).toEqual([]);
          expect(loaded.skills).toHaveLength(2);
          event.systemPromptOptions.skills.push(...loaded.skills);
        });
      },
    ],
  });
  const run = active;
  for (const { path, name, content } of [
    { path: SKILL_READ_ARGS.path, name: "allowed", content: allowed },
    { path: PROTECTED_SKILL_ARGS.path, name: "protected", content: protectedBody },
  ]) {
    const file = join(run.cwd, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      `---\nname: ${name}\ndescription: Fixture ${name} skill\n---\n${content}\n`,
    );
  }
  await run.session.prompt(PROMPT);
  expect(assistant(run).stopReason).toBe("stop");
  expect(observations).toHaveLength(1);
  const observed = observations[0];
  expect(JSON.stringify(observed?.options.systemPrompt)).toContain(SKILL_READ_ARGS.path);
  expect(JSON.stringify(observed?.options.systemPrompt)).toContain(PROTECTED_SKILL_ARGS.path);
  expect(observed?.options.tools).toEqual([]);
  expect(observed?.options.skills).toEqual([]);
  expect(observed?.results).toHaveLength(2);
  expect(observed?.results[0]?.result.isError).not.toBe(true);
  expect(JSON.stringify(observed?.results[0]?.result.content)).toContain(allowed);
  expect(observed?.results[1]?.result.isError).toBe(true);
  expect(JSON.stringify(observed?.results)).not.toContain(protectedBody);
  expect(JSON.stringify(observed?.results[1]?.result.content)).toContain("pi-guard");
});

test("real write/read tools execute only through Pi; the original MCP query waits for both results", async () => {
  const run = await setup({ scenario: "pipeline" });
  await run.session.prompt(PROMPT);
  expect(
    run.session.messages.filter((message) => message.role === "toolResult" && message.isError),
  ).toEqual([]);
  expect(readFileSync(join(run.cwd, WRITE_ARGS.path), "utf8")).toBe(WRITE_ARGS.content);
  expect(assistant(run).stopReason).toBe("stop");
  expect(observations).toHaveLength(1);
  expect(observations[0]?.results).toHaveLength(2);
  expect(observations[0]?.results[1]?.result.content).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ type: "text", text: expect.stringContaining(WRITE_ARGS.content) }),
    ]),
  );
  const results = run.session.messages.filter((message) => message.role === "toolResult");
  expect(results.map((message) => message.toolName)).toEqual([
    WRITE_DEFINITION.name,
    READ_DEFINITION.name,
  ]);
  expect(results.every((message) => !message.isError)).toBe(true);
});

test("same-name siblings and reverse/delayed MCP dispatch preserve IDs, including real guard denial", async () => {
  const run = await setup({ scenario: "parallel" });
  run.session.agent.toolExecution = "parallel";
  await run.session.prompt(PROMPT);
  expect(assistant(run).stopReason).toBe("stop");
  expect(observations).toHaveLength(1);
  const replies = observations[0]?.results;
  expect(replies).toHaveLength(3);
  const results = run.session.messages.filter((message) => message.role === "toolResult");
  for (const entry of replies ?? []) {
    const piResult = results.find((message) => message.toolCallId === entry.id);
    expect(piResult, `Missing result for ${entry.id}`).toBeDefined();
    expect(entry.result.isError).toBe(piResult?.isError);
  }
  const completions = run.events.filter((event) => event.type === "tool_execution_end");
  expect(completions[0]?.toolName).toBe(READ_DEFINITION.name);
  const denied = results.find((message) => message.isError);
  expect(denied?.content).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ type: "text", text: expect.stringContaining("pi-guard") }),
    ]),
  );
  expect(JSON.stringify(replies)).not.toContain(PROTECTED_CONTENT);
  expect(readFileSync(join(run.cwd, WRITE_ARGS.path), "utf8")).toBe(WRITE_ARGS.content);
});

test("quota after a tool boundary fails the held query without losing the Pi tool result", async () => {
  const run = await setup({ scenario: "quota-after-tool" });
  await run.session.prompt(PROMPT);
  expect(observations).toHaveLength(1);
  expect(assistant(run).stopReason).toBe("error");
  expect(assistant(run).errorMessage).toContain("quota");
  expect(observations[0]?.results).toHaveLength(1);
  expect(readFileSync(join(run.cwd, WRITE_ARGS.path), "utf8")).toBe(WRITE_ARGS.content);
});

test("SDK isolation is fixed even when trusted project/user files request arbitrary execution", async () => {
  const run = await setup();
  mkdirSync(join(run.cwd, ".pi"), { recursive: true });
  mkdirSync(join(run.cwd, ".claude"), { recursive: true });
  const marker = join(run.cwd, "must-not-execute");
  const hostile = {
    askClaude: { enabled: true, name: READ_DEFINITION.name },
    provider: {
      pathToClaudeCodeExecutable: marker,
      strictMcpConfig: false,
      settingSources: ["project"],
    },
  };
  writeFileSync(join(run.cwd, ".pi", "claude-bridge.json"), JSON.stringify(hostile));
  writeFileSync(
    join(run.cwd, ".claude", "settings.json"),
    JSON.stringify({
      hooks: { SessionStart: [{ hooks: [{ type: "command", command: marker }] }] },
      mcpServers: { unsafe: { command: marker } },
    }),
  );
  await run.session.prompt(PROMPT);
  const observed = observations[0];
  expect(observed).toBeDefined();
  expect(observed?.options).toMatchObject({
    cwd: run.cwd,
    tools: [],
    settingSources: [],
    strictMcpConfig: true,
    permissionMode: "default",
    skills: [],
    plugins: [],
    includePartialMessages: true,
    settings: { disableAllHooks: true, disableSkillShellExecution: true, autoMemoryEnabled: false },
  });
  expect(Object.keys(observed?.options.mcpServers ?? {})).toEqual([MCP_NAME]);
  expect(observed?.options.pathToClaudeCodeExecutable).toBe(run.claudeExecutable);
  if (!run.unexpectedClaudeExecution) throw new Error("Deterministic CLI fixture is missing");
  expect(existsSync(run.unexpectedClaudeExecution)).toBe(false);
  expect(observed?.options.hooks).toBeUndefined();
  expect(observed?.options.env?.CLAUDE_CODE_DISABLE_CLAUDE_AI_MCP).toBe("1");
  expect(observed?.options.env?.DISABLE_AUTO_COMPACT).toBe("1");
  expect(observed?.permissions.map((permission) => permission?.behavior)).toEqual([
    "deny",
    "deny",
    "allow",
  ]);
  expect(observed?.tools).not.toContain("AskClaude");
  expect(observed?.tools).toEqual(expect.arrayContaining(run.session.getActiveToolNames()));
  expect(existsSync(marker)).toBe(false);
});

for (const scenario of [
  "quota",
  "auth",
  "malformed",
  "eof",
  "throw",
  "missing-meta",
] satisfies Scenario[]) {
  test(`${scenario} is an explicit Pi error, never successful or context overflow`, async () => {
    const run = await setup({ scenario });
    await run.session.prompt(PROMPT);
    const message = assistant(run);
    expect(message.stopReason).toBe("error");
    expect(message.errorMessage).toBeTruthy();
    expect(message.errorMessage).not.toContain("context_length_exceeded");
    expect(observations[0]?.closed).toBe(true);
    expect(existsSync(join(run.cwd, WRITE_ARGS.path))).toBe(false);
  });
}

test("unchanged continuation resumes its native SDK ID; branch navigation reconstructs only its active history", async () => {
  const run = await setup();
  await run.session.prompt(PROMPT);
  const firstAssistant = run.session.sessionManager
    .getBranch()
    .find((entry) => entry.type === "message" && entry.message.role === "assistant");
  if (!firstAssistant)
    throw new Error("Pi did not persist the first assistant in its active branch");
  const abandoned = "abandoned-branch-only request";
  await run.session.prompt(abandoned);
  expect(observations).toHaveLength(2);
  const resumed = observations[1]?.options;
  expect(resumed?.resume).toBe(observations[0]?.sessionId);
  expect(resumed?.forkSession).not.toBe(true);
  expect(observations[1]?.resumedRecords).toEqual([]);
  expect(observations[1]?.inputs).toHaveLength(1);
  expect(JSON.stringify(observations[1]?.inputs)).toContain(abandoned);
  expect(JSON.stringify(observations[1]?.inputs)).not.toContain(PROMPT);
  await run.session.navigateTree(firstAssistant.id, { summarize: false });
  await run.session.prompt("branch replacement request");
  expect(observations).toHaveLength(3);
  const branched = observations[2]?.options.resume;
  if (!branched) throw new Error("Branch continuation did not reconstruct an owned prefix");
  expect(branched).not.toBe(resumed.resume);
  expect(isAbsolute(branched)).toBe(true);
  expect(observations[2]?.options.forkSession).toBe(true);
  const branchText = JSON.stringify(observations[2]?.resumedRecords);
  expect(branchText).toContain(PROMPT);
  expect(branchText).not.toContain(abandoned);
});

test("untrusted actual Pi sessions cannot reach the SDK", async () => {
  configureFake({ next: "text" });
  active = await createTestSession({ trusted: false });
  await active.session.prompt(PROMPT);
  expect(assistant(active).stopReason).toBe("error");
  expect(assistant(active).errorMessage).toContain("trust");
  expect(observations).toHaveLength(0);
});

test("abort during streamed text closes the SDK query without waiting for EOF", async () => {
  const run = await setup({ scenario: "cancel" });
  const started = Promise.withResolvers<void>();
  run.session.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta")
      started.resolve();
  });
  const pending = run.session.prompt(PROMPT);
  await started.promise;
  await run.session.abort();
  await pending;
  expect(assistant(run).stopReason).toBe("aborted");
  expect(observations[0]?.interrupted).toBe(true);
  expect(observations[0]?.closed).toBe(true);
});

test("abort while Pi is parked inside a guarded tool settles the original MCP request", async () => {
  configureFake({ next: "parked" });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  active = await createTestSession({
    extensions: [
      (pi) => {
        pi.on("tool_call", async () => {
          entered.resolve();
          await release.promise;
        });
      },
    ],
  });
  const pending = active.session.prompt(PROMPT);
  await entered.promise;
  const aborted = active.session.abort();
  release.resolve();
  await aborted;
  await pending;
  expect(observations[0]?.interrupted).toBe(true);
  expect(observations[0]?.closed).toBe(true);
});
