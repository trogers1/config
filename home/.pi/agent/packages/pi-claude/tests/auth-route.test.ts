import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { AccountInfo, ApiKeySource } from "@anthropic-ai/claude-agent-sdk";
import type { Static } from "typebox";
import { join, resolve } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { SDK_RUNTIME_METADATA } from "../extensions/cli.ts";
import { SDK_SETTINGS_ISOLATION } from "../extensions/sdk-options.ts";
import { PROMPT, RESPONSE_TEXT, SDK_USAGE, WRITE_ARGS } from "./contract.ts";
import { parseJson, parseOrThrow } from "../extensions/validation.ts";
import { verifySdkAccountRoute, type CliAuthStatusSchema } from "../extensions/auth-route.ts";
import {
  CLI_AUTH_RESPONSE,
  CLI_AUTH_STATUS,
  CliAuthResponseSchema,
  CliAuthRequestSchema,
} from "./fixtures/claude-cli.ts";
import {
  configureFake,
  observations,
  SDK_ACCOUNT_METADATA,
  type Scenario,
} from "./fixtures/fake-sdk.ts";
import { createTestSession, lastAssistant } from "./fixtures/session.ts";

vi.mock("@anthropic-ai/claude-agent-sdk", async () => ({
  query: (await import("./fixtures/fake-sdk.ts")).fakeQuery,
}));

let active: Awaited<ReturnType<typeof createTestSession>> | undefined;
afterEach(() => {
  active?.dispose();
  active = undefined;
});

function authStatusRequests({ run }: { run: Awaited<ReturnType<typeof createTestSession>> }) {
  if (!run.cliAuthRequests) throw new Error("Missing auth-status metadata log");
  return readFileSync(run.cliAuthRequests, "utf8")
    .trim()
    .split("\n")
    .map((text) =>
      parseJson({ text, schema: CliAuthRequestSchema, source: "fake CLI auth-status request" }),
    );
}

// Inputs exercise representative members of each reviewed runtime route family,
// not invented tokens or credentials. No authenticated CLI is ever invoked.
for (const name of [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
  "CLAUDE_CODE_USE_MANTLE",
  "CLAUDE_CODE_USE_GATEWAY",
  "ANTHROPIC_BEDROCK_MANTLE_BASE_URL",
  "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
]) {
  for (const scope of ["ambient", "request"]) {
    test(`${scope} ${name} rejects a real Pi prompt before query/input/tool activity`, async () => {
      configureFake({ next: "pipeline" });
      active = await createTestSession();
      const value = "dummy-route-value-not-for-errors";
      if (scope === "ambient") process.env[name] = value;
      else {
        const stream = active.session.agent.streamFunction;
        active.session.agent.streamFunction = (model, context, options) =>
          stream(model, context, { ...options, env: { [name]: value } });
      }
      await active.session.prompt(PROMPT);
      const assistant = lastAssistant(active);
      expect(assistant.stopReason).toBe("error");
      expect(assistant.errorMessage).toContain(name);
      expect(assistant.errorMessage).not.toContain(value);
      expect(observations).toEqual([]);
      expect(active.events.some((event) => event.type === "tool_execution_start")).toBe(false);
      expect(existsSync(join(active.cwd, WRITE_ARGS.path))).toBe(false);
    });
  }
}

test("request cannot conceal an ambient route with an empty override", async () => {
  configureFake({ next: "text" });
  active = await createTestSession();
  process.env.ANTHROPIC_API_KEY = "dummy-ambient-key";
  const stream = active.session.agent.streamFunction;
  active.session.agent.streamFunction = (model, context, options) =>
    stream(model, context, { ...options, env: { ANTHROPIC_API_KEY: "" } });
  await active.session.prompt(PROMPT);
  expect(lastAssistant(active).errorMessage).toContain("ANTHROPIC_API_KEY");
  expect(observations).toEqual([]);
});

