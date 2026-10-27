import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { Type } from "typebox";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { CLAUDE_BRIDGE_PROVIDER } from "../../pi-guard-subagents/extensions/interactive/provider-extensions.ts";
import { DeliverySchema, PayloadSchema } from "../extensions/transcript.ts";
import { parseJson, parseOrThrow } from "../extensions/validation.ts";
import {
  IN_FLIGHT_TEXT,
  PROMPT,
  RESPONSE_TEXT,
  SERIALIZED_WRITE_ARGS,
  SDK_USAGE,
  THINKING_SIGNATURE,
  THINKING_TEXT,
  WRITE_ARGS,
} from "./contract.ts";
import {
  configureFake,
  observations,
  PAYLOAD_SECRETS,
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
async function setup({
  scenario = "text",
  ...options
}: { scenario?: Scenario } & Parameters<typeof createTestSession>[0] = {}) {
  configureFake({ next: scenario });
  active = await createTestSession(options);
  return active;
}
function successful({ run }: { run: Awaited<ReturnType<typeof createTestSession>> }) {
  expect(lastAssistant(run).stopReason, lastAssistant(run).errorMessage).toBe("stop");
  expect(run.session.getLastAssistantText()).toBe(RESPONSE_TEXT);
}

for (const scenario of [
  "completed-empty-restart",
  "completed-thinking-restart",
  "completed-text-restart",
] satisfies Scenario[]) {
  test(`${scenario} preserves complete SDK responses and usage through one public Pi turn`, async () => {
    const run = await setup({ scenario });
    await run.session.prompt(PROMPT);
    const message = lastAssistant(run);
    expect(message.stopReason, message.errorMessage).toBe("stop");
    const texts = message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text);
    expect(texts.at(-1)).toBe(RESPONSE_TEXT);
    if (scenario === "completed-text-restart")
      expect(texts).toEqual([IN_FLIGHT_TEXT, RESPONSE_TEXT]);
    if (scenario === "completed-thinking-restart")
      expect(message.content).toContainEqual({
        type: "thinking",
        thinking: THINKING_TEXT,
        thinkingSignature: THINKING_SIGNATURE,
      });
    expect(message.usage).toMatchObject({
      input: SDK_USAGE.input_tokens * 2,
      output: SDK_USAGE.output_tokens * 2,
      cacheRead: SDK_USAGE.cache_read_input_tokens * 2,
      cacheWrite: SDK_USAGE.cache_creation_input_tokens * 2,
    });
    configureFake({ next: "text", reset: false });
    await run.session.prompt("continue after completed SDK response sequence");
    successful({ run });
    expect(observations[1]?.options.resume).toBe(observations[0]?.sessionId);
  });
}

test("an SDK response restart before message_stop still fails closed", async () => {
  const run = await setup({ scenario: "unfinished-restart" });
  await run.session.prompt(PROMPT);
  expect(lastAssistant(run).stopReason).toBe("error");
  expect(lastAssistant(run).errorMessage).toBe(
    "pi-claude: SDK restarted an unfinished assistant response",
  );
  expect(observations[0]?.closed).toBe(true);
});

// SDK dispatch can be serial even though the model produced one multi-tool message.
test("a serialized MCP client receives sibling A's Pi result before it dispatches sibling B", async () => {
  const run = await setup({ scenario: "serialized" });
  await run.session.prompt(PROMPT);
  successful({ run });
  expect(observations).toHaveLength(1);
  expect(observations[0]?.results).toHaveLength(2);
  expect(observations[0]?.results.every((entry) => !entry.result.isError)).toBe(true);
  expect(readFileSync(join(run.cwd, WRITE_ARGS.path), "utf8")).toBe(WRITE_ARGS.content);
  expect(readFileSync(join(run.cwd, SERIALIZED_WRITE_ARGS.path), "utf8")).toBe(WRITE_ARGS.content);
});

for (const failure of ["eof", "throw", "auth"] satisfies Scenario[]) {
  test(`${failure} does not poison the next prompt in the same public Pi session`, async () => {
    const run = await setup({ scenario: failure });
    await run.session.prompt(PROMPT);
    expect(lastAssistant(run).stopReason).toBe("error");
    expect(observations[0]?.closed).toBe(true);
    configureFake({ next: "text", reset: false });
    await run.session.prompt("recover after the failed attempt");
    successful({ run });
    expect(observations).toHaveLength(2);
    const recovered = JSON.stringify(observations[1]?.resumedRecords);
    expect(recovered).toContain(PROMPT);
    if (failure === "eof") expect(recovered).toContain(RESPONSE_TEXT);
    expect(
      run.session.messages.some(
        (message) => message.role === "assistant" && message.stopReason === "error",
      ),
    ).toBe(true);
  });
}

