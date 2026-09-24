import path from "node:path";
import { describe, expect, it } from "vitest";
import { readPathContexts, type PathContext } from "../modules/policyHelpers";
import { loadRawProfileConfig } from "../modules/profileConfig";
import { ruleSectionPresentation } from "../modules/profileAuthoringPresentation";
import { createExtensionHarness } from "./support/extensionHarness";
import {
  installProfileUpdateFixture,
  writeConfig,
} from "./support/profileUpdateTestSupport";

installProfileUpdateFixture({});

describe("profile updates through the public extension surface", () => {
  it("persists a direct read ASK to readPaths with immutable request semantics", async () => {
    const configPath = writeConfig({
      config: {
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
    expect(rendered).toContain(ruleSectionPresentation.read.label);
    expect(rendered).toContain("Requested value");
    expect(rendered).toContain("Context/source   read");
    expect(rendered).toContain("Writes to        profile readPaths");
    expect(rendered).toContain("writes are unaffected");
    form.press("Enter");
    await pending;

    expect(
      loadRawProfileConfig({ configPath: configPath })?.profiles["read-work"]
        .readPaths,
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
      config: {
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
      loadRawProfileConfig({ configPath: configPath })?.profiles[
        "absolute-identity-work"
      ].readPaths,
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
      config: {
        defaultProfile: "broaden-work",
        profiles: {
          "broaden-work": {
            description: "Broader pattern fixture.",
            extends: ["builtin:default"],
            writePaths: [
              {
                pattern: "generated/a.ts",
                decision: "ask",
                contexts: ["write"],
              },
              { pattern: "outside.ts", decision: "deny", contexts: ["write"] },
            ],
          },
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
    expect(rendered).toContain("Writes to        profile writePaths");
    expect(rendered).toMatch(/broader|custom/i);
    form.press("Enter");
    await pending;

    // Mutated candidates append after retained declarations. This persisted
    // order is security-significant for ties, while the sibling DENY remains
    // a distinct durable rule and matches preview.
    expect(
      loadRawProfileConfig({ configPath: configPath })?.profiles["broaden-work"]
        .writePaths,
    ).toEqual([
      { pattern: "outside.ts", decision: "deny", contexts: ["write"] },
      { pattern: "generated/**", decision: "allow", contexts: ["write"] },
    ]);

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
        config: {
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

      const profile = loadRawProfileConfig({ configPath: configPath })
        ?.profiles["context-work"];
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
      config: {
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
    expect(rendered).toContain(ruleSectionPresentation.read.label);
    expect(rendered).toContain("ls · bash (ls path reference)");
    form.press("Enter");
    await pending;

    expect(
      loadRawProfileConfig({ configPath: configPath })?.profiles["cd-work"]
        .readPaths,
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
      config: {
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
  }, 10_000);

  it("keeps direct read saves scoped while the write layer remains governed", async () => {
    const configPath = writeConfig({
      config: {
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
      loadRawProfileConfig({ configPath: configPath })?.profiles[
        "read-write-boundary"
      ].readPaths,
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
      config: {
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
      loadRawProfileConfig({ configPath: configPath })?.profiles[
        "write-read-boundary"
      ].writePaths,
    ).toContainEqual({
      pattern: "boundary.txt",
      decision: "deny",
      contexts: ["write"],
      guidance: "Writes require the approved workflow.",
    });
  });

  it("presents three Bash candidates in encounter order and re-prompts only skipped rows", async () => {
    const configPath = writeConfig({
      config: {
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
      loadRawProfileConfig({ configPath: configPath })?.profiles[
        "three-candidates"
      ].tools?.bash,
    ).toEqual(
      expect.arrayContaining([
        { pattern: "echo first", decision: "allow" },
        { pattern: "echo third", decision: "allow" },
      ]),
    );
  });

  it("keeps distinct Bash path contexts while deduplicating repeated path candidates", async () => {
    const configPath = writeConfig({
      config: {
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
      config: {
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
      loadRawProfileConfig({ configPath: configPath })?.profiles["glob-child"]
        .writePaths,
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

  it("saves combined Bash and ordinary path allows and continues after re-evaluation", async () => {
    const configPath = writeConfig({
      config: {
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
    const rendered = editor.render().join("\n");
    expect(rendered.indexOf(ruleSectionPresentation.write.label)).toBeLessThan(
      rendered.indexOf(ruleSectionPresentation.bash.label),
    );
    editor.press("Enter");
    expect(await pending).toBeUndefined();

    await harness.callToolWithoutPrompt({
      toolName: "bash",
      input: { command: "echo combined > combined.txt" },
    });
    const profile = loadRawProfileConfig({ configPath: configPath })?.profiles[
      "combined-allow-work"
    ];
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
});