test("ordinary environment survives, and SDK metadata mutation does not invalidate native reuse", async () => {
  configureFake({ next: "text" });
  active = await createTestSession();
  process.env.BRIDGE_ORDINARY_FIXTURE = "ambient-value";
  const stream = active.session.agent.streamFunction;
  active.session.agent.streamFunction = (model, context, options) =>
    stream(model, context, { ...options, env: { BRIDGE_REQUEST_FIXTURE: "request-value" } });
  expect(process.env.CLAUDE_AGENT_SDK_VERSION).toBeUndefined();
  await active.session.prompt(PROMPT);
  expect(lastAssistant(active).stopReason, lastAssistant(active).errorMessage).toBe("stop");
  expect(process.env.CLAUDE_AGENT_SDK_VERSION).toBe(SDK_RUNTIME_METADATA.version);
  await active.session.prompt("ordinary native follow-up");
  expect(lastAssistant(active).stopReason, lastAssistant(active).errorMessage).toBe("stop");
  expect(observations).toHaveLength(2);
  expect(observations[1]?.options.resume).toBe(observations[0]?.sessionId);
  expect(observations[1]?.resumedRecords).toEqual([]);
  const statuses = authStatusRequests({ run: active });
  expect(statuses).toHaveLength(2);
  for (const status of statuses) {
    expect(status.cwd).toBe(active.cwd);
    expect(status.configDir).toBe(observations[0]?.options.env?.CLAUDE_CONFIG_DIR);
    expect(status.ordinaryFixture).toBe("ambient-value");
    expect(status.requestFixture).toBe("request-value");
  }
  for (const observed of observations) {
    expect(observed.accountChecked).toBe(true);
    expect(observed.options.env?.BRIDGE_ORDINARY_FIXTURE).toBe("ambient-value");
    expect(observed.options.env?.BRIDGE_REQUEST_FIXTURE).toBe("request-value");
    expect(observed.options.env?.CLAUDE_AGENT_SDK_VERSION).toBe(SDK_RUNTIME_METADATA.version);
  }
});

test("omitted ambient CLAUDE_CONFIG_DIR remains omitted through status, native continuation and reconstruction", async () => {
  configureFake({ next: "text" });
  active = await createTestSession();
  // HOME is still the disposable fixture HOME. Removing this one variable must
  // not cause the bridge to export its derived default reconstruction location.
  delete process.env.CLAUDE_CONFIG_DIR;
  await active.session.prompt(PROMPT);
  expect(lastAssistant(active).stopReason, lastAssistant(active).errorMessage).toBe("stop");
  await active.session.prompt("continue with normal omitted config-directory environment");
  expect(lastAssistant(active).stopReason, lastAssistant(active).errorMessage).toBe("stop");
  expect(observations[1]?.options.resume).toBe(observations[0]?.sessionId);
  process.env.BRIDGE_RECONSTRUCTION_FIXTURE = "force-default-storage-reconstruction";
  await active.session.prompt("reconstruct using default storage without changing auth context");
  expect(lastAssistant(active).stopReason, lastAssistant(active).errorMessage).toBe("stop");
  expect(observations).toHaveLength(3);
  expect(observations[2]?.resumedRecords.length).toBeGreaterThan(0);
  for (const observed of observations)
    expect(Object.hasOwn(observed.options.env ?? {}, "CLAUDE_CONFIG_DIR")).toBe(false);
  const statuses = authStatusRequests({ run: active });
  expect(statuses).toHaveLength(3);
  for (const status of statuses) expect(Object.hasOwn(status, "configDir")).toBe(false);
});

test("explicit user-owned config-directory path is normalized identically for status and SDK", async () => {
  configureFake({ next: "text" });
  active = await createTestSession();
  process.env.CLAUDE_CONFIG_DIR = join("..", "explicit-user-config-fixture");
  const expected = resolve(active.cwd, process.env.CLAUDE_CONFIG_DIR);
  await active.session.prompt(PROMPT);
  expect(lastAssistant(active).stopReason, lastAssistant(active).errorMessage).toBe("stop");
  expect(observations[0]?.options.env?.CLAUDE_CONFIG_DIR).toBe(expected);
  expect(authStatusRequests({ run: active })[0]?.configDir).toBe(expected);
});

for (const ambient of ["unset", "explicit"]) {
  test(`request config-directory override cannot replace ${ambient} user-owned auth context`, async () => {
    configureFake({ next: "text" });
    active = await createTestSession();
    if (ambient === "unset") delete process.env.CLAUDE_CONFIG_DIR;
    const requestPath = join(active.temp, "request-auth-context-must-not-be-logged");
    const stream = active.session.agent.streamFunction;
    active.session.agent.streamFunction = (model, context, options) =>
      stream(model, context, { ...options, env: { CLAUDE_CONFIG_DIR: requestPath } });
    await active.session.prompt(PROMPT);
    const assistant = lastAssistant(active);
    expect(assistant.stopReason).toBe("error");
    expect(assistant.errorMessage).toContain("CLAUDE_CONFIG_DIR");
    expect(assistant.errorMessage).not.toContain(requestPath);
    expect(observations).toEqual([]);
    if (!active.cliAuthRequests) throw new Error("Missing fake CLI auth-status log path");
    expect(existsSync(active.cliAuthRequests)).toBe(false);
  });
}

