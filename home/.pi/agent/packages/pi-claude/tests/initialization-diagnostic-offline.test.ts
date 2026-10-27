import { existsSync } from "node:fs";
import { expect, test, vi } from "vitest";
import { SDK_RUNTIME_METADATA } from "../extensions/cli.ts";
import { SDK_SETTINGS_ISOLATION } from "../extensions/sdk-options.ts";
import { READ_DEFINITION, WRITE_DEFINITION } from "./contract.ts";
import { configureFake, observations } from "./fixtures/fake-sdk.ts";
import { approvedInventories, rejectedInventories } from "./fixtures/components.ts";
import {
  DIAGNOSTIC_LIMITS,
  DIAGNOSTIC_PROMPT,
  diagnosticJson,
  runInitializationDiagnostic,
} from "./fixtures/initialization-diagnostic.ts";

// Only the external SDK is replaced. The same runner as the live opt-in owns
// the real Pi session, provider, installed-executable resolver and guard wiring.
vi.mock("@anthropic-ai/claude-agent-sdk", async () => ({
  query: (await import("./fixtures/fake-sdk.ts")).fakeQuery,
}));

function expectStoppedAndCleaned({ mcpInitialized = true }: { mcpInitialized?: boolean } = {}) {
  expect(observations).toHaveLength(1);
  const observation = observations[0];
  if (!observation) throw new Error("Missing fake SDK observation");
  expect(observation.inputs).toHaveLength(1);
  expect(observation.inputs[0]?.message.content).toEqual([
    { type: "text", text: DIAGNOSTIC_PROMPT },
  ]);
  expect(observation.closed).toBe(true);
  expect(observation.initContinuationReached).toBe(false);
  expect(observation.results).toEqual([]);
  expect(observation.deliveredToolIds).toEqual([]);
  expect(observation.tools.toSorted()).toEqual(
    mcpInitialized ? [READ_DEFINITION.name, WRITE_DEFINITION.name].toSorted() : [],
  );
  expect(observation.options.settings).toEqual(SDK_SETTINGS_ISOLATION);
  expect(observation.options.tools).toEqual([]);
  expect(observation.options.env?.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe(
    String(DIAGNOSTIC_LIMITS.maxTokens),
  );
  expect(observation.options.model).toMatch(/haiku/i);
  expect(observation.options.cwd).toBeDefined();
  if (!observation.options.cwd) throw new Error("Missing fixture cwd");
  expect(existsSync(observation.options.cwd)).toBe(false);
}

test("first actual init identities survive exactly; paths stay private and production isolation rejects", async () => {
  const inventory = {
    plugins: [
      { name: "plugin\n\u001b\u202e-fixture", source: "@builtin\u007f", version: "1.2.3" },
      { name: "plugin-with-no-optional-native-fields" },
    ],
    skills: ["advertised\t\u2066skill", "another-skill"],
  };
  const privatePath = "/private/fixture/plugin-root-not-for-report";
  configureFake({
    next: "text",
    rawInit: {
      ...inventory,
      plugins: inventory.plugins.map((plugin) => ({
        ...plugin,
        path: privatePath,
        description: "private description",
        config: { secret: "private config" },
      })),
      plugin_errors: [{ plugin: "private error identity", type: "load", message: privatePath }],
    },
  });
  const savedHome = process.env.HOME;
  const report = await runInitializationDiagnostic({ live: false });
  expect(report).toEqual({
    diagnosticSuccess: true,
    bridgeAcceptance: "not-tested",
    outcome: "isolation-rejected",
    category: "initialization-isolation",
    promptCount: 1,
    requestCount: 1,
    initCount: 1,
    cliVersion: SDK_RUNTIME_METADATA.claudeCodeVersion,
    sdkVersion: SDK_RUNTIME_METADATA.version,
    inventory,
  });
  const printed = diagnosticJson({ report });
  expect(JSON.parse(printed)).toEqual(report);
  expect(printed).not.toMatch(/[\u0000-\u001f\u007f-\uffff]/);
  expect(printed).toContain("\\u202e");
  expect(printed).toContain("\\u2066");
  expect(printed).toContain("\\u007f");
  for (const forbidden of [
    privatePath,
    "private description",
    "private config",
    "private error identity",
    "session_id",
    "apiKeySource",
    "cwd",
    DIAGNOSTIC_PROMPT,
  ])
    expect(printed).not.toContain(forbidden);
  expect(process.env.HOME).toBe(savedHome);
  expectStoppedAndCleaned();
});

for (const { label, rawInit } of approvedInventories) {
  test(`${label}: approved init deliberately stops before output or tool dispatch`, async () => {
    // These scenarios normally drive real Pi actions. Never advance past init.
    configureFake({ next: "pipeline", rawInit });
    const report = await runInitializationDiagnostic({ live: false });
    expect(report).toMatchObject({
      diagnosticSuccess: true,
      bridgeAcceptance: "not-tested",
      outcome: "approved-init-stopped",
      category: "deliberate-diagnostic-stop",
      promptCount: 1,
      requestCount: 1,
      initCount: 1,
      inventory: {
        plugins: rawInit.plugins.map(({ name, source, version }) => ({
          name,
          ...(source === undefined ? {} : { source }),
          ...(version === undefined ? {} : { version }),
        })),
        skills: rawInit.skills,
      },
    });
    expectStoppedAndCleaned();
  });
}

for (const { label, rawInit } of rejectedInventories) {
  test(`diagnostic ${label}: never advances beyond unapproved inventory`, async () => {
    configureFake({ next: "pipeline", rawInit });
    const report = await runInitializationDiagnostic({ live: false });
    expect(report.category).toMatch(/^(initialization-isolation|invalid-inventory)$/);
    expect(report.outcome).not.toBe("approved-init-stopped");
    expect(diagnosticJson({ report })).not.toContain("/private/forged");
    expectStoppedAndCleaned();
  });
}

for (const { label, rawInit } of [
  { label: "missing plugins", rawInit: { plugins: undefined } },
  { label: "missing skills", rawInit: { skills: undefined } },
  { label: "null inventory", rawInit: { plugins: null } },
  { label: "malformed source", rawInit: { plugins: [{ name: "fixture", source: 42 }] } },
  { label: "null source", rawInit: { plugins: [{ name: "fixture", source: null }] } },
  { label: "malformed version", rawInit: { plugins: [{ name: "fixture", version: {} }] } },
  { label: "empty name", rawInit: { plugins: [{ name: "" }] } },
  { label: "malformed skill", rawInit: { skills: [42] } },
  {
    label: "oversized identity",
    rawInit: { plugins: [{ name: "x".repeat(DIAGNOSTIC_LIMITS.identityChars + 1) }] },
  },
  {
    label: "oversized source",
    rawInit: {
      plugins: [{ name: "fixture", source: "x".repeat(DIAGNOSTIC_LIMITS.identityChars + 1) }],
    },
  },
  {
    label: "oversized version",
    rawInit: {
      plugins: [{ name: "fixture", version: "x".repeat(DIAGNOSTIC_LIMITS.identityChars + 1) }],
    },
  },
  {
    label: "oversized plugin list",
    rawInit: {
      plugins: Array.from({ length: DIAGNOSTIC_LIMITS.inventoryItems + 1 }, () => ({
        name: "fixture",
      })),
    },
  },
  {
    label: "oversized skill list",
    rawInit: {
      skills: Array.from({ length: DIAGNOSTIC_LIMITS.inventoryItems + 1 }, () => "fixture"),
    },
  },
]) {
  test(`${label}: fail closed with only a safe category and always clean up`, async () => {
    configureFake({ next: "pipeline", rawInit });
    const savedHome = process.env.HOME;
    const report = await runInitializationDiagnostic({ live: false });
    expect(report).toMatchObject({
      diagnosticSuccess: false,
      outcome: "failed",
      category: "invalid-inventory",
      promptCount: 1,
      requestCount: 1,
      initCount: 1,
    });
    expect(report.inventory).toBeUndefined();
    expect(process.env.HOME).toBe(savedHome);
    expectStoppedAndCleaned();
  });
}

for (const { next, category } of [
  { next: "no-init", category: "missing-report" },
  { next: "pre-init-model", category: "pre-init-activity" },
  { next: "throw", category: "missing-report" },
] satisfies { next: Parameters<typeof configureFake>[0]["next"]; category: string }[]) {
  test(`${next}: no acceptance and no raw external failure text`, async () => {
    configureFake({ next });
    const report = await runInitializationDiagnostic({ live: false });
    expect(report).toMatchObject({ diagnosticSuccess: false, outcome: "failed", category });
    expect(report.inventory).toBeUndefined();
    expect(diagnosticJson({ report })).not.toContain("SDK transport failure");
    expectStoppedAndCleaned({ mcpInitialized: next !== "throw" });
  });
}
