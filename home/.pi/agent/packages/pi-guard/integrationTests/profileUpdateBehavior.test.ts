import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readPathContexts, type PathContext } from "../modules/policyHelpers";
import { loadRawProfileConfig } from "../modules/profileConfig";
import { askPermissionChoices } from "../modules/profileUpdate";
import { createExtensionHarness } from "./support/extensionHarness";

const originalConfigPath = process.env.PI_GUARD_PROFILE_CONFIG;
const [denyChoice, allowOnceChoice, saveRulesChoice] = askPermissionChoices;
const temporaryDirectories: string[] = [];

function writeConfig(config: object): string {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-guard-profile-update-"),
  );
  temporaryDirectories.push(directory);
  const configPath = path.join(directory, "profiles.jsonc");
  fs.writeFileSync(
    configPath,
    `// Behavioral profile-update fixture\n${JSON.stringify(config, null, 2)}\n`,
  );
  return configPath;
}

function restoreEnvironment(): void {
  if (originalConfigPath === undefined)
    delete process.env.PI_GUARD_PROFILE_CONFIG;
  else process.env.PI_GUARD_PROFILE_CONFIG = originalConfigPath;
}

afterEach(() => {
  restoreEnvironment();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("profile updates through the public extension surface", () => {
  it("drives the production custom permission picker through a durable save", async () => {
    const configPath = writeConfig({
      defaultProfile: "tui-work",
      profiles: {
        "tui-work": {
          description: "TUI permission picker fixture.",
          extends: ["builtin:default"],
          tools: { bash: [{ pattern: "echo tui-ask", decision: "ask" }] },
        },
      },
    });
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const harness = createExtensionHarness({
      interactiveUi: true,
      tuiMode: true,
    });
    await harness.start();

    const pending = harness.callTool({
      toolName: "bash",
      input: { command: "echo tui-ask" },
    });
    const picker = await harness.ui.waitForCustomModal();
    expect(picker.render().join("\n")).toContain(
      "⚙️ Bash command permission request",
    );
    picker.type(saveRulesChoice);
    picker.press("Enter");
    const editor = await harness.ui.waitForRuleForm();
    expect(editor.render().join("\n")).toContain("⚙️ BASH COMMAND");
    editor.press("Enter");
    expect(await pending).toBeUndefined();
    await harness.callToolWithoutPrompt({
      toolName: "bash",
      input: { command: "echo tui-ask" },
    });
  });

  it("omits durable save when a Bash request mixes concrete and dynamic path ASKs", async () => {
    const configPath = writeConfig({
      defaultProfile: "mixed-uncertainty",
      profiles: {
        "mixed-uncertainty": {
          description: "Concrete plus non-authorable ASK fixture.",
          extends: ["builtin:default"],
          tools: {
            bash: [
              { pattern: 'cat "$TARGET" > concrete.txt', decision: "ask" },
            ],
          },
          writePaths: [{ pattern: "concrete.txt", decision: "ask" }],
        },
      },
    });
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const harness = createExtensionHarness({ interactiveUi: true });
    await harness.start();

    const pending = harness.callTool({
      toolName: "bash",
      input: { command: 'cat "$TARGET" > concrete.txt' },
    });
    const permission = await harness.ui.waitForCustomModal();
    expect(permission.render().join("\n")).not.toContain(
      "Save rule(s) to profile…",
    );
    permission.type(allowOnceChoice);
    permission.press("Enter");
    expect(await pending).toBeUndefined();
  });

  it("persists Bash deny guidance and allow decisions, including exact repeats", async () => {
    const configPath = writeConfig({
      defaultProfile: "custom-work",
      profiles: {
        "custom-work": {
          description: "Custom profile whose Bash decisions can be updated.",
          extends: ["builtin:default"],
          tools: {
            bash: [
              { pattern: "echo remember-deny", decision: "ask" },
              { pattern: "echo remember-allow", decision: "ask" },
            ],
          },
        },
      },
    });
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const harness = createExtensionHarness({ interactiveUi: true });
    await harness.start();
    await harness.runCommand("profile", "custom-work");

    const deniedPending = harness.callTool({
      toolName: "bash",
      input: { command: "echo remember-deny" },
    });
    (await harness.ui.waitForPermissionChoice()).choose(
      "Save rule(s) to profile…",
    );
    const deniedForm = await harness.ui.waitForRuleForm();
    deniedForm.press("Tab"); // allow → deny
    deniedForm.press("ArrowDown");
    deniedForm.type("Use the documented workflow instead.");
    deniedForm.press("Enter");
    const denied = await deniedPending;
    expect(denied).toMatchObject({ block: true });
    expect(denied?.reason).toContain("Use the documented workflow instead.");

    const repeatedDeny = await harness.callToolDecisivelyWithoutPrompt({
      toolName: "bash",
      input: { command: "echo remember-deny" },
    });
    expect(repeatedDeny).toMatchObject({ block: true });
    expect(repeatedDeny?.reason).toContain(
      "Use the documented workflow instead.",
    );

    const allowedPending = harness.callTool({
      toolName: "bash",
      input: { command: "echo remember-allow" },
    });
    (await harness.ui.waitForPermissionChoice()).choose(
      "Save rule(s) to profile…",
    );
    const allowedForm = await harness.ui.waitForRuleForm();
    allowedForm.press("Enter");
    await allowedPending;
    await harness.callToolWithoutPrompt({
      toolName: "bash",
      input: { command: "echo remember-allow" },
    });
  });

  it("does not save an all-skipped ASK draft and discards only from the permission choice", async () => {
    const configPath = writeConfig({
      defaultProfile: "three-tabs-work",
      profiles: {
        "three-tabs-work": {
          description: "Profile for checking the ASK decision cycle.",
          extends: ["builtin:default"],
          tools: { bash: [{ pattern: "echo cycle-me", decision: "ask" }] },
        },
      },
    });
    const before = fs.readFileSync(configPath, "utf8");
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const harness = createExtensionHarness({ interactiveUi: true });
    await harness.start();
    await harness.runCommand("profile", "three-tabs-work");

    const request = harness.callTool({
      toolName: "bash",
      input: { command: "echo cycle-me" },
    });
    (await harness.ui.waitForPermissionChoice()).choose(
      "Save rule(s) to profile…",
    );
    const form = await harness.ui.waitForRuleForm();
    form.press("Tab"); // allow → deny
    form.press("Tab"); // deny → skip
    expect(form.render().join("\n")).toContain(
      "Save disabled: every row is skipped",
    );
    form.press("Escape"); // Back retains the draft and reopens the choice.
    (await harness.ui.waitForPermissionChoice()).choose(denyChoice);

    expect(await request).toMatchObject({ block: true });
    expect(fs.readFileSync(configPath, "utf8")).toBe(before);
  });

  it("adds a labelled related rule with changed kind/context in the atomic ASK batch", async () => {
    const configPath = writeConfig({
      defaultProfile: "related-work",
      profiles: {
        "related-work": {
          description: "Additional ASK row fixture.",
          extends: ["builtin:default"],
          tools: { bash: [{ pattern: "echo primary", decision: "ask" }] },
        },
      },
    });
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const harness = createExtensionHarness({ interactiveUi: true });
    await harness.start();

    const pending = harness.callTool({
      toolName: "bash",
      input: { command: "echo primary" },
    });
    (await harness.ui.waitForPermissionChoice()).choose(
      "Save rule(s) to profile…",
    );
    const editor = await harness.ui.waitForRuleForm();
    editor.press("CtrlN");
    editor.press("CtrlK"); // Bash → read path
    editor.press("CtrlX"); // all read contexts → read
    editor.press("CtrlX"); // read → grep
    editor.type("related.txt");
    expect(editor.render().join("\n")).toContain(
      "Additional profile rule (not required by this ASK)",
    );
    editor.press("ArrowDown");
    editor.type("Use the related workflow.");
    editor.press("Escape");
    (await harness.ui.waitForPermissionChoice()).choose(
      "Save rule(s) to profile…",
    );
    const reopened = await harness.ui.waitForRuleForm();
    const restored = reopened.render().join("\n");
    expect(restored).toContain(
      "Additional profile rule (not required by this ASK)",
    );
    expect(restored).toContain("elated.txt");
    expect(restored).toContain("Context          grep");
    expect(restored).toContain("se the related workflow.");
    expect(restored).toContain("ASK → ⛔️ DENY");
    reopened.press("Enter");
    await pending;

    const profile = loadRawProfileConfig(configPath)?.profiles["related-work"];
    expect(profile?.tools?.bash).toContainEqual({
      pattern: "echo primary",
      decision: "allow",
    });
    expect(profile?.readPaths).toContainEqual({
      pattern: "related.txt",
      decision: "deny",
      contexts: ["grep"],
      guidance: "Use the related workflow.",
    });
    const enforcement = createExtensionHarness({ hasUI: false });
    await enforcement.start();
    expect(
      await enforcement.callTool({
        toolName: "grep",
        input: { path: "related.txt", pattern: "needle" },
      }),
    ).toMatchObject({ block: true });
    expect(
      await enforcement.callTool({
        toolName: "read",
        input: { path: "related.txt" },
      }),
    ).toBeUndefined();
  });

  it("retains only a skipped direct-path draft after an additional-rule save", async () => {
    const configPath = writeConfig({
      defaultProfile: "direct-partial-work",
      profiles: {
        "direct-partial-work": {
          description: "Direct partial-save fixture.",
          extends: ["builtin:default"],
          readPaths: [
            { pattern: "requested.txt", decision: "ask", contexts: ["read"] },
          ],
        },
      },
    });
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const harness = createExtensionHarness({ interactiveUi: true });
    await harness.start();

    const pending = harness.callTool({
      toolName: "read",
      input: { path: "requested.txt" },
    });
    (await harness.ui.waitForPermissionChoice()).choose(
      "Save rule(s) to profile…",
    );
    const editor = await harness.ui.waitForRuleForm();
    for (let index = 0; index < 40; index++) editor.press("ArrowRight");
    editor.type(" retained");
    editor.press("Tab"); // allow → deny
    editor.press("ArrowDown");
    editor.type("Retain this request guidance.");
    editor.press("ArrowUp");
    editor.press("Tab"); // deny → skip
    editor.press("CtrlN");
    editor.type("saved-related.txt");
    editor.press("Enter");

    (await harness.ui.waitForPermissionChoice()).choose(
      "Save rule(s) to profile…",
    );
    const unresolved = await harness.ui.waitForRuleForm();
    const rendered = unresolved.render().join("\n");
    expect(rendered).toContain("retained");
    expect(rendered).not.toContain("saved-related.txt");
    expect(rendered).toContain("unchanged; remains ASK");
    unresolved.press("Tab"); // skip → allow
    unresolved.press("Tab"); // allow → deny
    expect(unresolved.render().join("\n")).toContain(
      "etain this request guidance.",
    );
    unresolved.press("Escape");
    (await harness.ui.waitForPermissionChoice()).choose("No (default)");

    expect(await pending).toMatchObject({ block: true });
    expect(
      loadRawProfileConfig(configPath)?.profiles["direct-partial-work"]
        .readPaths,
    ).toContainEqual({
      pattern: "saved-related.txt",
      decision: "deny",
      contexts: ["read"],
    });
  });

  it("re-prompts with only skipped Bash candidates and retains their edits", async () => {
    const configPath = writeConfig({
      defaultProfile: "partial-work",
      profiles: {
        "partial-work": {
          description: "Partial ASK save fixture.",
          extends: ["builtin:default"],
          tools: {
            bash: [
              { pattern: "echo first", decision: "ask" },
              { pattern: "echo second", decision: "ask" },
            ],
          },
        },
      },
    });
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const harness = createExtensionHarness({ interactiveUi: true });
    await harness.start();

    const pending = harness.callTool({
      toolName: "bash",
      input: { command: "echo first && echo second" },
    });
    (await harness.ui.waitForPermissionChoice()).choose(
      "Save rule(s) to profile…",
    );
    const firstEditor = await harness.ui.waitForRuleForm();
    firstEditor.press("ArrowDown");
    for (let index = 0; index < 40; index++) firstEditor.press("ArrowRight");
    firstEditor.type(" edited");
    firstEditor.press("Tab"); // allow → deny
    firstEditor.press("Tab"); // deny → skip
    firstEditor.press("Enter"); // save only echo first

    (await harness.ui.waitForPermissionChoice()).choose(
      "Save rule(s) to profile…",
    );
    const unresolvedEditor = await harness.ui.waitForRuleForm();
    const unresolved = unresolvedEditor.render().join("\n");
    expect(unresolved).toContain("second edited");
    expect(unresolved).not.toContain("echo first");
    unresolvedEditor.press("Escape");
    (await harness.ui.waitForPermissionChoice()).choose(
      "Save rule(s) to profile…",
    );
    const reopened = await harness.ui.waitForRuleForm();
    expect(reopened.render().join("\n")).toContain("second edited");
    reopened.press("Escape");
    (await harness.ui.waitForPermissionChoice()).choose("No (default)");

    expect(await pending).toMatchObject({ block: true });
    expect(
      loadRawProfileConfig(configPath)?.profiles["partial-work"].tools?.bash,
    ).toContainEqual({ pattern: "echo first", decision: "allow" });
  });

  it("resets an interactive profile update to exact allow defaults before saving", async () => {
    const configPath = writeConfig({
      defaultProfile: "reset-work",
      profiles: {
        "reset-work": {
          description: "Profile for exercising the interactive reset flow.",
          extends: ["builtin:default"],
          tools: {
            bash: [{ pattern: "echo reset-me", decision: "ask" }],
          },
        },
      },
    });
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const harness = createExtensionHarness({ interactiveUi: true });
    await harness.start();
    await harness.runCommand("profile", "reset-work");

    const pending = harness.callTool({
      toolName: "bash",
      input: { command: "echo reset-me" },
    });
    (await harness.ui.waitForPermissionChoice()).choose(
      "Save rule(s) to profile…",
    );
    const form = await harness.ui.waitForRuleForm();
    form.type(" changed");
    form.press("Tab");
    form.press("ArrowDown");
    form.type("Do not save this guidance.");
    form.press("CtrlShiftR");
    form.press("Enter");

    const resetResult = await pending;
    expect(resetResult).toBeUndefined();

    // Reset restores the request-derived exact pattern and default allow, so
    // the exact retry is prompt-free after persistence and re-evaluation.
    await harness.callToolWithoutPrompt({
      toolName: "bash",
      input: { command: "echo reset-me" },
    });
  });

  it("persists a direct read ASK to readPaths with immutable request semantics", async () => {
    const configPath = writeConfig({
      defaultProfile: "read-work",
      profiles: {
        "read-work": {
          description: "Read context fixture.",
          extends: ["builtin:default"],
          readPaths: [
            { pattern: "private.txt", decision: "ask", contexts: ["read"] },
          ],
        },
      },
    });
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const harness = createExtensionHarness({ interactiveUi: true });
    await harness.start();

    const pending = harness.callTool({
      toolName: "read",
      input: { path: "private.txt" },
    });
    (await harness.ui.waitForPermissionChoice()).choose(
      "Save rule(s) to profile…",
    );
    const form = await harness.ui.waitForRuleForm();
    const rendered = form.render().join("\n");
    expect(rendered).toContain("📖 READ PATH");
    expect(rendered).toContain("Requested value");
    expect(rendered).toContain("Context/source   read");
    expect(rendered).toContain("profiles.read-work.readPaths");
    expect(rendered).toContain("writes are unaffected");
    form.press("Enter");
    await pending;

    expect(
      loadRawProfileConfig(configPath)?.profiles["read-work"].readPaths,
    ).toContainEqual({
      pattern: "private.txt",
      decision: "allow",
      contexts: ["read"],
    });
    await harness.callToolWithoutPrompt({
      toolName: "read",
      input: { path: "private.txt" },
    });
  });

  it("replaces the exact persisted absolute ASK identity when the display pattern is relative", async () => {
    const requestedPath = path.join(process.cwd(), "absolute-identity.txt");
    const configPath = writeConfig({
      defaultProfile: "absolute-identity-work",
      profiles: {
        "absolute-identity-work": {
          description: "Absolute persisted ASK identity fixture.",
          extends: ["builtin:default"],
          readPaths: [
            {
              pattern: requestedPath,
              decision: "ask",
              contexts: ["read"],
            },
          ],
        },
      },
    });
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const harness = createExtensionHarness({ interactiveUi: true });
    await harness.start();

    const pending = harness.callTool({
      toolName: "read",
      input: { path: "absolute-identity.txt" },
    });
    (await harness.ui.waitForPermissionChoice()).choose(
      "Save rule(s) to profile…",
    );
    const editor = await harness.ui.waitForRuleForm();
    expect(editor.render(300).join("\n")).toContain(requestedPath);
    editor.press("Enter");
    expect(await pending).toBeUndefined();

    expect(
      loadRawProfileConfig(configPath)?.profiles["absolute-identity-work"]
        .readPaths,
    ).toEqual([
      {
        pattern: "absolute-identity.txt",
        decision: "allow",
        contexts: ["read"],
      },
    ]);
    await harness.callToolWithoutPrompt({
      toolName: "read",
      input: { path: "absolute-identity.txt" },
    });
  });

  it("persists an edited broader path pattern with matching preview semantics", async () => {
    const configPath = writeConfig({
      defaultProfile: "broaden-work",
      profiles: {
        "broaden-work": {
          description: "Broader pattern fixture.",
          extends: ["builtin:default"],
          writePaths: [
            { pattern: "generated/a.ts", decision: "ask", contexts: ["write"] },
            { pattern: "outside.ts", decision: "deny", contexts: ["write"] },
          ],
        },
      },
    });
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const harness = createExtensionHarness({ interactiveUi: true });
    await harness.start();

    const pending = harness.callTool({
      toolName: "write",
      input: { path: "generated/a.ts", content: "a" },
    });
    (await harness.ui.waitForPermissionChoice()).choose(
      "Save rule(s) to profile…",
    );
    const form = await harness.ui.waitForRuleForm();
    for (let index = 0; index < 40; index++) form.press("ArrowRight");
    for (let index = 0; index < 40; index++) form.press("Backspace");
    form.type("generated/**");
    const rendered = form.render().join("\n");
    expect(rendered).toContain("Requested value");
    expect(rendered).toContain("generated/a.ts");
    expect(rendered).toContain("profiles.broaden-work.writePaths");
    expect(rendered).toMatch(/broader|custom/i);
    form.press("Enter");
    await pending;

    expect(
      await harness.callToolWithoutPrompt({
        toolName: "write",
        input: { path: "generated/b.ts", content: "b" },
      }),
    ).toBeUndefined();
    expect(
      await harness.callTool({
        toolName: "write",
        input: { path: "outside.ts", content: "outside" },
      }),
    ).toMatchObject({ block: true });
  });

  it.each([
    ["read", "grep"],
    ["grep", "find"],
    ["find", "ls"],
    ["ls", "read"],
    ["edit", "write"],
    ["write", "edit"],
  ] satisfies readonly (readonly [PathContext, PathContext])[])(
    "persists direct %s context without granting sibling %s context",
    async (toolName, siblingTool) => {
      const isRead = readPathContexts.some((context) => context === toolName);
      const requestedPath = `context-${toolName}.txt`;
      const configPath = writeConfig({
        defaultProfile: "context-work",
        profiles: {
          "context-work": {
            description: "Direct context scoping fixture.",
            extends: ["builtin:default"],
            [isRead ? "readPaths" : "writePaths"]: [
              {
                pattern: requestedPath,
                decision: "ask",
                contexts: [toolName, siblingTool],
              },
            ],
          },
        },
      });
      process.env.PI_GUARD_PROFILE_CONFIG = configPath;
      const harness = createExtensionHarness({ interactiveUi: true });
      await harness.start();
      const inputFor = (tool: string): Record<string, unknown> => {
        switch (tool) {
          case "grep":
            return { path: requestedPath, pattern: "needle" };
          case "edit":
            return { path: requestedPath, edits: [] };
          case "write":
            return { path: requestedPath, content: "context test" };
          default:
            return { path: requestedPath };
        }
      };

      const pending = harness.callTool({
        toolName,
        input: inputFor(toolName),
      });
      (await harness.ui.waitForPermissionChoice()).choose(
        "Save rule(s) to profile…",
      );
      const form = await harness.ui.waitForRuleForm();
      expect(form.render().join("\n")).toContain(
        `${toolName} · ${toolName} tool`,
      );
      form.press("Enter");
      await pending;

      const profile =
        loadRawProfileConfig(configPath)?.profiles["context-work"];
      const collection = isRead ? profile?.readPaths : profile?.writePaths;
      expect(collection).toContainEqual({
        pattern: requestedPath,
        decision: "allow",
        contexts: [toolName],
      });
      const siblingHarness = createExtensionHarness({ hasUI: false });
      await siblingHarness.start();
      expect(
        await siblingHarness.callTool({
          toolName: siblingTool,
          input: inputFor(siblingTool),
        }),
      ).toMatchObject({ block: true });
    },
  );

  it("persists cd as readPaths context ls without granting read context", async () => {
    const configPath = writeConfig({
      defaultProfile: "cd-work",
      profiles: {
        "cd-work": {
          description: "cd context fixture.",
          extends: ["builtin:default"],
          tools: { bash: [{ pattern: "cd context-dir", decision: "allow" }] },
          readPaths: [
            {
              pattern: "context-dir",
              decision: "ask",
              contexts: ["ls", "read"],
            },
          ],
        },
      },
    });
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const harness = createExtensionHarness({ interactiveUi: true });
    await harness.start();

    const pending = harness.callTool({
      toolName: "bash",
      input: { command: "cd context-dir" },
    });
    (await harness.ui.waitForPermissionChoice()).choose(
      "Save rule(s) to profile…",
    );
    const form = await harness.ui.waitForRuleForm();
    const rendered = form.render().join("\n");
    expect(rendered).toContain("READ PATH");
    expect(rendered).toContain("ls · bash (ls path reference)");
    form.press("Enter");
    await pending;

    expect(
      loadRawProfileConfig(configPath)?.profiles["cd-work"].readPaths,
    ).toContainEqual({
      pattern: "context-dir",
      decision: "allow",
      contexts: ["ls"],
    });
    const siblingHarness = createExtensionHarness({ hasUI: false });
    await siblingHarness.start();
    expect(
      await siblingHarness.callTool({
        toolName: "read",
        input: { path: "context-dir" },
      }),
    ).toMatchObject({ block: true });
  });

  it("persists ordinary write-path deny and allow decisions through ASK flows", async () => {
    const configPath = writeConfig({
      defaultProfile: "path-work",
      profiles: {
        "path-work": {
          description: "Custom profile whose protected paths can be updated.",
          extends: ["builtin:default"],
          writePaths: [
            { pattern: "remember-deny.txt", decision: "ask" },
            { pattern: "remember-allow.txt", decision: "ask" },
          ],
        },
      },
    });
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const harness = createExtensionHarness({ interactiveUi: true });
    await harness.start();
    await harness.runCommand("profile", "path-work");

    const deniedPending = harness.callTool({
      toolName: "write",
      input: { path: "remember-deny.txt", content: "no" },
    });
    (await harness.ui.waitForPermissionChoice()).choose(
      "Save rule(s) to profile…",
    );
    const deniedForm = await harness.ui.waitForRuleForm();
    deniedForm.press("Tab"); // allow → deny
    deniedForm.press("Enter");
    const denied = await deniedPending;
    expect(denied).toMatchObject({ block: true });
    const repeatedDeny = await harness.callToolDecisivelyWithoutPrompt({
      toolName: "write",
      input: { path: "remember-deny.txt", content: "no" },
    });
    expect(repeatedDeny).toMatchObject({ block: true });

    const allowedPending = harness.callTool({
      toolName: "write",
      input: { path: "remember-allow.txt", content: "yes" },
    });
    (await harness.ui.waitForPermissionChoice()).choose(
      "Save rule(s) to profile…",
    );
    const allowedForm = await harness.ui.waitForRuleForm();
    allowedForm.press("Enter");
    await allowedPending;
    await harness.callToolWithoutPrompt({
      toolName: "write",
      input: { path: "remember-allow.txt", content: "yes" },
    });
  });

  it("keeps direct read saves scoped while the write layer remains governed", async () => {
    const configPath = writeConfig({
      defaultProfile: "read-write-boundary",
      profiles: {
        "read-write-boundary": {
          description: "Separate direct read and write decisions.",
          extends: ["builtin:default"],
          readPaths: [
            { pattern: "boundary.txt", decision: "ask", contexts: ["read"] },
          ],
          writePaths: [
            { pattern: "boundary.txt", decision: "ask", contexts: ["write"] },
          ],
        },
      },
    });
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const harness = createExtensionHarness({ interactiveUi: true });
    await harness.start();

    const read = harness.callTool({
      toolName: "read",
      input: { path: "boundary.txt" },
    });
    (await harness.ui.waitForPermissionChoice()).choose(
      "Save rule(s) to profile…",
    );
    const readForm = await harness.ui.waitForRuleForm();
    expect(readForm.render().join("\n")).toContain("writes are unaffected");
    readForm.press("Enter");
    await read;

    expect(
      loadRawProfileConfig(configPath)?.profiles["read-write-boundary"]
        .readPaths,
    ).toContainEqual({
      pattern: "boundary.txt",
      decision: "allow",
      contexts: ["read"],
    });
    const write = harness.callTool({
      toolName: "write",
      input: { path: "boundary.txt", content: "x" },
    });
    const writePicker = await harness.ui.waitForPermissionChoice();
    expect(writePicker.render().join("\n")).toContain("permission request");
    writePicker.choose("No (default)");
    expect(await write).toMatchObject({ block: true });
  });

  it("persists direct write denial guidance without changing read enforcement", async () => {
    const configPath = writeConfig({
      defaultProfile: "write-read-boundary",
      profiles: {
        "write-read-boundary": {
          description: "Separate direct write and read decisions.",
          extends: ["builtin:default"],
          readPaths: [
            { pattern: "boundary.txt", decision: "ask", contexts: ["read"] },
          ],
          writePaths: [
            { pattern: "boundary.txt", decision: "ask", contexts: ["write"] },
          ],
        },
      },
    });
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const harness = createExtensionHarness({ interactiveUi: true });
    await harness.start();

    const write = harness.callTool({
      toolName: "write",
      input: { path: "boundary.txt", content: "x" },
    });
    (await harness.ui.waitForPermissionChoice()).choose(
      "Save rule(s) to profile…",
    );
    const form = await harness.ui.waitForRuleForm();
    form.press("Tab");
    form.press("ArrowDown");
    form.type("Writes require the approved workflow.");
    form.press("Enter");
    expect(await write).toMatchObject({ block: true });
    expect(
      await harness.callToolDecisivelyWithoutPrompt({
        toolName: "write",
        input: { path: "boundary.txt", content: "x" },
      }),
    ).toMatchObject({ block: true });

    const read = harness.callTool({
      toolName: "read",
      input: { path: "boundary.txt" },
    });
    const readPicker = await harness.ui.waitForPermissionChoice();
    expect(readPicker.render().join("\n")).toContain("permission request");
    readPicker.choose("No (default)");
    expect(await read).toMatchObject({ block: true });
    expect(
      loadRawProfileConfig(configPath)?.profiles["write-read-boundary"]
        .writePaths,
    ).toContainEqual({
      pattern: "boundary.txt",
      decision: "deny",
      contexts: ["write"],
      guidance: "Writes require the approved workflow.",
    });
  });

  it("presents three Bash candidates in encounter order and re-prompts only skipped rows", async () => {
    const configPath = writeConfig({
      defaultProfile: "three-candidates",
      profiles: {
        "three-candidates": {
          description: "Three authorable Bash candidates.",
          extends: ["builtin:default"],
          tools: {
            bash: [
              { pattern: "echo first", decision: "ask" },
              { pattern: "echo second", decision: "ask" },
              { pattern: "echo third", decision: "ask" },
            ],
          },
        },
      },
    });
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const harness = createExtensionHarness({ interactiveUi: true });
    await harness.start();
    const pending = harness.callTool({
      toolName: "bash",
      input: { command: "echo first && echo second && echo third" },
    });
    (await harness.ui.waitForPermissionChoice()).choose(
      "Save rule(s) to profile…",
    );
    const form = await harness.ui.waitForRuleForm();
    const rendered = form.render().join("\n");
    expect(rendered.indexOf("echo first")).toBeLessThan(
      rendered.indexOf("echo second"),
    );
    expect(rendered.indexOf("echo second")).toBeLessThan(
      rendered.indexOf("echo third"),
    );
    // Keep first and third as allow; skip only the second.
    form.press("ArrowDown");
    form.press("Tab");
    form.press("Tab");
    form.press("Enter");
    (await harness.ui.waitForPermissionChoice()).choose(
      "Save rule(s) to profile…",
    );
    const skipped = await harness.ui.waitForRuleForm();
    const retry = skipped.render().join("\n");
    expect(retry).toContain("echo second");
    expect(retry).not.toContain("echo first");
    expect(retry).not.toContain("echo third");
    skipped.press("Escape");
    (await harness.ui.waitForPermissionChoice()).choose("No (default)");
    expect(await pending).toMatchObject({ block: true });
    expect(
      loadRawProfileConfig(configPath)?.profiles["three-candidates"].tools
        ?.bash,
    ).toEqual(
      expect.arrayContaining([
        { pattern: "echo first", decision: "allow" },
        { pattern: "echo third", decision: "allow" },
      ]),
    );
  });

  it("keeps distinct Bash path contexts while deduplicating repeated path candidates", async () => {
    const configPath = writeConfig({
      defaultProfile: "dedupe-contexts",
      profiles: {
        "dedupe-contexts": {
          description: "Repeated path references with distinct contexts.",
          extends: ["builtin:default"],
          tools: {
            bash: [
              {
                pattern: "cat same.txt same.txt; cd same.txt",
                decision: "allow",
              },
            ],
          },
          readPaths: [
            { pattern: "same.txt", decision: "ask", contexts: ["ls"] },
          ],
          writePaths: [
            { pattern: "same.txt", decision: "ask", contexts: ["bash"] },
          ],
        },
      },
    });
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const harness = createExtensionHarness({ interactiveUi: true });
    await harness.start();
    const pending = harness.callTool({
      toolName: "bash",
      input: { command: "cat same.txt same.txt; cd same.txt" },
    });
    (await harness.ui.waitForPermissionChoice()).choose(
      "Save rule(s) to profile…",
    );
    const form = await harness.ui.waitForRuleForm();
    const rendered = form.render().join("\n");
    expect(rendered.match(/Requested value/g)?.length, rendered).toBe(2);
    expect(rendered).toContain("Context/source   ls");
    expect(rendered).toContain("Context/source   bash");
    form.press("Escape");
    (await harness.ui.waitForPermissionChoice()).choose("No (default)");
    expect(await pending).toMatchObject({ block: true });
  });

  it("allows a parent glob and denies only an additional narrower child", async () => {
    const configPath = writeConfig({
      defaultProfile: "glob-child",
      profiles: {
        "glob-child": {
          description: "Parent and child glob fixture.",
          extends: ["builtin:default"],
          writePaths: [
            {
              pattern: "generated/a.txt",
              decision: "ask",
              contexts: ["write"],
            },
          ],
        },
      },
    });
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const harness = createExtensionHarness({ interactiveUi: true });
    await harness.start();
    const pending = harness.callTool({
      toolName: "write",
      input: { path: "generated/a.txt", content: "a" },
    });
    (await harness.ui.waitForPermissionChoice()).choose(
      "Save rule(s) to profile…",
    );
    const form = await harness.ui.waitForRuleForm();
    expect(form.render().join("\n")).toContain(
      "PATH GLOB/PATTERN — interpreted as a glob, not a literal path",
    );
    for (let index = 0; index < 40; index++) form.press("ArrowRight");
    for (let index = 0; index < 40; index++) form.press("Backspace");
    form.type("generated/**");
    form.press("CtrlN");
    form.type("generated/private/**");
    form.press("Enter");
    await pending;

    await harness.callToolWithoutPrompt({
      toolName: "write",
      input: { path: "generated/sibling.txt", content: "ok" },
    });
    expect(
      await harness.callTool({
        toolName: "write",
        input: { path: "generated/private/secret.txt", content: "no" },
      }),
    ).toMatchObject({ block: true });
    expect(
      loadRawProfileConfig(configPath)?.profiles["glob-child"].writePaths,
    ).toEqual(
      expect.arrayContaining([
        { pattern: "generated/**", decision: "allow", contexts: ["write"] },
        {
          pattern: "generated/private/**",
          decision: "deny",
          contexts: ["write"],
        },
      ]),
    );
  });

  it("leaves the config and active shipped profile unchanged after a cancelled invalid child target", async () => {
    const configPath = writeConfig({
      defaultProfile: "builtin:default",
      profiles: {
        "default-custom": {
          description: "Collision",
          extends: ["builtin:default"],
        },
      },
    });
    const before = fs.readFileSync(configPath, "utf8");
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const harness = createExtensionHarness({ interactiveUi: true });
    await harness.start();
    const pending = harness.callTool({
      toolName: "bash",
      input: { command: "echo child-target > package.json" },
    });
    (await harness.ui.waitForPermissionChoice()).choose(
      "Save rule(s) to profile…",
    );
    const form = await harness.ui.waitForRuleForm();
    expect(form.render().join("\n")).toContain("Target");
    for (let index = 0; index < 40; index++) form.press("ArrowRight");
    for (let index = 0; index < 40; index++) form.press("Backspace");
    form.type("default-custom");
    form.press("Enter");
    const retryForm = await harness.ui.waitForRuleForm();
    expect(harness.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("already exists"),
      "error",
    );
    expect(retryForm.render().join("\n")).toContain("default-custom");
    retryForm.press("Escape");
    (await harness.ui.waitForPermissionChoice()).choose("No (default)");
    expect(await pending).toMatchObject({ block: true });
    expect(fs.readFileSync(configPath, "utf8")).toBe(before);
    expect(harness.entries).toHaveLength(0);
    const retry = harness.callTool({
      toolName: "bash",
      input: { command: "echo child-target > package.json" },
    });
    const retryPicker = await harness.ui.waitForPermissionChoice();
    expect(retryPicker.render().join("\n")).toContain("permission request");
    retryPicker.choose("No (default)");
    expect(await retry).toMatchObject({ block: true });
  });

  it("saves combined Bash and ordinary path allows and continues after re-evaluation", async () => {
    const configPath = writeConfig({
      defaultProfile: "combined-allow-work",
      profiles: {
        "combined-allow-work": {
          description: "Combined allow and recheck fixture.",
          extends: ["builtin:default"],
          tools: {
            bash: [
              { pattern: "echo combined > combined.txt", decision: "ask" },
            ],
          },
          writePaths: [
            { pattern: "combined.txt", decision: "ask", contexts: ["bash"] },
          ],
        },
      },
    });
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const harness = createExtensionHarness({ interactiveUi: true });
    await harness.start();

    const pending = harness.callTool({
      toolName: "bash",
      input: { command: "echo combined > combined.txt" },
    });
    (await harness.ui.waitForPermissionChoice()).choose(
      "Save rule(s) to profile…",
    );
    const editor = await harness.ui.waitForRuleForm();
    expect(editor.render().join("\n")).toMatch(
      /✏️ WRITE PATH[\s\S]*⚙️ BASH COMMAND/,
    );
    editor.press("Enter");
    expect(await pending).toBeUndefined();

    await harness.callToolWithoutPrompt({
      toolName: "bash",
      input: { command: "echo combined > combined.txt" },
    });
    const profile =
      loadRawProfileConfig(configPath)?.profiles["combined-allow-work"];
    expect(profile?.tools?.bash).toContainEqual({
      pattern: "echo combined > combined.txt",
      decision: "allow",
    });
    expect(profile?.writePaths).toContainEqual({
      pattern: "combined.txt",
      decision: "allow",
      contexts: ["bash"],
    });
  });

  it("updates both command and path rules, then stops enforcing them after /profile switches", async () => {
    const bothPath = path.join(process.cwd(), "both.txt");
    const configPath = writeConfig({
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
          description: "Distinct profile without the remembered restrictions.",
          extends: ["builtin:default"],
          tools: {
            bash: [{ pattern: "echo both > both.txt", decision: "allow" }],
          },
          writePaths: [{ pattern: bothPath, decision: "allow" }],
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
    expect(commandForm.render().join("\n")).toMatch(
      /✏️ WRITE PATH[\s\S]*⚙️ BASH COMMAND/,
    );
    commandForm.press("ArrowDown"); // path row → Bash row
    commandForm.press("Tab"); // allow → deny
    commandForm.press("ArrowDown"); // inline persistent guidance
    commandForm.type("Use the approved project workflow.");
    commandForm.press("Enter");
    const denied = await deniedPending;
    expect(denied).toMatchObject({ block: true });
    expect(denied?.reason).toContain("Use the approved project workflow.");
    const persisted = loadRawProfileConfig(configPath)?.profiles["both-work"];
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

    await harness.runCommand("profile", "unrestricted-work");
    await harness.callToolWithoutPrompt({
      toolName: "bash",
      input: { command: "echo both > both.txt" },
    });
    await harness.callToolWithoutPrompt({
      toolName: "write",
      input: { path: "both.txt", content: "now allowed" },
    });
  });
});
