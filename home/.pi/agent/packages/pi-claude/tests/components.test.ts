import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { SDK_SETTINGS_ISOLATION } from "../extensions/sdk-options.ts";
import { DISABLED_PLUGINS, DISABLED_SKILLS } from "../extensions/components.ts";
import { PROMPT, PROTECTED_CONTENT, WRITE_ARGS } from "./contract.ts";
import { approvedInventories, rejectedInventories } from "./fixtures/components.ts";
import { configureFake, observations } from "./fixtures/fake-sdk.ts";
import { failureCategory } from "./fixtures/provider-diagnostics.ts";
import { createTestSession, lastAssistant } from "./fixtures/session.ts";

vi.mock("@anthropic-ai/claude-agent-sdk", async () => ({
  query: (await import("./fixtures/fake-sdk.ts")).fakeQuery,
}));
let run: Awaited<ReturnType<typeof createTestSession>> | undefined;
afterEach(() => {
  run?.dispose();
  run = undefined;
});

for (const { label, rawInit } of approvedInventories) {
  test(`${label}: native component policy permits the actual Pi guarded flow`, async () => {
    configureFake({ next: "parallel", rawInit });
    run = await createTestSession();
    run.session.agent.toolExecution = "parallel";
    await run.session.prompt(PROMPT);
    const assistant = lastAssistant(run);
    expect(assistant.stopReason, assistant.errorMessage).toBe("stop");
    expect(observations).toHaveLength(1);
    const observed = observations[0];
    expect(observed?.options.settings).toEqual(SDK_SETTINGS_ISOLATION);
    expect(observed?.options.settings).toMatchObject({
      enabledPlugins: DISABLED_PLUGINS,
      skillOverrides: DISABLED_SKILLS,
    });
    expect(observed?.results).toHaveLength(3);
    const results = run.session.messages.filter((message) => message.role === "toolResult");
    expect(results).toHaveLength(3);
    expect(results.filter((message) => !message.isError)).toHaveLength(2);
    const denied = results.find((message) => message.isError);
    expect(JSON.stringify(denied)).toContain("pi-guard");
    expect(JSON.stringify(observed?.results)).not.toContain(PROTECTED_CONTENT);
    expect(readFileSync(join(run.cwd, WRITE_ARGS.path), "utf8")).toBe(WRITE_ARGS.content);
    expect(observed?.closed).toBe(true);
  });
}

for (const { label, rawInit } of rejectedInventories) {
  test(`${label}: rejects before any Pi action with the established failure category`, async () => {
    configureFake({ next: "pipeline", rawInit });
    run = await createTestSession();
    await run.session.prompt(PROMPT);
    const assistant = lastAssistant(run);
    expect(assistant.stopReason).toBe("error");
    expect(failureCategory({ message: assistant.errorMessage })).toBe("initialization-isolation");
    expect(observations).toHaveLength(1);
    expect(observations[0]?.results).toEqual([]);
    expect(observations[0]?.deliveredToolIds).toEqual([]);
    expect(observations[0]?.initContinuationReached).toBe(false);
    expect(observations[0]?.closed).toBe(true);
    expect(run.session.messages.filter((message) => message.role === "toolResult")).toEqual([]);
    expect(run.events.filter((event) => event.type === "tool_execution_start")).toEqual([]);
    expect(existsSync(join(run.cwd, WRITE_ARGS.path))).toBe(false);
  });
}
