import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadRawProfileConfig,
  resolveProfileConfigPath,
} from "../modules/profileConfig";
import type { ProfileConfigFile } from "../modules/policyHelpers";
import { setGuardOperationObserverForTesting } from "../extensions/guard";
import {
  setSandboxBackendForTesting,
  type SandboxSpec,
} from "../modules/sandbox.lib";
import { createExtensionHarness } from "./support/extensionHarness";
import {
  denyChoice,
  installProfileUpdateFixture,
  profileWithBashRule,
  recordingSandboxBackend,
  replaceConfig,
  saveRulesChoice,
  trackTemporaryDirectory,
  writeConfig,
} from "./support/profileUpdateTestSupport";

installProfileUpdateFixture({});

describe("profile updates through the public extension surface", () => {
  it("discards a stale picker answer when a newer allow makes the operation effective", async () => {
    const configPath = writeConfig({
      config: {
        defaultProfile: "current",
        profiles: {
          current: {
            description: "Current",
            extends: ["builtin:default"],
            tools: {
              bash: [{ pattern: "echo stale-picker", decision: "ask" }],
            },
          },
        },
      },
    });
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const harness = createExtensionHarness({ interactiveUi: true });
    await harness.start();
    const pending = harness.callTool({
      toolName: "bash",
      input: { command: "echo stale-picker" },
    });
    const picker = await harness.ui.waitForPermissionChoice();
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        defaultProfile: "current",
        profiles: {
          current: {
            description: "Current",
            extends: ["builtin:default"],
            tools: {
              bash: [{ pattern: "echo stale-picker", decision: "allow" }],
            },
          },
        },
      }),
    );
    picker.choose(denyChoice);
    expect(await pending).toBeUndefined();
    expect(harness.ui.custom).toHaveBeenCalledTimes(1);
  });

  it("discards a stale rule-editor submission when a newer deny takes precedence", async () => {
    const configPath = writeConfig({
      config: {
        defaultProfile: "current",
        profiles: {
          current: {
            description: "Current",
            extends: ["builtin:default"],
            tools: {
              bash: [{ pattern: "echo stale-editor", decision: "ask" }],
            },
          },
        },
      },
    });
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const harness = createExtensionHarness({ interactiveUi: true });
    await harness.start();
    const pending = harness.callTool({
      toolName: "bash",
      input: { command: "echo stale-editor" },
    });
    (await harness.ui.waitForPermissionChoice()).choose(saveRulesChoice);
    const editor = await harness.ui.waitForRuleForm();
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        defaultProfile: "current",
        profiles: {
          current: {
            description: "Current",
            extends: ["builtin:default"],
            tools: {
              bash: [{ pattern: "echo stale-editor", decision: "deny" }],
            },
          },
        },
      }),
    );
    editor.press("Enter");
    expect(await pending).toMatchObject({ block: true });
    expect(harness.ui.custom).toHaveBeenCalledTimes(2);
    expect(
      loadRawProfileConfig({ configPath })?.profiles.current.tools?.bash,
    ).toEqual([{ pattern: "echo stale-editor", decision: "deny" }]);
  });

  it("propagates writer allow and deny decisions to already-running parent and sibling instances", async () => {
    const profile = "shared-running";
    const commandFor = (decision: "allow" | "deny") =>
      `echo shared-${decision}`;
    const configPath = writeConfig({
      config: {
        defaultProfile: profile,
        profiles: {
          [profile]: {
            description: "Shared mutable profile",
            extends: ["builtin:default"],
            tools: {
              bash: [
                { pattern: commandFor("allow"), decision: "ask" },
                { pattern: commandFor("deny"), decision: "ask" },
              ],
            },
          },
        },
      },
    });
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const writer = createExtensionHarness({ interactiveUi: true });
    const parent = createExtensionHarness({ hasUI: false });
    const sibling = createExtensionHarness({ hasUI: false });
    await Promise.all([writer.start(), parent.start(), sibling.start()]);

    for (const decision of ["allow", "deny"] as const) {
      const command = commandFor(decision);
      const save = writer.callTool({
        toolName: "bash",
        input: { command },
      });
      (await writer.ui.waitForPermissionChoice()).choose(saveRulesChoice);
      const editor = await writer.ui.waitForRuleForm();
      if (decision === "deny") editor.press("Tab");
      editor.press("Enter");
      const writerResult = await save;
      expect(writerResult?.block ?? false).toBe(decision === "deny");

      for (const observer of [parent, sibling]) {
        const result = await observer.callToolDecisivelyWithoutPrompt({
          toolName: "bash",
          input: { command },
        });
        expect(result?.block ?? false).toBe(decision === "deny");
      }
    }
  }, 10_000);

  it("refreshes inherited parent policy in an already-running child tool call", async () => {
    const command = "echo inherited-refresh";
    const config = (decision: "allow" | "deny") => ({
      defaultProfile: "child",
      profiles: {
        parent: {
          description: "Parent",
          extends: ["builtin:default"],
          tools: { bash: [{ pattern: command, decision }] },
        },
        child: { description: "Child", extends: ["parent"] },
      },
    });
    const configPath = writeConfig({ config: config("allow") });
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const child = createExtensionHarness({ hasUI: false });
    await child.start();
    await child.callToolWithoutPrompt({ toolName: "bash", input: { command } });

    replaceConfig({ configPath, config: config("deny") });
    expect(
      await child.callToolDecisivelyWithoutPrompt({
        toolName: "bash",
        input: { command },
      }),
    ).toMatchObject({ block: true });
  });

  it("fails closed across running instances for deleted and malformed adopted sources, then recovers coherently", async () => {
    const command = "echo restored-source";
    const config = profileWithBashRule({ command, decision: "allow" });
    const configPath = writeConfig({ config: config });
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const parent = createExtensionHarness({ hasUI: false });
    const sibling = createExtensionHarness({ hasUI: false });
    await Promise.all([parent.start(), sibling.start()]);

    for (const replacement of [undefined, "{ malformed"] as const) {
      if (replacement === undefined) fs.rmSync(configPath);
      else fs.writeFileSync(configPath, replacement);
      for (const observer of [parent, sibling]) {
        expect(
          await observer.callTool({ toolName: "bash", input: { command } }),
        ).toMatchObject({ block: true });
        expect(observer.ui.setStatus).toHaveBeenCalledWith(
          "permissions",
          "invalid-permissions",
        );
        expect(observer.ui.setStatus).toHaveBeenCalledWith(
          "sandbox",
          "sandbox: blocked (invalid permissions)",
        );
      }
      replaceConfig({ configPath, config });
      for (const observer of [parent, sibling]) {
        await observer.callToolWithoutPrompt({
          toolName: "bash",
          input: { command },
        });
      }
      expect(process.env.PI_GUARD_ACTIVE_PROFILE).toBe("current");
    }
  });

  it("adopts the resolved DEFAULT path across running instances, fails closed after deletion, and recovers the built-in profile", async () => {
    const home = fs.mkdtempSync(
      path.join(os.tmpdir(), "pi-guard-default-home-"),
    );
    trackTemporaryDirectory({ directory: home });
    process.env.HOME = home;
    delete process.env.PI_GUARD_PROFILE_CONFIG;
    const configPath = resolveProfileConfigPath({});
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const config = { defaultProfile: "builtin:default", profiles: {} };
    const command = "pwd";
    replaceConfig({ configPath, config });
    const parent = createExtensionHarness({ hasUI: false });
    const sibling = createExtensionHarness({ hasUI: false });
    await Promise.all([parent.start(), sibling.start()]);
    for (const observer of [parent, sibling])
      await observer.callToolWithoutPrompt({
        toolName: "bash",
        input: { command },
      });

    fs.rmSync(configPath);
    for (const observer of [parent, sibling]) {
      const result = await observer.callTool({
        toolName: "bash",
        input: { command },
      });
      expect(result?.block).toBe(true);
      expect(observer.ui.setStatus).toHaveBeenCalledWith(
        "permissions",
        "invalid-permissions",
      );
    }
    expect(process.env.PI_GUARD_ACTIVE_PROFILE).toBeUndefined();

    replaceConfig({ configPath, config });
    for (const observer of [parent, sibling]) {
      await observer.callToolWithoutPrompt({
        toolName: "bash",
        input: { command },
      });
      expect(observer.ui.setStatus).toHaveBeenCalledWith(
        "permissions",
        expect.stringContaining("builtin:default"),
      );
    }
    expect(process.env.PI_GUARD_ACTIVE_PROFILE).toBe("builtin:default");
  });

  it("clears each running sandbox cache on failed-source recovery instead of reusing its stale prepared config", async () => {
    const command = "echo sandbox-cache-recovery";
    const prepared: SandboxSpec[] = [];
    setSandboxBackendForTesting(recordingSandboxBackend({ prepared }));
    const config = {
      defaultProfile: "sandboxed",
      profiles: {
        sandboxed: {
          description: "Sandbox cache fixture",
          extends: ["builtin:default"],
          tools: { bash: [{ pattern: command, decision: "allow" }] },
          sandbox: { network: "deny" },
        },
      },
    } satisfies ProfileConfigFile;
    const configPath = writeConfig({ config });
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const parent = createExtensionHarness({ hasUI: false });
    const sibling = createExtensionHarness({ hasUI: false });
    await Promise.all([parent.start(), sibling.start()]);
    expect(prepared).toHaveLength(1);

    fs.rmSync(configPath);
    for (const observer of [parent, sibling]) {
      const result = await observer.callTool({
        toolName: "bash",
        input: { command },
      });
      expect(result?.block).toBe(true);
      expect(observer.ui.setStatus).toHaveBeenCalledWith(
        "sandbox",
        "sandbox: blocked (invalid permissions)",
      );
    }
    expect(process.env.PI_GUARD_ACTIVE_PROFILE).toBeUndefined();

    replaceConfig({ configPath, config });
    for (const observer of [parent, sibling]) {
      await observer.callToolWithoutPrompt({
        toolName: "bash",
        input: { command },
      });
      expect(observer.ui.setStatus).toHaveBeenCalledWith(
        "sandbox",
        "sandbox: fake 🔐",
      );
      expect(observer.ui.setStatus).toHaveBeenCalledWith(
        "permissions",
        expect.stringContaining("sandboxed"),
      );
    }
    // Both already-running instances prepare a fresh resolution after their
    // own failed state; a stale pre-failure cache would leave this at one.
    expect(prepared).toHaveLength(3);
    expect(prepared.every(({ network }) => network === "deny")).toBe(true);
    expect(process.env.PI_GUARD_ACTIVE_PROFILE).toBe("sandboxed");
  });

  it("preserves an explicitly activated non-directory profile across unchanged guarded operations", async () => {
    const command = "echo explicit-profile-persists";
    const cwd = process.cwd();
    const configPath = writeConfig({
      config: {
        defaultProfile: "directory-profile",
        profiles: {
          "directory-profile": {
            description: "Directory authority",
            extends: ["builtin:default"],
            directoryGlobs: [cwd],
            tools: { bash: [{ pattern: command, decision: "deny" }] },
          },
          "explicit-profile": {
            description: "Explicit user selection",
            extends: ["builtin:default"],
            tools: { bash: [{ pattern: command, decision: "allow" }] },
          },
        },
      },
    });
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const harness = createExtensionHarness({ hasUI: false, contextCwd: cwd });
    await harness.start();
    await harness.runCommand("profile", "explicit-profile");

    for (let operation = 0; operation < 3; operation++) {
      await harness.callToolWithoutPrompt({
        toolName: "bash",
        input: { command },
      });
      expect(process.env.PI_GUARD_ACTIVE_PROFILE).toBe("explicit-profile");
      expect(harness.ui.setStatus).toHaveBeenLastCalledWith(
        "permissions",
        expect.stringContaining("explicit-profile"),
      );
      expect(harness.entries.at(-1)).toMatchObject({
        data: { profile: "explicit-profile" },
      });
    }
  });

  it("keeps a durable ASK save and its next operation on the active user-owned profile", async () => {
    const command = "echo save-active-profile";
    const cwd = process.cwd();
    const configPath = writeConfig({
      config: {
        defaultProfile: "directory-profile",
        profiles: {
          "directory-profile": {
            description: "Directory authority",
            extends: ["builtin:default"],
            directoryGlobs: [cwd],
            tools: { bash: [{ pattern: command, decision: "deny" }] },
          },
          "active-profile": {
            description: "ASK owner",
            extends: ["builtin:default"],
            tools: { bash: [{ pattern: command, decision: "ask" }] },
          },
        },
      },
    });
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const harness = createExtensionHarness({
      interactiveUi: true,
      contextCwd: cwd,
    });
    await harness.start();
    await harness.runCommand("profile", "active-profile");

    const pending = harness.callTool({ toolName: "bash", input: { command } });
    (await harness.ui.waitForPermissionChoice()).choose(saveRulesChoice);
    (await harness.ui.waitForRuleForm()).press("Enter");
    await pending;

    expect(
      loadRawProfileConfig({ configPath })?.profiles["active-profile"].tools
        ?.bash,
    ).toEqual([{ pattern: command, decision: "allow" }]);
    expect(process.env.PI_GUARD_ACTIVE_PROFILE).toBe("active-profile");
    expect(harness.entries.at(-1)).toMatchObject({
      data: { profile: "active-profile" },
    });
    await harness.callToolWithoutPrompt({
      toolName: "bash",
      input: { command },
    });
    expect(process.env.PI_GUARD_ACTIVE_PROFILE).toBe("active-profile");
  });

  it("keeps a durable ASK save coherent while its post-write cache transition is paused", async () => {
    const command = "echo save-transition-coherence";
    const cwd = process.cwd();
    const configPath = writeConfig({
      config: {
        defaultProfile: "directory-profile",
        profiles: {
          "directory-profile": {
            description: "Directory authority that must never win this save.",
            extends: ["builtin:default"],
            directoryGlobs: [cwd],
            tools: { bash: [{ pattern: command, decision: "deny" }] },
          },
          "active-profile": {
            description: "User-owned durable ASK owner.",
            extends: ["builtin:default"],
            tools: { bash: [{ pattern: command, decision: "ask" }] },
          },
        },
      },
    });
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const harness = createExtensionHarness({
      interactiveUi: true,
      contextCwd: cwd,
    });
    await harness.start();
    await harness.runCommand("profile", "active-profile");
    const statusCountAfterActivation = harness.ui.setStatus.mock.calls.length;

    let releaseCacheTransition: (() => void) | undefined;
    let signalCacheTransition: () => void = () => undefined;
    const cacheTransitionStarted = new Promise<void>((resolve) => {
      signalCacheTransition = resolve;
    });
    const cacheTransition = new Promise<void>((resolve) => {
      releaseCacheTransition = resolve;
    });
    let pauseNextDisposal = true;
    setSandboxBackendForTesting({
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
          operations: { exec: () => Promise.resolve({ exitCode: 0 }) },
          dispose: () => Promise.resolve(),
        }),
      dispose: () => {
        if (!pauseNextDisposal) return Promise.resolve();
        pauseNextDisposal = false;
        signalCacheTransition();
        return cacheTransition;
      },
    });

    const saved = harness.callTool({ toolName: "bash", input: { command } });
    (await harness.ui.waitForPermissionChoice()).choose(saveRulesChoice);
    (await harness.ui.waitForRuleForm()).press("Enter");
    await cacheTransitionStarted;

    const statusesBeforeRelease = harness.ui.setStatus.mock.calls.slice(
      statusCountAfterActivation,
    );
    expect(process.env.PI_GUARD_ACTIVE_PROFILE).toBe("active-profile");
    expect(statusesBeforeRelease).not.toContainEqual([
      "permissions",
      expect.stringContaining("directory-profile"),
    ]);

    // Explicit boundary markers make this independent of the sandbox module's
    // own lifecycle queue: the concurrent call has requested refresh, but
    // cannot begin policy evaluation until the paused post-save transition is
    // released.
    const entries: string[] = [];
    setGuardOperationObserverForTesting({
      observer: {
        onRefreshRequested: ({ toolName }) => {
          if (toolName === "bash") entries.push("refresh-requested");
        },
        onRefreshStarted: ({ toolName }) => {
          if (toolName === "profile-refresh") entries.push("refresh-started");
        },
        onEvaluationStarted: ({ toolName }) => {
          if (toolName === "bash") entries.push("evaluation-started");
        },
      },
    });
    const concurrent = harness.callTool({
      toolName: "bash",
      input: { command },
    });
    // Request observation is synchronous. Entering the locked refresh is not:
    // it remains queued behind the paused post-save transition.
    expect(entries).toEqual(["refresh-requested"]);
    expect(process.env.PI_GUARD_ACTIVE_PROFILE).toBe("active-profile");

    releaseCacheTransition?.();
    await saved;
    expect(await concurrent).toBeUndefined();
    expect(entries).toEqual([
      "refresh-requested",
      "refresh-started",
      "evaluation-started",
      "refresh-requested",
      "refresh-started",
      "evaluation-started",
    ]);

    expect(process.env.PI_GUARD_ACTIVE_PROFILE).toBe("active-profile");
    expect(harness.ui.setStatus).toHaveBeenLastCalledWith(
      "permissions",
      expect.stringContaining("active-profile"),
    );
    expect(harness.entries.at(-1)).toMatchObject({
      data: { profile: "active-profile" },
    });
  });

  it("fails closed for a rejected post-save disposal, blocks queued work, and rebuilds on recovery", async () => {
    const command = "echo rejected-transition";
    const prepared: SandboxSpec[] = [];
    let rejectNextDisposal = false;
    let signalDisposalStarted: () => void = () => undefined;
    const disposalStarted = new Promise<void>((resolve) => {
      signalDisposalStarted = resolve;
    });
    let rejectTransition: (reason: Error) => void = () => undefined;
    const rejectedTransition = new Promise<void>((_resolve, reject) => {
      rejectTransition = reject;
    });
    setSandboxBackendForTesting({
      probe: () => Promise.resolve({ supported: true }),
      prepare: (spec) => {
        prepared.push(spec);
        return Promise.resolve({
          backend: "fake",
          report: {
            uncoveredRestrictions: [],
            waivedRestrictions: [],
            untranslatedAllows: [],
            noKernelMeaning: [],
          },
          denialSignatures: [],
          operations: { exec: () => Promise.resolve({ exitCode: 0 }) },
          dispose: () => Promise.resolve(),
        });
      },
      dispose: () => {
        if (!rejectNextDisposal) return Promise.resolve();
        rejectNextDisposal = false;
        signalDisposalStarted();
        return rejectedTransition;
      },
    });
    const configPath = writeConfig({
      config: {
        defaultProfile: "sandboxed",
        profiles: {
          sandboxed: {
            description: "Disposal-recovery fixture",
            extends: ["builtin:default"],
            tools: { bash: [{ pattern: command, decision: "ask" }] },
            sandbox: { network: "deny" },
          },
        },
      },
    });
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const harness = createExtensionHarness({
      interactiveUi: true,
      contextCwd: process.cwd(),
    });
    await harness.start();
    expect(prepared).toHaveLength(1);

    rejectNextDisposal = true;
    const saving = harness.callTool({ toolName: "bash", input: { command } });
    (await harness.ui.waitForPermissionChoice()).choose(saveRulesChoice);
    (await harness.ui.waitForRuleForm()).press("Enter");
    await disposalStarted;

    const queued = harness.callTool({ toolName: "bash", input: { command } });
    rejectTransition(new Error("dispose rejected once"));
    expect(await saving).toMatchObject({ block: true });
    const queuedResult = await queued;
    expect(queuedResult).toMatchObject({ block: true });
    expect(queuedResult?.reason).toContain("dispose rejected once");
    expect(process.env.PI_GUARD_ACTIVE_PROFILE).toBeUndefined();
    expect(harness.ui.setStatus).toHaveBeenCalledWith(
      "sandbox",
      "sandbox: blocked (invalid permissions)",
    );
    expect(harness.ui.setStatus).toHaveBeenCalledWith(
      "permissions",
      "invalid-permissions",
    );

    await harness.callToolWithoutPrompt({
      toolName: "bash",
      input: { command },
    });
    expect(prepared).toHaveLength(2);
    expect(prepared.at(-1)?.network).toBe("deny");
    expect(process.env.PI_GUARD_ACTIVE_PROFILE).toBe("sandboxed");
    expect(harness.ui.setStatus).toHaveBeenLastCalledWith(
      "permissions",
      expect.stringContaining("sandboxed"),
    );
  });
});
