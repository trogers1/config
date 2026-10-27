import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { Type } from "typebox";
import {
  clearSandboxCaches,
  resolveSandbox,
  setSandboxBackendForTesting,
  type PreparedSandbox,
  type SandboxBackend,
  type SandboxBackendProbe,
  type SandboxSpec,
} from "../modules/sandbox.lib";
import { createExtensionHarness } from "./support/extensionHarness";
import { policyConfig } from "../modules/policy";
import type { ProfileConfigFile } from "../modules/policyHelpers";

const temporaryDirectories: string[] = [];
const sandboxedDefaultProfile = {
  ...policyConfig.profiles["builtin:default"],
  policy: {
    ...policyConfig.profiles["builtin:default"].policy,
    sandbox: { network: "deny" as const },
  },
};
const sandboxedDefaultState = {
  profile: "builtin:default",
  resolvedProfile: sandboxedDefaultProfile,
  startupCwd: process.cwd(),
};

function writeTempProfileConfig(config: unknown): string {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), `pi-guard-${crypto.randomUUID()}`),
  );
  temporaryDirectories.push(directory);
  const configPath = path.join(directory, "profiles.jsonc");
  fs.writeFileSync(configPath, JSON.stringify(config));
  return configPath;
}

function availableBackend(): SandboxBackend {
  return {
    probe: () => Promise.resolve({ supported: true }),
    prepare: () =>
      Promise.resolve({
        backend: "fake",
        report: {
          uncoveredRestrictions: [],
          waivedRestrictions: [],
          untranslatedAllows: [],
          noKernelMeaning: [],
        },
        denialSignatures: [],
        operations: {
          exec: () => Promise.resolve({ exitCode: 0 }),
        },
        dispose: () => Promise.resolve(),
      }),
    dispose: () => Promise.resolve(),
  };
}

function unavailableBackend(): SandboxBackend {
  return {
    probe(): Promise<SandboxBackendProbe> {
      return Promise.resolve({
        supported: false,
        reason: "sandbox runtime is unavailable",
      });
    },
    prepare(spec: SandboxSpec): Promise<PreparedSandbox> {
      void spec;
      throw new Error("Unavailable backend must not prepare a sandbox");
    },
    dispose: () => Promise.resolve(),
  };
}

function configureApprovalFixture({ name }: { name: string }) {
  setSandboxBackendForTesting(availableBackend());
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `guard-${name}-`));
  temporaryDirectories.push(directory);
  const marker = path.join(directory, "must-not-exist");
  const configPath = writeTempProfileConfig({
    defaultProfile: "contained",
    profiles: {
      contained: {
        description: "Containment approval survives no local fallback.",
        extends: ["builtin:default"],
        writePaths: [{ pattern: `${directory}/**`, decision: "allow" }],
        sandbox: { network: "deny", onUnavailable: "warn" },
      },
    },
  } satisfies ProfileConfigFile);
  process.env.PI_GUARD_PROFILE_CONFIG = configPath;
  return { marker, configPath };
}