for (const duringTools of [false, true]) {
  test(`abort ${duringTools ? "inside guarded tools" : "during output"} permits the next successful same-session prompt`, async () => {
    const entered = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    let blockOnce = duringTools;
    const run = await setup({
      scenario: duringTools ? "parked" : "cancel",
      extensions: [
        (pi) => {
          pi.on("tool_call", async () => {
            if (blockOnce) {
              blockOnce = false;
              entered.resolve();
              await released.promise;
            }
          });
        },
      ],
    });
    if (!duringTools)
      run.session.subscribe((event) => {
        if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta")
          entered.resolve();
      });
    const pending = run.session.prompt(PROMPT);
    await Promise.race([
      entered.promise,
      pending.then(() => {
        throw new Error(
          `Run ended before cancellation boundary: ${lastAssistant(run).errorMessage}`,
        );
      }),
    ]);
    const aborted = run.session.abort();
    try {
      // A parked MCP query must close even while the real Pi tool hook is
      // still pending; waiting until the tool is released would miss a leak.
      await vi.waitFor(() => expect(observations[0]?.closed).toBe(true), { timeout: 2_000 });
    } finally {
      released.resolve();
    }
    await aborted;
    await pending;
    expect(observations[0]?.closed).toBe(true);
    const completedResults = run.session.messages.filter(
      (message) => message.role === "toolResult",
    );
    configureFake({ next: "text", reset: false });
    await run.session.prompt("continue after cancellation");
    successful({ run });
    expect(observations).toHaveLength(2);
    const recovered = JSON.stringify(observations[1]?.resumedRecords);
    expect(recovered).toContain(PROMPT);
    if (duringTools) {
      expect(completedResults.length).toBeGreaterThan(0);
      for (const completed of completedResults) expect(recovered).toContain(completed.toolCallId);
    } else expect(recovered).toContain(IN_FLIGHT_TEXT);
  });
}

for (const retry of [false, true]) {
  test(`public split-turn compaction performs both summaries${retry ? " and retries a transient failure" : ""} within one operation`, async () => {
    let operations = 0;
    const run = await setup({
      settings: {
        compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 256 },
        retry: { enabled: retry, maxRetries: 1, baseDelayMs: 1 },
      },
      extensions: [
        (pi) => {
          pi.on("session_before_compact", () => {
            operations++;
          });
        },
      ],
    });
    await run.session.prompt("first completed turn to summarize");
    await run.session.prompt("second turn whose prefix must be summarized separately");
    successful({ run });
    const before = observations.length;
    configureFake({ next: retry ? "transient" : "text", reset: false, then: ["text", "text"] });
    const compacted = await run.session.compact();
    expect(operations).toBe(1);
    expect(observations.length - before).toBe(retry ? 3 : 2);
    expect(compacted.summary).toContain(RESPONSE_TEXT);
    expect(compacted.summary).toContain("Turn Context (split turn)");
    expect(
      run.session.sessionManager.getBranch().some((entry) => entry.type === "compaction"),
    ).toBe(true);
    expect(observations.slice(before).every((entry) => entry.closed)).toBe(true);
    configureFake({ next: "text", reset: false });
    await run.session.prompt("continue normally after compaction");
    successful({ run });
  });
}

for (const mode of ["mutate", "replace"] satisfies ("mutate" | "replace")[]) {
  test(`${mode} payload redaction survives ordinary native continuation and forced branch reconstruction`, async () => {
    const OutboundSchema = Type.Union([PayloadSchema, DeliverySchema]);
    let redactedInputs = 0;
    let redactedResults = 0;
    const run = await setup({
      scenario: "secret-tool",
      extensions: [
        (pi) => {
          pi.on("before_provider_request", (event) => {
            const payload = parseOrThrow({
              value: event.payload,
              schema: OutboundSchema,
              source: "public outbound payload fixture",
            });
            const replaced = parseJson({
              text: JSON.stringify(payload),
              schema: OutboundSchema,
              source: "outbound replacement fixture",
            });
            // Intentionally transform only CURRENT content/results. Prior redactions
            // must be preserved by the provider's effective-wire ledger, including
            // when a later branch requires a complete reconstructed prefix.
            if ("kind" in replaced) {
              const serialized = JSON.stringify(replaced.results);
              if (serialized.includes(PAYLOAD_SECRETS.tool)) redactedResults++;
              const delivery = parseJson({
                text: JSON.stringify({
                  ...replaced,
                  results: parseJson({
                    text: serialized.replaceAll(PAYLOAD_SECRETS.tool, PAYLOAD_SECRETS.redacted),
                    schema: DeliverySchema.properties.results,
                    source: "redacted result content",
                  }),
                }),
                schema: DeliverySchema,
                source: "redacted tool result fixture",
              });
              if (mode === "mutate") {
                Object.assign(payload, delivery);
                return;
              }
              return delivery;
            }
            const serialized = JSON.stringify(replaced.content);
            if (serialized.includes(PAYLOAD_SECRETS.user)) redactedInputs++;
            const initial = parseJson({
              text: JSON.stringify({
                ...replaced,
                content: parseJson({
                  text: serialized.replaceAll(PAYLOAD_SECRETS.user, PAYLOAD_SECRETS.redacted),
                  schema: PayloadSchema.properties.content,
                  source: "redacted user content",
                }),
              }),
              schema: PayloadSchema,
              source: "redacted user fixture",
            });
            if (mode === "mutate") {
              Object.assign(payload, initial);
              return;
            }
            return initial;
          });
        },
      ],
    });
    writeFileSync(join(run.cwd, WRITE_ARGS.path), PAYLOAD_SECRETS.tool);
    await run.session.prompt(`${PROMPT} ${PAYLOAD_SECRETS.user}`);
    successful({ run });
    expect(redactedInputs).toBeGreaterThan(0);
    expect(redactedResults).toBeGreaterThan(0);
    expect(JSON.stringify(run.session.messages)).toContain(PAYLOAD_SECRETS.user);
    expect(JSON.stringify(run.session.messages)).toContain(PAYLOAD_SECRETS.tool);
    const anchor = run.session.sessionManager
      .getBranch()
      .findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
    if (!anchor) throw new Error("Missing finalized Pi branch anchor");
    configureFake({ next: "text", reset: false });
    await run.session.prompt("ordinary continuation without re-redacting historical values");
    successful({ run });
    const ordinary = observations.at(-1);
    expect(ordinary?.options.resume).toBe(observations[0]?.sessionId);
    expect(ordinary?.resumedRecords).toEqual([]);
    await run.session.navigateTree(anchor.id, { summarize: false });
    await run.session.prompt("alternate branch requiring a fresh reconstructed prefix");
    successful({ run });
    const branch = observations.at(-1);
    expect(isAbsolute(branch?.options.resume ?? "")).toBe(true);
    expect(branch?.resumedRecords.length).toBeGreaterThan(0);
    for (const observed of observations) {
      const outbound = JSON.stringify({
        inputs: observed.inputs,
        records: observed.resumedRecords,
        replies: observed.results,
      });
      expect(outbound).not.toContain(PAYLOAD_SECRETS.user);
      expect(outbound).not.toContain(PAYLOAD_SECRETS.tool);
    }
    expect(JSON.stringify(branch?.resumedRecords)).toContain(PAYLOAD_SECRETS.redacted);
  });
}