test("status and SDK receive shared invocation-only synced skill/plugin isolation", async () => {
  configureFake({ next: "text" });
  active = await createTestSession();
  await active.session.prompt(PROMPT);
  expect(lastAssistant(active).stopReason, lastAssistant(active).errorMessage).toBe("stop");
  expect(SDK_SETTINGS_ISOLATION.syncClaudeAiSkills).toBe(false);
  expect(SDK_SETTINGS_ISOLATION.syncClaudeAiPlugins).toBe(false);
  expect(observations[0]?.options.settings).toEqual(SDK_SETTINGS_ISOLATION);
  expect(observations[0]?.options.settingSources).toEqual([]);
  const statuses = authStatusRequests({ run: active });
  expect(statuses).toHaveLength(1);
  expect(statuses[0]?.settings).toEqual(SDK_SETTINGS_ISOLATION);
});

for (const scenario of ["unexpected-skills", "unexpected-plugins"] satisfies Scenario[]) {
  test(`${scenario} still rejects initialization despite requested isolation`, async () => {
    configureFake({ next: scenario });
    active = await createTestSession();
    await active.session.prompt(PROMPT);
    expect(lastAssistant(active).stopReason).toBe("error");
    expect(lastAssistant(active).errorMessage).toContain(
      "unexpected native tool, plugin, skill or MCP surface",
    );
    await vi.waitFor(() => expect(observations[0]?.closed).toBe(true));
    expect(observations[0]?.results).toEqual([]);
    expect(active.events.some((event) => event.type === "tool_execution_start")).toBe(false);
    expect(existsSync(join(active.cwd, WRITE_ARGS.path))).toBe(false);
  });
}

test("owned pending tool progress and thinking estimates are informational only", async () => {
  configureFake({ next: "progress" });
  active = await createTestSession();
  await active.session.prompt(PROMPT);
  const assistant = lastAssistant(active);
  expect(assistant.stopReason, assistant.errorMessage).toBe("stop");
  expect(active.session.getLastAssistantText()).toBe(RESPONSE_TEXT);
  expect(readFileSync(join(active.cwd, WRITE_ARGS.path), "utf8")).toBe(WRITE_ARGS.content);
  expect(observations).toHaveLength(1);
  expect(observations[0]?.results).toHaveLength(1);
  if (!active.cliAuthRequests) throw new Error("Missing auth-status metadata log");
  expect(readFileSync(active.cliAuthRequests, "utf8").trim().split("\n")).toHaveLength(1);
  expect(assistant.usage.output).toBe(SDK_USAGE.output_tokens);
  expect(JSON.stringify(assistant.content)).not.toContain("123456");
});

test("owned tool progress survives observer delay through real Pi tool completion and MCP delivery", async () => {
  configureFake({ next: "progress" });
  const observed = Promise.withResolvers<void>();
  const releaseObserver = Promise.withResolvers<void>();
  active = await createTestSession({
    extensions: [
      (pi) => {
        pi.on("provider_stream_event", async (event) => {
          if (
            typeof event.data === "object" &&
            event.data !== null &&
            "type" in event.data &&
            event.data.type === "tool_progress"
          ) {
            observed.resolve();
            await releaseObserver.promise;
          }
        });
      },
    ],
  });
  const run = active;
  const pending = run.session.prompt(PROMPT);
  try {
    await Promise.race([
      observed.promise,
      pending.then(() => {
        throw new Error(
          `Prompt ended before owned progress observation: ${lastAssistant(run).errorMessage}`,
        );
      }),
    ]);
    // The SDK consumer is held in Pi's public observer. Independently, the real
    // guarded tool and provider continuation must deliver its result over MCP.
    await vi.waitFor(() => expect(observations[0]?.deliveredToolIds).toHaveLength(1));
    expect(readFileSync(join(run.cwd, WRITE_ARGS.path), "utf8")).toBe(WRITE_ARGS.content);
    expect(observations[0]?.closed).toBe(false);
  } finally {
    releaseObserver.resolve();
    await pending;
  }
  const assistant = lastAssistant(run);
  expect(assistant.stopReason, assistant.errorMessage).toBe("stop");
  expect(run.session.getLastAssistantText()).toBe(RESPONSE_TEXT);
  expect(assistant.usage).toMatchObject({
    input: SDK_USAGE.input_tokens,
    output: SDK_USAGE.output_tokens,
    cacheRead: SDK_USAGE.cache_read_input_tokens,
    cacheWrite: SDK_USAGE.cache_creation_input_tokens,
    totalTokens: Object.values(SDK_USAGE).reduce((sum, count) => sum + count, 0),
  });
  expect(JSON.stringify(assistant.content)).not.toContain("123456");
  expect(observations).toHaveLength(1);
  expect(observations[0]?.inputs).toHaveLength(1);
});

