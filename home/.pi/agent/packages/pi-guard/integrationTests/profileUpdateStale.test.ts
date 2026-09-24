import { describe, expect, it } from "vitest";
import { loadRawProfileConfig } from "../modules/profileConfig";
import type { ProfileConfigFile } from "../modules/policyHelpers";
import { createExtensionHarness } from "./support/extensionHarness";
import {
  allowOnceChoice,
  customToolScenario,
  denyChoice,
  durableDecisions,
  expectDecision,
  installProfileUpdateFixture,
  ordinaryPathScenario,
  profileWithBashRule,
  profileWithCustomToolRule,
  profileWithOrdinaryPathRule,
  replaceConfig,
  saveBashDecision,
  saveOrdinaryPathDecision,
  saveRulesChoice,
  writeConfig,
} from "./support/profileUpdateTestSupport";

installProfileUpdateFixture({});

describe("profile updates through the public extension surface", () => {
  it("re-resolves removed default and directory authorities from one replacement revision", async () => {
    const command = "echo authority-replacement";
    const cwd = process.cwd();
    const initial = {
      defaultProfile: "old",
      profiles: {
        old: {
          description: "Old",
          extends: ["builtin:default"],
          tools: { bash: [{ pattern: command, decision: "deny" }] },
          directoryGlobs: [cwd],
        },
      },
    } satisfies ProfileConfigFile;
    const replacement = {
      defaultProfile: "replacement",
      profiles: {
        replacement: {
          description: "Replacement",
          extends: ["builtin:default"],
          tools: { bash: [{ pattern: command, decision: "allow" }] },
          directoryGlobs: [cwd],
        },
      },
    } satisfies ProfileConfigFile;
    const configPath = writeConfig({ config: initial });
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const running = createExtensionHarness({ hasUI: false, contextCwd: cwd });
    await running.start();
    expect(
      await running.callToolDecisivelyWithoutPrompt({
        toolName: "bash",
        input: { command },
      }),
    ).toMatchObject({ block: true });

    replaceConfig({ configPath, config: replacement });
    await running.callToolWithoutPrompt({
      toolName: "bash",
      input: { command },
    });
    expect(process.env.PI_GUARD_ACTIVE_PROFILE).toBe("replacement");
  });

  it.each(["allow", "deny"] as const)(
    "applies a newer %s policy while denial guidance input is pending",
    async (decision) => {
      const command = `echo guidance-newer-${decision}`;
      const configPath = writeConfig({
        config: profileWithBashRule({ command, decision: "ask" }),
      });
      process.env.PI_GUARD_PROFILE_CONFIG = configPath;
      const parent = createExtensionHarness({ interactiveUi: true });
      let submitGuidance: (value: string | undefined) => void = () => undefined;
      const guidanceInput = new Promise<string | undefined>((resolve) => {
        submitGuidance = resolve;
      });
      parent.ui.editor.mockImplementationOnce(() => guidanceInput);
      const writer = createExtensionHarness({ interactiveUi: true });
      await Promise.all([parent.start(), writer.start()]);
      const pending = parent.callTool({ toolName: "bash", input: { command } });
      (await parent.ui.waitForPermissionChoice()).choose(denyChoice);
      await saveBashDecision({ harness: writer, command, decision });
      submitGuidance("obsolete guidance");

      const result = await pending;
      if (decision === "deny") {
        expect(result).toMatchObject({ block: true });
        expect(result?.reason).not.toContain("obsolete guidance");
      } else expect(result).toBeUndefined();
    },
  );

  it("re-evaluates the immutable Bash command when a protected path changes during ASK", async () => {
    const command = "echo protected > protected-after-ask.txt";
    const configPath = writeConfig({
      config: profileWithBashRule({ command, decision: "ask" }),
    });
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const running = createExtensionHarness({ interactiveUi: true });
    await running.start();
    const pending = running.callTool({ toolName: "bash", input: { command } });
    const picker = await running.ui.waitForPermissionChoice();
    replaceConfig({
      configPath,
      config: {
        ...profileWithBashRule({ command, decision: "ask" }),
        profiles: {
          current: {
            description: "Protected after prompt",
            extends: ["builtin:default"],
            tools: { bash: [{ pattern: command, decision: "ask" }] },
            protectedPathRules: [
              { pattern: "protected-after-ask.txt", decision: "deny" },
            ],
          },
        },
      },
    });
    picker.choose(allowOnceChoice);
    const result = await pending;
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain("protected-path policy");
  });

  it("keeps PI_SUBAGENT_PROFILE authoritative and fails closed when it is deleted", async () => {
    const command = "echo authoritative-profile";
    const configPath = writeConfig({
      config: {
        defaultProfile: "other",
        profiles: {
          authoritative: {
            description: "Authoritative",
            extends: ["builtin:default"],
            tools: { bash: [{ pattern: command, decision: "allow" }] },
          },
          other: {
            description: "Other",
            extends: ["builtin:default"],
            tools: { bash: [{ pattern: command, decision: "deny" }] },
          },
        },
      },
    });
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    process.env.PI_SUBAGENT_PROFILE = "authoritative";
    const running = createExtensionHarness({ hasUI: false });
    await running.start();
    await running.callToolWithoutPrompt({
      toolName: "bash",
      input: { command },
    });

    replaceConfig({
      configPath,
      config: profileWithBashRule({
        profile: "other",
        command,
        decision: "deny",
      }),
    });
    const result = await running.callTool({
      toolName: "bash",
      input: { command },
    });
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain("Invalid");
  });

  it("fails closed after bounded repeated revisions without recursively accepting stale prompts", async () => {
    const command = "echo bounded-stale-revisions";
    const configPath = writeConfig({
      config: profileWithBashRule({ command, decision: "ask" }),
    });
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const running = createExtensionHarness({ interactiveUi: true });
    await running.start();
    const pending = running.callTool({ toolName: "bash", input: { command } });
    for (let revision = 0; revision < 4; revision++) {
      const picker = await running.ui.waitForPermissionChoice();
      replaceConfig({
        configPath,
        config: profileWithBashRule({
          command,
          decision: "ask",
          description: `Cross-instance profile revision ${revision}`,
        }),
      });
      picker.choose(allowOnceChoice);
    }
    const result = await pending;
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain("changed repeatedly");
    expect(running.ui.custom).toHaveBeenCalledTimes(4);
  });

  it.each(durableDecisions)(
    "discards a cross-instance stale picker answer after a newer %s decision",
    async (decision) => {
      const command = `echo picker-newer-${decision}`;
      const configPath = writeConfig({
        config: profileWithBashRule({ command, decision: "ask" }),
      });
      process.env.PI_GUARD_PROFILE_CONFIG = configPath;
      const parent = createExtensionHarness({ interactiveUi: true });
      const writer = createExtensionHarness({ interactiveUi: true });
      await Promise.all([parent.start(), writer.start()]);

      const pending = parent.callTool({ toolName: "bash", input: { command } });
      const stalePicker = await parent.ui.waitForPermissionChoice();
      await saveBashDecision({ harness: writer, command, decision });
      stalePicker.choose(denyChoice);

      // The answer was made visible before the writer committed, then is
      // discarded when the running parent checks the shared source again.
      const result = await pending;
      if (decision === "deny") expect(result).toMatchObject({ block: true });
      else expect(result).toBeUndefined();
      expect(parent.ui.custom).toHaveBeenCalledTimes(1);
      expect(
        loadRawProfileConfig({ configPath })?.profiles.current.tools?.bash,
      ).toEqual([{ pattern: command, decision }]);
    },
  );

  it.each(durableDecisions)(
    "discards a cross-instance stale durable editor after a newer %s decision",
    async (decision) => {
      const command = `echo editor-newer-${decision}`;
      const configPath = writeConfig({
        config: profileWithBashRule({ command, decision: "ask" }),
      });
      process.env.PI_GUARD_PROFILE_CONFIG = configPath;
      const parent = createExtensionHarness({ interactiveUi: true });
      const writer = createExtensionHarness({ interactiveUi: true });
      await Promise.all([parent.start(), writer.start()]);

      const pending = parent.callTool({ toolName: "bash", input: { command } });
      (await parent.ui.waitForPermissionChoice()).choose(saveRulesChoice);
      const staleEditor = await parent.ui.waitForRuleForm();
      await saveBashDecision({ harness: writer, command, decision });
      staleEditor.press("Enter");

      const result = await pending;
      if (decision === "deny") expect(result).toMatchObject({ block: true });
      else expect(result).toBeUndefined();
      expect(parent.ui.custom).toHaveBeenCalledTimes(2);
      expect(
        loadRawProfileConfig({ configPath })?.profiles.current.tools?.bash,
      ).toEqual([{ pattern: command, decision }]);
    },
  );

  it.each(durableDecisions)(
    "propagates a newer ordinary-path %s decision to already-running parent and sibling instances",
    async (decision) => {
      const scenario = ordinaryPathScenario({
        path: `shared-path-${decision}.txt`,
      });
      const configPath = writeConfig({
        config: profileWithOrdinaryPathRule({
          path: scenario.path,
          decision: "ask",
        }),
      });
      process.env.PI_GUARD_PROFILE_CONFIG = configPath;
      const writer = createExtensionHarness({ interactiveUi: true });
      const parent = createExtensionHarness({ hasUI: false });
      const sibling = createExtensionHarness({ hasUI: false });
      await Promise.all([writer.start(), parent.start(), sibling.start()]);

      await saveOrdinaryPathDecision({ harness: writer, scenario, decision });
      for (const observer of [parent, sibling]) {
        expectDecision({
          result: await observer.callToolDecisivelyWithoutPrompt(scenario),
          decision,
        });
      }
    },
  );

  it.each(durableDecisions)(
    "propagates a newer custom-tool %s decision to already-running parent and sibling instances",
    async (decision) => {
      const scenario = customToolScenario();
      const configPath = writeConfig({
        config: profileWithCustomToolRule({ decision: "ask" }),
      });
      process.env.PI_GUARD_PROFILE_CONFIG = configPath;
      const parent = createExtensionHarness({ hasUI: false });
      const sibling = createExtensionHarness({ hasUI: false });
      await Promise.all([parent.start(), sibling.start()]);

      // Custom-tool policy has no durable editor. A real shared source revision
      // is still observed by both already-running production harnesses.
      replaceConfig({
        configPath,
        config: profileWithCustomToolRule({ decision }),
      });
      for (const observer of [parent, sibling]) {
        expectDecision({
          result: await observer.callToolDecisivelyWithoutPrompt(scenario),
          decision,
        });
      }
    },
  );

  it.each(durableDecisions)(
    "discards an ordinary-path pending picker answer after a newer %s revision",
    async (decision) => {
      const scenario = ordinaryPathScenario({
        path: `picker-path-${decision}.txt`,
      });
      const configPath = writeConfig({
        config: profileWithOrdinaryPathRule({
          path: scenario.path,
          decision: "ask",
        }),
      });
      process.env.PI_GUARD_PROFILE_CONFIG = configPath;
      const parent = createExtensionHarness({ interactiveUi: true });
      const writer = createExtensionHarness({ interactiveUi: true });
      await Promise.all([parent.start(), writer.start()]);

      const pending = parent.callTool(scenario);
      const stalePicker = await parent.ui.waitForPermissionChoice();
      await saveOrdinaryPathDecision({ harness: writer, scenario, decision });
      stalePicker.choose(denyChoice);
      expectDecision({ result: await pending, decision });
      expect(parent.ui.custom).toHaveBeenCalledTimes(1);
    },
  );

  it.each(durableDecisions)(
    "discards a custom-tool pending picker answer after a newer %s revision",
    async (decision) => {
      const scenario = customToolScenario();
      const configPath = writeConfig({
        config: profileWithCustomToolRule({ decision: "ask" }),
      });
      process.env.PI_GUARD_PROFILE_CONFIG = configPath;
      const parent = createExtensionHarness({ interactiveUi: true });
      const writer = createExtensionHarness({ hasUI: false });
      await Promise.all([parent.start(), writer.start()]);

      const pending = parent.callTool(scenario);
      const stalePicker = await parent.ui.waitForPermissionChoice();
      replaceConfig({
        configPath,
        config: profileWithCustomToolRule({ decision }),
      });
      stalePicker.choose(denyChoice);
      expectDecision({ result: await pending, decision });
      expect(parent.ui.custom).toHaveBeenCalledTimes(1);
    },
  );

  it("rebuilds an ordinary-path editor from the N+1 ASK revision and never persists stale edits", async () => {
    const scenario = ordinaryPathScenario({ path: "immutable-request.txt" });
    const configPath = writeConfig({
      config: profileWithOrdinaryPathRule({
        path: scenario.path,
        decision: "ask",
      }),
    });
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const parent = createExtensionHarness({ interactiveUi: true });
    await parent.start();

    const pending = parent.callTool(scenario);
    (await parent.ui.waitForPermissionChoice()).choose(saveRulesChoice);
    const staleEditor = await parent.ui.waitForRuleForm();
    staleEditor.press("CtrlA");
    staleEditor.type("stale-pattern.txt");
    staleEditor.press("Tab"); // allow → deny
    staleEditor.press("ArrowDown");
    staleEditor.type("stale guidance");
    staleEditor.press("CtrlN");
    staleEditor.type("stale-added.txt");

    // N+1 deliberately remains ASK for the immutable original operation.
    replaceConfig({
      configPath,
      config: profileWithOrdinaryPathRule({
        path: scenario.path,
        decision: "ask",
      }),
    });
    staleEditor.press("Enter");

    const refreshedPicker = await parent.ui.waitForPermissionChoice();
    refreshedPicker.choose(saveRulesChoice);
    const refreshedEditor = await parent.ui.waitForRuleForm();
    const refreshed = refreshedEditor.render().join("\n");
    expect(refreshed).toContain(scenario.path);
    expect(refreshed).not.toContain("stale-pattern.txt");
    expect(refreshed).not.toContain("stale guidance");
    expect(refreshed).not.toContain("stale-added.txt");
    refreshedEditor.press("Tab"); // deny the immutable original request
    refreshedEditor.press("Enter");

    const result = await pending;
    expect(result).toMatchObject({ block: true });
    expect(result?.reason).not.toContain("stale guidance");
    expect(
      loadRawProfileConfig({ configPath })?.profiles.current.readPaths,
    ).toEqual([
      { pattern: scenario.path, decision: "deny", contexts: ["read"] },
    ]);
  });

  it.each(durableDecisions)(
    "discards an ordinary-path pending durable editor after a newer %s revision",
    async (decision) => {
      const scenario = ordinaryPathScenario({
        path: `editor-path-${decision}.txt`,
      });
      const configPath = writeConfig({
        config: profileWithOrdinaryPathRule({
          path: scenario.path,
          decision: "ask",
        }),
      });
      process.env.PI_GUARD_PROFILE_CONFIG = configPath;
      const parent = createExtensionHarness({ interactiveUi: true });
      const writer = createExtensionHarness({ interactiveUi: true });
      await Promise.all([parent.start(), writer.start()]);

      const pending = parent.callTool(scenario);
      (await parent.ui.waitForPermissionChoice()).choose(saveRulesChoice);
      const staleEditor = await parent.ui.waitForRuleForm();
      await saveOrdinaryPathDecision({ harness: writer, scenario, decision });
      staleEditor.press("Enter");
      expectDecision({ result: await pending, decision });
      expect(parent.ui.custom).toHaveBeenCalledTimes(2);
      expect(
        loadRawProfileConfig({ configPath })?.profiles.current.readPaths,
      ).toEqual([{ pattern: scenario.path, decision, contexts: ["read"] }]);
    },
  );
});
