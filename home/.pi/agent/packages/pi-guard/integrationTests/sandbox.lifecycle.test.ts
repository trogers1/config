import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearSandboxCaches,
  setSandboxBackendForTesting,
  type PreparedSandbox,
  type SandboxBackend,
  type SandboxBackendProbe,
  type SandboxSpec,
} from "../modules/sandbox.lib";
import { createExtensionHarness } from "./support/extensionHarness";

const temporaryDirectories: string[] = [];

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
  it("blocks Bash and user ! commands rather than falling back locally by default", async () => {
    setSandboxBackendForTesting(unavailableBackend());
    process.env.PI_GUARD_PROFILE_CONFIG = writeTempProfileConfig({
      defaultProfile: "blocked",
      profiles: {
        blocked: {
          description:
            "Unavailable sandbox backend fail-closed profile with denied network.",
          extends: ["builtin:default"],
          sandbox: { network: "deny" },
        },
      },
    });

    const harness = createExtensionHarness();
    await harness.start();
    expect(
      (await harness.executeTool({
        name: "bash",
        params: { command: "echo must-not-run" },
      })) as unknown,
    ).toMatchObject({ details: { exitCode: 126 } });
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
            sandbox: { network: "deny" },
          },
        },
      });

      const harness = createExtensionHarness({ hasUI: false });
      if (timing === "before") harness.replaceToolSource("bash", "competing");
      await harness.start();
      try {
        if (timing === "after") {
          harness.replaceToolSource("bash", "competing");
        }
        await expect(
          harness.callTool({
            toolName: "bash",
            input: { command: "node -e 'process.exit(0)'", timeout: 5 },
          }),
        ).resolves.toMatchObject({ block: true });
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
          sandbox: { network: "deny", onUnavailable: "warn" },
        },
      },
    });

    const harness = createExtensionHarness();
    await harness.start();
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