for (const ownership of ["structured", "payload"]) {
  test(`${ownership} prompt changes invalidate native checkpoints and reconstruct history`, async () => {
    let instruction = "First prompt policy.";
    const run = await setup({
      extensions: [
        (pi) => {
          if (ownership === "structured")
            pi.on("before_agent_start", (event) => {
              event.systemPromptOptions.sections.custom_policy = instruction;
            });
          else
            pi.on("before_provider_request", (event) => {
              const payload = parseOrThrow({
                schema: PayloadSchema,
                value: event.payload,
                source: "changing prompt policy fixture",
              });
              return { ...payload, systemPrompt: instruction };
            });
        },
      ],
    });
    await run.session.prompt(PROMPT);
    successful({ run });
    configureFake({ next: "text", reset: false });
    await run.session.prompt("unchanged prompt policy");
    successful({ run });
    expect(observations[1]?.options.resume).toBe(observations[0]?.sessionId);
    instruction = "Changed prompt policy.";
    await run.session.prompt("use the changed policy");
    successful({ run });
    const changed = observations.at(-1);
    expect(isAbsolute(changed?.options.resume ?? "")).toBe(true);
    expect(changed?.options.forkSession).toBe(true);
    expect(changed?.resumedRecords.length).toBeGreaterThan(0);
    expect(JSON.stringify(changed?.options.systemPrompt)).toContain(instruction);
  });
}

for (const family of ["haiku", "adaptive"]) {
  test(`${family} reasoning follows its real catalog capability rather than universally enabling adaptive thinking`, async () => {
    const run = await setup();
    const advertised = run.modelRuntime.getModels(CLAUDE_BRIDGE_PROVIDER);
    const source = getBuiltinModels("anthropic").find(
      (model) =>
        advertised.some((owned) => owned.id === model.id) &&
        (family === "haiku"
          ? /haiku/.test(model.id) && model.reasoning
          : model.compat?.forceAdaptiveThinking && model.thinkingLevelMap?.max),
    );
    if (!source) throw new Error(`Installed provider catalog has no ${family} reasoning fixture`);
    const owned = run.modelRuntime.getModel(CLAUDE_BRIDGE_PROVIDER, source.id);
    if (!owned) throw new Error(`Owned provider omitted catalog model ${source.id}`);
    await run.session.setModel(owned);
    const level = family === "haiku" ? "medium" : "max";
    run.session.setThinkingLevel(level);
    await run.session.prompt(PROMPT);
    successful({ run });
    const options = observations[0]?.options;
    if (!source.compat?.forceAdaptiveThinking) {
      expect(options?.thinking?.type).toBe("enabled");
      expect(options?.effort).toBeUndefined();
      if (options?.thinking?.type === "enabled" && options.thinking.budgetTokens !== undefined)
        expect(options.thinking.budgetTokens).toBeGreaterThan(0);
    } else {
      expect(options?.thinking?.type).toBe("adaptive");
      expect(options?.effort).toBe(source.thinkingLevelMap?.[level]);
    }
    expect(owned.thinkingLevelMap).toEqual(source.thinkingLevelMap);
  });
}