afterEach(async () => {
  delete process.env.PI_GUARD_PROFILE_CONFIG;
  delete process.env.PI_SUBAGENT_PROFILE;
  delete process.env.PI_SUBAGENT_PERMISSIBLE_GLOBS;
  setSandboxBackendForTesting(undefined);
  await clearSandboxCaches();
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * These are deliberately fake-backend tests: an unavailable sandbox runtime
 * cannot be induced deterministically through the real OS backend. All
 * containment and normal profile behavior belongs in sandbox.test.ts.
 */
describe("sandbox unavailable-backend lifecycle", () => {
  it.each(["disabled", "unavailable", "command-changed", "policy-changed"])(
    "does not execute locally when an approved sandbox becomes %s",
    async (transition) => {
      const { marker, configPath } = configureApprovalFixture({
        name: "approval-transition",
      });
      const harness = createExtensionHarness({ hasUI: false });
      await harness.start();
      const params = { command: `touch '${marker}'` };
      const call = harness.createToolCall({ toolName: "bash", input: params });
      await expect(
        harness.callToolWithoutPrompt(call),
      ).resolves.toBeUndefined();
      if (transition === "disabled") {
        await harness.runCommand("sandbox-off");
      } else if (transition === "unavailable") {
        setSandboxBackendForTesting(unavailableBackend());
        await clearSandboxCaches();
      } else if (transition === "policy-changed") {
        fs.appendFileSync(configPath, "\n// policy revision after approval\n");
      }
      const executionParams =
        transition === "command-changed"
          ? { command: `${params.command} && ${params.command}` }
          : params;
      const result = await harness.executeTool({
        name: "bash",
        toolCallId: call.toolCallId,
        params: executionParams,
      });
      expect(result).toMatchObject({ isError: true });
      expect(fs.existsSync(marker)).toBe(false);
    },
  );
  it.each(["completed", "changed"])(
    "keeps interleaved approvals independent when another call is %s",
    async (transition) => {
      const { marker } = configureApprovalFixture({
        name: "interleaved-approval",
      });
      const harness = createExtensionHarness({ hasUI: false });
      await harness.start();
      const firstParams = { command: `touch '${marker}'` };
      const secondParams = { ...firstParams };
      const firstCall = harness.createToolCall({
        toolName: "bash",
        input: firstParams,
      });
      const secondCall = harness.createToolCall({
        toolName: "bash",
        input: secondParams,
      });
      await harness.callToolWithoutPrompt(firstCall);
      await harness.callToolWithoutPrompt(secondCall);
      const first = await harness.executeTool({
        name: "bash",
        toolCallId: firstCall.toolCallId,
        params:
          transition === "changed"
            ? { command: `${firstParams.command} && ${firstParams.command}` }
            : firstParams,
      });
      if (transition === "changed") expect(first.isError).toBe(true);
      else expect(first.isError).not.toBe(true);
      expect(fs.existsSync(marker)).toBe(false);
      await harness.runCommand("sandbox-off");
      const second = await harness.executeTool({
        name: "bash",
        toolCallId: secondCall.toolCallId,
        params: secondParams,
      });
      expect(second.isError).toBe(true);
      expect(fs.existsSync(marker)).toBe(false);
    },
  );

  it.each(["nested gate", "nested completion"])(
    "preserves nested and pending approvals when containment changes after %s",
    async (transition) => {
      const { marker } = configureApprovalFixture({ name: "nested-approval" });
      const harness = createExtensionHarness({
        hasUI: false,
        extensions: [
          (pi) => {
            pi.registerTool({
              name: "nested-bash",
              label: "Nested Bash",
              description: "Exercise the SDK nested tool boundary.",
              parameters: Type.Object({}),
              async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
                const nested = await ctx.executeTool("bash", {
                  command: `touch '${marker}'`,
                });
                return { ...nested.result, isError: nested.isError };
              },
            });
            pi.on("tool_call", async (event) => {
              if (
                transition === "nested gate" &&
                event.toolName === "bash" &&
                event.parentToolCallId
              ) {
                await harness.runCommand("sandbox-off");
              }
            });
          },
        ],
      });
      await harness.start();
      const pendingCall = harness.createToolCall({
        toolName: "bash",
        input: { command: `touch '${marker}'` },
      });
      await harness.callToolWithoutPrompt(pendingCall);
      const result = await harness.executeTool({
        name: "nested-bash",
        params: {},
      });
      expect(result.isError).toBe(transition === "nested gate");
      expect(fs.existsSync(marker)).toBe(false);
      await harness.runCommand("sandbox-off");
      const pending = await harness.executeTool({
        name: "bash",
        toolCallId: pendingCall.toolCallId,
        params: pendingCall.input,
      });
      expect(pending.isError).toBe(true);
      expect(fs.existsSync(marker)).toBe(false);
    },
  );

  it("disposes prepared sandboxes and the backend exactly once per cache clear", async () => {
    const preparedDispose = vi.fn(async () => {});
    const backendDispose = vi.fn(async () => {});
    setSandboxBackendForTesting({
      ...availableBackend(),
      prepare: () =>
        Promise.resolve({
          backend: "fake",
          report: {
            uncoveredRestrictions: [],
            waivedRestrictions: [],
            untranslatedAllows: [],
            noKernelMeaning: [],
          },
          denialSignatures: [],
          operations: { exec: () => Promise.resolve({ exitCode: 0 }) },
          dispose: preparedDispose,
        }),
      dispose: backendDispose,
    });

    await resolveSandbox(sandboxedDefaultState);
    preparedDispose.mockClear();
    backendDispose.mockClear();
    await clearSandboxCaches();
    expect(preparedDispose).toHaveBeenCalledOnce();
    expect(backendDispose).toHaveBeenCalledOnce();

    await clearSandboxCaches();
    expect(backendDispose).toHaveBeenCalledTimes(2);
  });

  it("blocks Bash and user ! commands rather than falling back locally by default", async () => {
    setSandboxBackendForTesting(unavailableBackend());
    process.env.PI_GUARD_PROFILE_CONFIG = writeTempProfileConfig({
      defaultProfile: "blocked",
      profiles: {
        blocked: {
          description:
            "Unavailable sandbox backend fail-closed profile with denied network.",
          extends: ["builtin:default"],
          tools: {
            bash: [{ pattern: "echo must-not-run", decision: "ask" }],
          },
          sandbox: { network: "deny" },
        },
      },
    });

    const harness = createExtensionHarness();
    await harness.start();
    const toolCallResult = await harness.callTool({
      toolName: "bash",
      input: { command: "echo must-not-run" },
    });
    expect(toolCallResult).toMatchObject({ block: true });
    expect(toolCallResult?.reason).toContain("Bash sandbox unavailable");
    expect(harness.ui.custom).not.toHaveBeenCalled();
    const unavailableResult = await harness.executeTool({
      name: "bash",
      params: { command: "echo must-not-run" },
    });
    const outputSchema = createBashToolDefinition(process.cwd()).outputSchema;
    if (!outputSchema) throw new Error("Host Bash output schema missing");
    expect(Value.Check(outputSchema, unavailableResult.structuredContent)).toBe(
      true,
    );
    expect(unavailableResult).toMatchObject({
      isError: true,
      details: { exitCode: 126 },
      structuredContent: { exit_code: 126, truncated: false },
    });
    expect(
      (await harness.callUserBash({
        cwd: process.cwd(),
        command: "echo must-not-run",
        excludeFromContext: false,
      })) as unknown,
    ).toMatchObject({ result: { exitCode: 126 } });
    expect(harness.ui.setStatus).toHaveBeenCalledWith(
      "sandbox",
      "sandbox: blocked 🔐",
    );
  });

  it.each(["before", "after"] as const)(
    "blocks Bash when a competing extension replaces it %s session start",
    async (timing) => {
      setSandboxBackendForTesting(availableBackend());
      process.env.PI_GUARD_PROFILE_CONFIG = writeTempProfileConfig({
        defaultProfile: "sandboxed",
        profiles: {
          sandboxed: {
            description: "Sandbox lifecycle profile denying network access.",
            extends: ["builtin:default"],
            tools: {
              bash: [
                {
                  pattern: "node -e 'process.exit(0)'",
                  decision: "ask",
                },
              ],
            },
            sandbox: { network: "deny" },
          },
        },
      });

      const harness = createExtensionHarness();
      if (timing === "before") harness.replaceToolSource("bash", "competing");
      await harness.start();
      try {
        if (timing === "after") {
          harness.replaceToolSource("bash", "competing");
        }
        const result = await harness.callTool({
          toolName: "bash",
          input: { command: "node -e 'process.exit(0)'", timeout: 5 },
        });
        expect(result).toMatchObject({ block: true });
        expect(result?.reason).toContain(
          "bash override no longer owns the effective bash tool",
        );
        expect(harness.ui.custom).not.toHaveBeenCalled();
      } finally {
        await harness.shutdown();
      }
    },
  );

  it("uses explicit warn fallback visibly for both Bash entry points", async () => {
    setSandboxBackendForTesting(unavailableBackend());
    process.env.PI_GUARD_PROFILE_CONFIG = writeTempProfileConfig({
      defaultProfile: "warn",
      profiles: {
        warn: {
          description:
            "Sandbox lifecycle profile warning and falling back when unavailable.",
          extends: ["builtin:default"],
          tools: {
            bash: [{ pattern: "echo policy-ask", decision: "ask" }],
          },
          sandbox: { network: "deny", onUnavailable: "warn" },
        },
      },
    });

    const harness = createExtensionHarness();
    await harness.start();
    await expect(
      harness.callTool({
        toolName: "bash",
        input: { command: "echo policy-ask" },
      }),
    ).resolves.toMatchObject({ block: true });
    expect(harness.ui.custom).toHaveBeenCalledOnce();
    await harness.executeTool({
      name: "bash",
      params: { command: "echo local-fallback" },
    });
    await expect(
      harness.callUserBash({
        cwd: process.cwd(),
        command: "echo local-fallback",
        excludeFromContext: false,
      }),
    ).resolves.toBeUndefined();
    expect(harness.ui.setStatus).toHaveBeenCalledWith(
      "sandbox",
      "sandbox: unavailable 🔐",
    );
    expect(harness.ui.notify).toHaveBeenCalledWith(
      "sandbox runtime is unavailable",
      "warning",
    );
  });
});
