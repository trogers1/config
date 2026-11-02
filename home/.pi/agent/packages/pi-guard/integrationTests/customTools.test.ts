import { describe, expect, it } from "vitest";
import { PERMISSION_BLOCK_PREFIX } from "../extensions/guard";
import type { ProfileConfigFile } from "../modules/policyHelpers";
import { createExtensionHarness } from "./support/extensionHarness";
import {
  allowOnceChoice,
  denyChoice,
  installProfileUpdateFixture,
  writeConfig,
} from "./support/profileUpdateTestSupport";

installProfileUpdateFixture({});

function useProfile({
  extends: parents,
  transforms,
}: {
  readonly extends: [string, ...string[]];
  readonly transforms?: ProfileConfigFile["profiles"][string]["transforms"];
}): void {
  process.env.PI_GUARD_PROFILE_CONFIG = writeConfig({
    config: {
      defaultProfile: "current",
      profiles: {
        current: {
          description: "Custom-tool gating profile",
          extends: parents,
          ...(transforms === undefined ? {} : { transforms }),
        },
      },
    },
  });
}

const webfetchRequest = {
  toolName: "webfetch",
  input: {
    url: "https://example.com/docs",
    task: `${"summarize the page ".repeat(20)}tail-of-task`,
    cwd: "/tmp/custom-tool-request",
  },
};

describe("unconfigured custom tools", () => {
  it("asks with the request visible, one argument per line", async () => {
    useProfile({ extends: ["builtin:default"] });
    const harness = createExtensionHarness({ interactiveUi: true });
    await harness.start();
    const pending = harness.callTool(webfetchRequest);
    const picker = await harness.ui.waitForPermissionChoice();
    const rendered = picker.render();
    picker.choose(allowOnceChoice);

    expect(await pending).toBeUndefined();
    const text = rendered.join("\n");
    expect(text).toContain("Custom tool permission request");
    expect(text).toContain("webfetch has no matching custom tool policy.");
    // A long task truncates its own line only; url and cwd stay visible.
    for (const value of [
      "https://example.com/docs",
      "/tmp/custom-tool-request",
    ])
      expect(rendered.some((line) => line.includes(value))).toBe(true);
  });

  it("keeps every argument visible and escapes terminal controls", async () => {
    useProfile({ extends: ["builtin:default"] });
    const harness = createExtensionHarness({ interactiveUi: true });
    await harness.start();
    const pending = harness.callTool({
      toolName: "webfetch",
      input: {
        // A large first argument must not push later ones out of view.
        options: Object.fromEntries(
          Array.from({ length: 40 }, (_, index) => [`option${index}`, index]),
        ),
        url: "https://example.com/after-options",
        note: "safe\u202Etxt.exe\u009B",
        hidden: "ex\u200Bample.com",
      },
    });
    const picker = await harness.ui.waitForPermissionChoice();
    const rendered = picker.render().join("\n");
    picker.choose(denyChoice);
    await pending;

    expect(rendered).toContain('"url": "https://example.com/after-options"');
    expect(rendered).toContain('"note": "safe\\u202etxt.exe\\u009b"');
    expect(rendered).not.toContain("\u202E");
    expect(rendered).not.toContain("\u009B");
    expect(rendered).toContain('"hidden": "ex\\u200bample.com"');
  });

  it("refuses input with an own __proto__ key as a permission block", async () => {
    useProfile({ extends: ["builtin:default"] });
    const harness = createExtensionHarness({ hasUI: false });
    await harness.start();
    // JSON.parse creates an own "__proto__" data property, as model arguments do.
    const input: unknown = JSON.parse(
      '{"path": "README.md", "__proto__": {"path": "/etc/passwd"}}',
    );
    if (typeof input !== "object" || input === null)
      throw new Error("Expected an object input");
    const result = await harness.callToolDecisivelyWithoutPrompt({
      toolName: "read",
      input: { ...Object.fromEntries(Object.entries(input)) },
    });
    expect(result?.block).toBe(true);
    expect(result?.reason?.startsWith(PERMISSION_BLOCK_PREFIX)).toBe(true);
    expect(result?.reason).toContain("__proto__");
  });

  it("blocks when the user rejects", async () => {
    useProfile({ extends: ["builtin:default"] });
    const harness = createExtensionHarness({ interactiveUi: true });
    await harness.start();
    const pending = harness.callTool(webfetchRequest);
    (await harness.ui.waitForPermissionChoice()).choose(denyChoice);
    const result = await pending;
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain("webfetch was not approved");
  });

  it("fails closed without a UI", async () => {
    useProfile({ extends: ["builtin:default"] });
    const harness = createExtensionHarness({ hasUI: false });
    await harness.start();
    expect(
      await harness.callToolDecisivelyWithoutPrompt(webfetchRequest),
    ).toMatchObject({ block: true });
  });

  it.each([
    ["transform:allow-asks", undefined],
    ["transform:deny-asks", true],
  ] as const)(
    "follows the profile's implicit-ASK transform %s",
    async (transform, blocked) => {
      useProfile({ extends: ["builtin:default"], transforms: [transform] });
      const harness = createExtensionHarness({ hasUI: false });
      await harness.start();
      const result =
        await harness.callToolDecisivelyWithoutPrompt(webfetchRequest);
      expect(result?.block).toBe(blocked);
    },
  );

  it("treats Object.prototype names as unconfigured tools", async () => {
    // The old lookup read Object.prototype.constructor as this tool's rules.
    useProfile({ extends: ["builtin:default"] });
    const harness = createExtensionHarness({ interactiveUi: true });
    await harness.start();
    const pending = harness.callTool({ toolName: "constructor", input: {} });
    const picker = await harness.ui.waitForPermissionChoice();
    const rendered = picker.render().join("\n");
    picker.choose(denyChoice);
    await pending;
    expect(rendered).toContain(
      "constructor has no matching custom tool policy.",
    );
  });

  it("composes and enforces a user rule for a tool named constructor", async () => {
    process.env.PI_GUARD_PROFILE_CONFIG = writeConfig({
      config: {
        defaultProfile: "current",
        profiles: {
          current: {
            description: "Own-key custom tool rule",
            extends: ["builtin:default"],
            // A literal `constructor` key is typed as Object's constructor.
            tools: Object.fromEntries([
              ["constructor", [{ decision: "allow" }]],
            ]),
          },
        },
      },
    });
    const harness = createExtensionHarness({ hasUI: false });
    await harness.start();
    await harness.callToolWithoutPrompt({ toolName: "constructor", input: {} });
  });
});