function setAuthResponse({ response }: { response: Static<typeof CliAuthResponseSchema> }) {
  if (!active?.cliAuthResponse) throw new Error("Missing fake CLI auth-status response path");
  writeFileSync(
    active.cliAuthResponse,
    JSON.stringify(
      parseOrThrow({
        schema: CliAuthResponseSchema,
        value: response,
        source: "auth-status fixture",
      }),
    ),
  );
}

for (const failure of [
  {
    response: { ...CLI_AUTH_RESPONSE, exitCode: 69 },
    diagnostic: "exit=69",
  },
  {
    response: { ...CLI_AUTH_RESPONSE, signal: "SIGTERM" },
    diagnostic: "signal=SIGTERM",
  },
  {
    response: { ...CLI_AUTH_RESPONSE, stdout: "dummy-private-child-output".repeat(1000) },
    diagnostic: "code=ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
  },
] satisfies { response: Static<typeof CliAuthResponseSchema>; diagnostic: string }[]) {
  test(`auth-status failure exposes only validated child status (${failure.diagnostic})`, async () => {
    configureFake({ next: "text" });
    active = await createTestSession();
    setAuthResponse({
      response: {
        ...failure.response,
        stdout: failure.response.stdout + "dummy-private-child-output",
        stderr: "dummy-private-child-stderr-or-account",
      },
    });
    await active.session.prompt(PROMPT);
    const assistant = lastAssistant(active);
    expect(assistant.stopReason).toBe("error");
    expect(assistant.errorMessage).toContain(failure.diagnostic);
    expect(assistant.errorMessage).not.toContain("dummy-private-child");
    expect(assistant.errorMessage).not.toContain(CLI_AUTH_STATUS.authMethod);
    expect(assistant.errorMessage).not.toContain("--settings");
    expect(observations).toEqual([]);
  });
}

for (const authMethod of [
  "none",
  "oauth_token",
  "api_key",
  "api_key_helper",
  "third_party",
] satisfies Static<typeof CliAuthStatusSchema>["authMethod"][]) {
  test(`saved CLI ${authMethod} route is rejected before SDK/history/input/tool dispatch`, async () => {
    configureFake({ next: "pipeline" });
    active = await createTestSession();
    setAuthResponse({
      response: {
        ...CLI_AUTH_RESPONSE,
        stdout: JSON.stringify({ ...CLI_AUTH_STATUS, authMethod }),
      },
    });
    await active.session.prompt(PROMPT);
    expect(lastAssistant(active).stopReason).toBe("error");
    expect(lastAssistant(active).errorMessage).toContain("claude.ai login is required");
    expect(observations).toEqual([]);
    expect(existsSync(join(active.cwd, WRITE_ARGS.path))).toBe(false);
  });
}

