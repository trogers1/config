import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadRawProfileConfig } from "../modules/profileConfig";
import {
  metadataConfirmationTitle,
  profileAuthoringInvalidMarker,
  ruleSectionPresentation,
} from "../modules/profileAuthoringPresentation";
import { createExtensionHarness } from "./support/extensionHarness";
import {
  installProfileUpdateFixture,
  overviewSectionSelection,
  submitOverviewSelection,
  writeConfig,
} from "./support/profileUpdateTestSupport";

installProfileUpdateFixture({});

describe("profile updates through the public extension surface", () => {
  it("updates both command and path rules, then stops enforcing them after /profile-select switches", async () => {
    const bothPath = path.join(process.cwd(), "both.txt");
    const configPath = writeConfig({
      config: {
        defaultProfile: "both-work",
        profiles: {
          "both-work": {
            description: "Profile for exercising the combined ASK update flow.",
            extends: ["builtin:default"],
            tools: {
              bash: [{ pattern: "echo both > both.txt", decision: "ask" }],
            },
            readPaths: [{ pattern: bothPath, decision: "allow" }],
            writePaths: [{ pattern: bothPath, decision: "ask" }],
          },
          "unrestricted-work": {
            description:
              "Distinct profile without the remembered restrictions.",
            extends: ["builtin:default"],
            tools: {
              bash: [{ pattern: "echo both > both.txt", decision: "allow" }],
            },
            writePaths: [{ pattern: bothPath, decision: "allow" }],
          },
        },
      },
    });
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const harness = createExtensionHarness({ interactiveUi: true });
    await harness.start();

    const deniedPending = harness.callTool({
      toolName: "bash",
      input: { command: "echo both > both.txt" },
    });
    (await harness.ui.waitForPermissionChoice()).choose(
      "Save rule(s) to profile…",
    );
    const commandForm = await harness.ui.waitForRuleForm();
    const rendered = commandForm.render().join("\n");
    expect(rendered.indexOf(ruleSectionPresentation.write.label)).toBeLessThan(
      rendered.indexOf(ruleSectionPresentation.bash.label),
    );
    commandForm.press("CtrlArrowDown"); // path row → Bash row
    commandForm.press("Tab"); // allow → deny
    commandForm.press("CtrlK"); // inline persistent guidance
    commandForm.type("Use the approved project workflow.");
    commandForm.press("Enter");
    const denied = await deniedPending;
    expect(denied).toMatchObject({ block: true });
    expect(denied?.reason).toContain("Use the approved project workflow.");
    const persisted = loadRawProfileConfig({ configPath: configPath })
      ?.profiles["both-work"];
    expect(persisted?.tools?.bash).toContainEqual({
      pattern: "echo both > both.txt",
      decision: "deny",
      guidance: "Use the approved project workflow.",
    });
    expect(persisted?.writePaths).toContainEqual({
      pattern: "both.txt",
      decision: "allow",
      contexts: ["bash"],
    });
    expect(harness.ui.custom).toHaveBeenCalledTimes(2);

    const repeated = await harness.callTool({
      toolName: "bash",
      input: { command: "echo both > both.txt" },
    });
    expect(repeated).toMatchObject({ block: true });
    expect(repeated?.reason).toContain("Use the approved project workflow.");

    await harness.callToolWithoutPrompt({
      toolName: "read",
      input: { path: "both.txt" },
    });

    await harness.runCommand("profile-select", "unrestricted-work");
    await harness.callToolWithoutPrompt({
      toolName: "bash",
      input: { command: "echo both > both.txt" },
    });
    await harness.callToolWithoutPrompt({
      toolName: "write",
      input: { path: "both.txt", content: "now allowed" },
    });
  });

  it("edits every /profile-edit destination without flattening untouched local ASK declarations", async () => {
    const echoGuidance =
      "Prefer the safe echo.\n\nSuggested alternatives:\n- echo safe";
    const configPath = writeConfig({
      config: {
        defaultProfile: "edit-work",
        profiles: {
          "edit-work": {
            description: "Raw declaration preservation fixture.",
            extends: ["builtin:default"],
            tools: {
              bash: [
                {
                  pattern: "echo ask",
                  decision: "ask",
                  guidance: echoGuidance,
                },
              ],
              deploy: [{ decision: "deny", match: { target: "release" } }],
            },
            readPaths: [
              {
                pattern: "secret.txt",
                decision: "ask",
                guidance: "",
                contexts: ["read", "grep"],
              },
            ],
            writePaths: [
              { pattern: "output.txt", decision: "ask", contexts: ["write"] },
            ],
            protectedPathRules: [{ pattern: ".env", decision: "deny" }],
            sandbox: { network: "deny", extraWritePaths: ["/tmp/inherited"] },
            directoryGlobs: ["/workspace/old"],
          },
        },
      },
    });
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const harness = createExtensionHarness({
      interactiveUi: true,
      confirm: true,
    });
    await harness.start();

    const pending = harness.runCommand("profile-edit");
    for (const id of ["bash", "read", "write", "protected"] as const) {
      (await harness.ui.waitForProfileAuthoringOverview()).choose({
        selection: overviewSectionSelection({ id }),
      });
      // Save initialized editor rows rather than constructing a result that
      // lacks the editor's canonical clause identities.
      (await harness.ui.waitForRuleForm()).press("Enter");
    }
    (await harness.ui.waitForProfileAuthoringOverview()).choose({
      selection: overviewSectionSelection({ id: "sandbox" }),
    });
    const sandbox = await harness.ui.waitForRuleForm();
    sandbox.press("ArrowDown"); // Network
    sandbox.press("ArrowRight"); // deny → allow
    sandbox.press("ArrowDown");
    sandbox.press("ArrowDown");
    sandbox.press("ArrowDown");
    sandbox.press("ArrowDown"); // Extra write paths
    sandbox.press("Tab"); // append → overwrite
    sandbox.press("CtrlD"); // Remove the inherited local declaration.
    sandbox.press("CtrlN");
    sandbox.type("/tmp/local");
    sandbox.press("Enter");
    (await harness.ui.waitForProfileAuthoringOverview()).choose({
      selection: overviewSectionSelection({ id: "directoryGlobs" }),
    });
    const directories = await harness.ui.waitForRuleForm();
    directories.press("CtrlU");
    directories.type("/workspace/new");
    directories.press("Enter");
    (await harness.ui.waitForProfileAuthoringOverview()).choose({
      selection: submitOverviewSelection,
    });
    await pending;

    expect(
      loadRawProfileConfig({ configPath: configPath })?.profiles["edit-work"],
    ).toMatchObject({
      tools: {
        bash: [
          {
            pattern: "echo ask",
            decision: "ask",
            guidance: echoGuidance,
          },
        ],
        deploy: [{ decision: "deny", match: { target: "release" } }],
      },
      readPaths: [
        {
          pattern: "secret.txt",
          decision: "ask",
          guidance: "",
          contexts: ["read", "grep"],
        },
      ],
      writePaths: [
        { pattern: "output.txt", decision: "ask", contexts: ["write"] },
      ],
      protectedPathRules: [{ pattern: ".env", decision: "deny" }],
      sandbox: {
        network: "allow",
        extraWritePaths: ["/tmp/local"],
        overwritePathArrays: ["extraWritePaths"],
      },
      directoryGlobs: ["/workspace/new"],
    });
    expect(harness.ui.confirm).toHaveBeenCalledWith(
      metadataConfirmationTitle({ kind: "sandbox" }),
      expect.any(String),
      expect.anything(),
    );
  });

  it("keeps bytes and activation unchanged for a cancelled or empty /profile-edit, and rejects an external revision", async () => {
    const configPath = writeConfig({
      config: {
        defaultProfile: "edit-work",
        profiles: {
          "edit-work": {
            description: "Editable",
            extends: ["builtin:default"],
          },
        },
      },
    });
    const before = fs.readFileSync(configPath, "utf8");
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const noop = createExtensionHarness({
      customResults: [submitOverviewSelection],
    });
    await noop.start();
    const entries = [...noop.entries];
    await noop.runCommand("profile-edit");
    expect(fs.readFileSync(configPath, "utf8")).toBe(before);
    expect(noop.entries.slice(entries.length)).toHaveLength(1);
    expect(noop.entries.at(-1)).toMatchObject({
      data: { profile: "edit-work" },
    });

    const harness = createExtensionHarness({ interactiveUi: true });
    await harness.start();
    const pending = harness.runCommand("profile-edit");
    const overview = await harness.ui.waitForProfileAuthoringOverview();
    overview.choose({ selection: overviewSectionSelection({ id: "bash" }) });
    const editor = await harness.ui.waitForRuleForm();
    editor.press("CtrlN");
    editor.type("echo concurrent");
    editor.press("Enter");
    fs.writeFileSync(
      configPath,
      fs
        .readFileSync(configPath, "utf8")
        .replace("Editable", "Changed elsewhere"),
    );
    (await harness.ui.waitForProfileAuthoringOverview()).choose({
      selection: submitOverviewSelection,
    });
    const retriedOverview = await harness.ui.waitForProfileAuthoringOverview();
    expect(retriedOverview.render().join("\n")).not.toContain(
      profileAuthoringInvalidMarker,
    );
    harness.ui.sendTerminalInput({ data: "\x03" });
    await pending;
    expect(
      loadRawProfileConfig({ configPath: configPath })?.profiles["edit-work"]
        .description,
    ).toBe("Changed elsewhere");
    expect(harness.entries).toHaveLength(0);
  });
});