describe("shipped agent-tool rules", () => {
  const agentTools = [
    { toolName: "codemode", input: { code: "return 1;" } },
    { toolName: "subagent", input: { agent: "scout", task: "look around" } },
    { toolName: "subagent_message", input: { message: "done" } },
    { toolName: "ask_question", input: { question: "which file?" } },
  ];

  // Parents run builtin:default; children run builtin:read-only and
  // builtin:worker, which denies every ASK.
  it.each(["builtin:default", "builtin:read-only", "builtin:worker"])(
    "%s allows codemode and subagent coordination without prompting",
    async (parent) => {
      useProfile({ extends: [parent] });
      const harness = createExtensionHarness({ hasUI: false });
      await harness.start();
      for (const request of agentTools)
        await harness.callToolWithoutPrompt(request);
    },
  );

  it.each([
    [["builtin:default", "builtin:committer", "ruleset:subagents-off"], true],
    // Later wins for every inherited rule: a later shipped profile's copy of
    // the shared allows re-enables subagents.
    [
      ["builtin:default", "ruleset:subagents-off", "builtin:committer"],
      undefined,
    ],
  ] as const)(
    "ruleset:subagents-off composes by order with several shipped profiles: %j",
    async (parents, blocked) => {
      useProfile({ extends: [...parents] });
      const harness = createExtensionHarness({ hasUI: false });
      await harness.start();
      const result = await harness.callToolDecisivelyWithoutPrompt(
        agentTools[1],
      );
      expect(result?.block).toBe(blocked);
    },
  );

  it("a shipped profile reached through another profile re-enables subagents", async () => {
    process.env.PI_GUARD_PROFILE_CONFIG = writeConfig({
      config: {
        defaultProfile: "nosub-committer",
        profiles: {
          nosub: {
            description: "No subagents",
            extends: ["builtin:default", "ruleset:subagents-off"],
          },
          "nosub-committer": {
            description: "No subagents, then a later shipped profile",
            extends: ["nosub", "builtin:committer"],
          },
        },
      },
    });
    const harness = createExtensionHarness({ hasUI: false });
    await harness.start();
    await harness.callToolWithoutPrompt(agentTools[1]);
  });

  it("ruleset:subagents-off disables subagent tools but keeps codemode", async () => {
    useProfile({ extends: ["builtin:default", "ruleset:subagents-off"] });
    const harness = createExtensionHarness({ hasUI: false });
    await harness.start();
    for (const request of agentTools.slice(1)) {
      const result = await harness.callToolDecisivelyWithoutPrompt(request);
      expect(result?.block).toBe(true);
      expect(result?.reason).toContain("Subagents are disabled");
    }
    await harness.callToolWithoutPrompt(agentTools[0]);
  });
});