for (const response of [
  { ...CLI_AUTH_RESPONSE, stdout: "dummy-private-account-malformed-json" },
  { ...CLI_AUTH_RESPONSE, stdout: JSON.stringify({ loggedIn: true }) },
  {
    ...CLI_AUTH_RESPONSE,
    stdout: JSON.stringify({ ...CLI_AUTH_STATUS, authMethod: "unknown-method" }),
  },
  { ...CLI_AUTH_RESPONSE, stdout: JSON.stringify({ ...CLI_AUTH_STATUS, loggedIn: false }) },
  { ...CLI_AUTH_RESPONSE, stdout: JSON.stringify({ ...CLI_AUTH_STATUS, apiProvider: "gateway" }) },
  { ...CLI_AUTH_RESPONSE, stderr: "dummy-private-account-diagnostic" },
  { ...CLI_AUTH_RESPONSE, exitCode: 1 },
  { ...CLI_AUTH_RESPONSE, stdout: "dummy-private-account-output".repeat(1000) },
  { ...CLI_AUTH_RESPONSE, delayMs: 30_000 },
] satisfies Static<typeof CliAuthResponseSchema>[]) {
  test(`auth-status command/schema failure fails closed (${JSON.stringify(response).length} bytes; delay ${response.delayMs})`, async () => {
    configureFake({ next: "pipeline" });
    active = await createTestSession();
    setAuthResponse({ response });
    await active.session.prompt(PROMPT);
    const assistant = lastAssistant(active);
    expect(assistant.stopReason).toBe("error");
    expect(assistant.errorMessage).not.toContain("dummy-private-account");
    expect(observations).toEqual([]);
    expect(existsSync(join(active.cwd, WRITE_ARGS.path))).toBe(false);
  });
}

for (const account of [
  SDK_ACCOUNT_METADATA,
  { ...SDK_ACCOUNT_METADATA, apiKeySource: "none" },
] satisfies AccountInfo[]) {
  test(`positive CLI login plus firstParty SDK metadata permits guarded tools (${JSON.stringify(account)})`, async () => {
    configureFake({ next: "pipeline", account });
    active = await createTestSession();
    await active.session.prompt(PROMPT);
    expect(lastAssistant(active).stopReason, lastAssistant(active).errorMessage).toBe("stop");
    expect(active.session.getLastAssistantText()).toBe(RESPONSE_TEXT);
    expect(observations).toHaveLength(1);
    expect(observations[0]?.accountChecked).toBe(true);
    expect(observations[0]?.inputs).toHaveLength(1);
    expect(observations[0]?.results).toHaveLength(2);
    expect(observations[0]?.closed).toBe(true);
  });
}

// Malformed null cannot be represented by the SDK's AccountInfo type. Exercise
// this schema edge at the validation boundary, without lying to the typed fake.
test("explicit null SDK API-key source is invalid, not an absent optional source", () => {
  expect(() =>
    verifySdkAccountRoute({
      account: { ...SDK_ACCOUNT_METADATA, apiKeySource: null },
    }),
  ).toThrow("Claude SDK account route");
});

for (const apiKeySource of [
  "ANTHROPIC_API_KEY",
  "/login managed key",
  "apiKeyHelper",
] satisfies ApiKeySource[]) {
  test(`SDK ${apiKeySource} metadata contradicting CLI login never releases async input`, async () => {
    configureFake({ next: "pipeline", account: { ...SDK_ACCOUNT_METADATA, apiKeySource } });
    active = await createTestSession();
    await active.session.prompt(PROMPT);
    expect(lastAssistant(active).stopReason).toBe("error");
    await vi.waitFor(() => expect(observations[0]?.closed).toBe(true));
    expect(observations[0]?.accountChecked).toBe(true);
    expect(observations[0]?.inputs).toEqual([]);
    expect(observations[0]?.tools).toEqual([]);
    expect(observations[0]?.permissions).toEqual([]);
    expect(existsSync(join(active.cwd, WRITE_ARGS.path))).toBe(false);
  });
}

for (const account of [
  {},
  { apiKeySource: "none" },
  { ...SDK_ACCOUNT_METADATA, apiKeySource: "unknown-source" },
  ...(
    [
      "bedrock",
      "vertex",
      "foundry",
      "anthropicAws",
      "anthropicGoogleCloud",
      "mantle",
      "gateway",
    ] satisfies NonNullable<AccountInfo["apiProvider"]>[]
  ).map((apiProvider) => ({
    ...SDK_ACCOUNT_METADATA,
    apiProvider,
  })),
] satisfies AccountInfo[]) {
  test(`ambiguous or third-party SDK account fails before input (${JSON.stringify(account)})`, async () => {
    configureFake({ next: "pipeline", account });
    active = await createTestSession();
    await active.session.prompt(PROMPT);
    expect(lastAssistant(active).stopReason).toBe("error");
    await vi.waitFor(() => expect(observations[0]?.closed).toBe(true));
    expect(observations[0]?.inputs).toEqual([]);
    expect(observations[0]?.permissions).toEqual([]);
  });
}

test("SDK metadata failure closes the unstarted query and allows same-session recovery", async () => {
  configureFake({ next: "pipeline", failAccount: "reject" });
  active = await createTestSession();
  await active.session.prompt(PROMPT);
  expect(lastAssistant(active).stopReason).toBe("error");
  expect(lastAssistant(active).errorMessage).not.toContain("dummy-account-initialization-secret");
  await vi.waitFor(() => expect(observations[0]?.closed).toBe(true));
  expect(observations[0]?.inputs).toEqual([]);
  configureFake({ next: "text", reset: false });
  await active.session.prompt("recover after rejected initialization");
  expect(lastAssistant(active).stopReason, lastAssistant(active).errorMessage).toBe("stop");
  expect(observations[1]?.accountChecked).toBe(true);
  expect(observations[1]?.inputs).toHaveLength(1);
});

test("abort while CLI auth-status is pending starts no SDK query", async () => {
  configureFake({ next: "pipeline" });
  active = await createTestSession();
  setAuthResponse({ response: { ...CLI_AUTH_RESPONSE, delayMs: 30_000 } });
  const pending = active.session.prompt(PROMPT);
  await vi.waitFor(() => {
    if (!active?.cliAuthRequests) throw new Error("Missing fake CLI auth-status log");
    expect(existsSync(active.cliAuthRequests)).toBe(true);
  });
  await active.session.abort();
  await pending;
  expect(observations).toEqual([]);
});

test("abort while SDK account initialization is pending closes without releasing input", async () => {
  configureFake({ next: "pipeline", failAccount: "pending" });
  active = await createTestSession();
  const pending = active.session.prompt(PROMPT);
  await vi.waitFor(() => expect(observations[0]?.accountChecked).toBe(true));
  await active.session.abort();
  await pending;
  await vi.waitFor(() => expect(observations[0]?.closed).toBe(true));
  expect(observations[0]?.inputs).toEqual([]);
  expect(observations[0]?.permissions).toEqual([]);
});

test("SDK account initialization timeout closes without releasing prompt or tools", async () => {
  configureFake({ next: "pipeline", failAccount: "pending" });
  active = await createTestSession();
  await active.session.prompt(PROMPT);
  expect(lastAssistant(active).stopReason).toBe("error");
  expect(lastAssistant(active).errorMessage).toContain("timed out");
  await vi.waitFor(() => expect(observations[0]?.closed).toBe(true));
  expect(observations[0]?.inputs).toEqual([]);
  expect(observations[0]?.permissions).toEqual([]);
});

test("reconstructed historical messages do not trigger model/tools before account validation", async () => {
  configureFake({ next: "text" });
  active = await createTestSession();
  await active.session.prompt(PROMPT);
  expect(lastAssistant(active).stopReason, lastAssistant(active).errorMessage).toBe("stop");
  process.env.BRIDGE_RECONSTRUCTION_FIXTURE = "force-fresh-query-identity";
  configureFake({
    next: "pipeline",
    reset: false,
    account: { ...SDK_ACCOUNT_METADATA, apiKeySource: "apiKeyHelper" },
  });
  await active.session.prompt("must not release restored historical messages");
  expect(lastAssistant(active).stopReason).toBe("error");
  await vi.waitFor(() => expect(observations[1]?.closed).toBe(true));
  expect(observations[1]?.resumedRecords.length).toBeGreaterThan(0);
  expect(observations[1]?.inputs).toEqual([]);
  expect(observations[1]?.permissions).toEqual([]);
  expect(observations[1]?.tools).toEqual([]);
});

for (const scenario of [
  "foreign-progress",
  "subagent-progress",
  "wrong-session-progress",
  "wrong-name-progress",
  "native-task-progress",
  "native-subagent-progress",
  "stale-progress",
] satisfies Scenario[]) {
  test(`${scenario} cannot use informational progress to cross ownership boundaries`, async () => {
    configureFake({ next: scenario });
    active = await createTestSession();
    await active.session.prompt(PROMPT);
    // The guarded call may already be in flight; progress must terminate the
    // query instead of laundering foreign native/subagent/session activity.
    await vi.waitFor(() => expect(observations[0]?.closed).toBe(true));
    expect(active.session.getLastAssistantText()).not.toBe(RESPONSE_TEXT);
  });
}
