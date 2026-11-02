import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProfileConfigFile } from "../modules/policyHelpers";
import { postureEnvironmentVariable } from "../modules/posture";
import {
  createExtensionHarness,
  lastCallArgument,
} from "./support/extensionHarness";
import {
  allowOnceChoice,
  installProfileUpdateFixture,
  writeConfig,
} from "./support/profileUpdateTestSupport";

installProfileUpdateFixture({});
// Each test chooses its own posture; never inherit one from the previous
// test, including one written by the real /posture command.
afterEach(() => {
  vi.unstubAllEnvs();
  delete process.env[postureEnvironmentVariable];
});

const webfetch = {
  toolName: "webfetch",
  input: { url: "https://example.com" },
};
const askedCommand = "echo posture-check";
const askedRead = { toolName: "read", input: { path: "posture-secret/a.txt" } };
const askedDeploy = { toolName: "deploy", input: { environment: "staging" } };
const askRule = {
  pattern: askedCommand,
  decision: "ask",
  guidance: "Ask before echoing posture checks.",
} as const;

/**
 * The ASK rule lives on a parent, so `current`'s transforms compose over it.
 * `ownAskRule` adds the same rule to `current` itself, which merges after its
 * transforms and therefore stays an ASK.
 */
function useConfig({
  transforms,
  ownAskRule = false,
}: {
  readonly transforms?: ProfileConfigFile["profiles"][string]["transforms"];
  readonly ownAskRule?: boolean;
} = {}): void {
  process.env.PI_GUARD_PROFILE_CONFIG = writeConfig({
    config: {
      defaultProfile: "current",
      profiles: {
        parent: {
          description: "Posture fixture rules",
          extends: ["builtin:default"],
          tools: { bash: [askRule], deploy: [{ decision: "ask" }] },
          readPaths: [{ pattern: "posture-secret/**", decision: "ask" }],
        },
        current: {
          description: "Posture fixture",
          extends: ["parent"],
          ...(transforms === undefined ? {} : { transforms }),
          ...(ownAskRule ? { tools: { bash: [askRule] } } : {}),
        },
      },
    },
  });
}

describe("session posture", () => {
  it("deny refuses remaining ASKs without prompting, with rule guidance", async () => {
    useConfig();
    vi.stubEnv(postureEnvironmentVariable, "deny");
    const harness = createExtensionHarness({ interactiveUi: true });
    await harness.start();

    const result = await harness.callToolDecisivelyWithoutPrompt({
      toolName: "bash",
      input: { command: askedCommand },
    });
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain("deny posture");
    expect(result?.reason).toContain("Ask before echoing posture checks.");
    expect(
      (await harness.callToolDecisivelyWithoutPrompt(webfetch))?.block,
    ).toBe(true);
  });

  it("allow approves remaining ASKs without prompting", async () => {
    useConfig();
    vi.stubEnv(postureEnvironmentVariable, "allow");
    const harness = createExtensionHarness({ interactiveUi: true });
    await harness.start();

    await harness.callToolWithoutPrompt({
      toolName: "bash",
      input: { command: askedCommand },
    });
    await harness.callToolWithoutPrompt(webfetch);
  });

  it("does not loosen what composition denied", async () => {
    // deny-asks turns the explicit ASK rule into a deny during composition,
    // so an allow posture never sees an ASK to approve.
    useConfig({ transforms: ["transform:deny-asks"] });
    vi.stubEnv(postureEnvironmentVariable, "allow");
    const harness = createExtensionHarness({ hasUI: false });
    await harness.start();

    for (const request of [
      { toolName: "bash", input: { command: askedCommand } },
      webfetch,
    ])
      expect(
        (await harness.callToolDecisivelyWithoutPrompt(request))?.block,
      ).toBe(true);
  });

  it("resolves a profile's own ASK rule left after its transforms", async () => {
    // A profile's own rules merge after its transforms, so its own ASK
    // survives composition; unmatched requests stay denied by deny-asks.
    useConfig({ transforms: ["transform:deny-asks"], ownAskRule: true });
    vi.stubEnv(postureEnvironmentVariable, "allow");
    const harness = createExtensionHarness({ hasUI: false });
    await harness.start();

    await harness.callToolWithoutPrompt({
      toolName: "bash",
      input: { command: askedCommand },
    });
    expect(
      (await harness.callToolDecisivelyWithoutPrompt(webfetch))?.block,
    ).toBe(true);
  });

  it.each(["deny", "allow"] as const)(
    "%s resolves path-tool and custom-tool ASKs without prompting",
    async (posture) => {
      useConfig();
      vi.stubEnv(postureEnvironmentVariable, posture);
      const harness = createExtensionHarness({ interactiveUi: true });
      await harness.start();
      for (const request of [askedRead, askedDeploy]) {
        const result = await harness.callToolDecisivelyWithoutPrompt(request);
        expect(result?.block ?? false).toBe(posture === "deny");
      }
    },
  );

  it("keeps composed path and custom denies under an allow posture", async () => {
    useConfig({ transforms: ["transform:deny-asks"] });
    vi.stubEnv(postureEnvironmentVariable, "allow");
    const harness = createExtensionHarness({ hasUI: false });
    await harness.start();
    for (const request of [askedRead, askedDeploy])
      expect(
        (await harness.callToolDecisivelyWithoutPrompt(request))?.block,
      ).toBe(true);
  });

  it("invalidates an open prompt's answer when the posture changes", async () => {
    useConfig();
    const harness = createExtensionHarness({ interactiveUi: true });
    await harness.start();
    const pending = harness.callTool({
      toolName: "bash",
      input: { command: askedCommand },
    });
    const picker = await harness.ui.waitForPermissionChoice();
    await harness.runCommand({ name: "posture", args: "deny" });
    picker.choose(allowOnceChoice);
    const result = await pending;
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain("deny posture");
  });

  it("invalidates an open prompt's answer when a posture is set and cleared", async () => {
    useConfig();
    const harness = createExtensionHarness({ interactiveUi: true });
    await harness.start();
    const pending = harness.callTool({
      toolName: "bash",
      input: { command: askedCommand },
    });
    const first = await harness.ui.waitForPermissionChoice();
    await harness.runCommand({ name: "posture", args: "allow" });
    await harness.runCommand({ name: "posture", args: "off" });
    first.choose(allowOnceChoice);
    // The answer is stale, so the request asks again.
    const second = await harness.ui.waitForPermissionChoice();
    second.choose(allowOnceChoice);
    expect((await pending)?.block ?? false).toBe(false);
  });

  it("fails closed on an invalid launch posture", async () => {
    useConfig();
    vi.stubEnv(postureEnvironmentVariable, "sometimes");
    const harness = createExtensionHarness({ hasUI: false });
    await harness.start();

    const result = await harness.callToolDecisivelyWithoutPrompt(webfetch);
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain(
      `Invalid ${postureEnvironmentVariable} 'sometimes'`,
    );
    await harness.runCommand({
      name: "permissions",
      args: "explain webfetch {}",
    });
    expect(lastCallArgument({ mock: harness.ui.notify, index: 0 })).toContain(
      "Every tool call is blocked until it is corrected.",
    );
  });

  it("/posture switches the session and is inherited through the environment", async () => {
    useConfig();
    vi.stubEnv(postureEnvironmentVariable, "");
    const harness = createExtensionHarness({ hasUI: false });
    await harness.start();

    await harness.runCommand({ name: "posture", args: "deny" });
    expect(process.env[postureEnvironmentVariable]).toBe("deny");
    expect(
      lastCallArgument({ mock: harness.ui.setStatus, index: 1 }),
    ).toContain("posture: deny");
    expect(
      (await harness.callToolDecisivelyWithoutPrompt(webfetch))?.reason,
    ).toContain("deny posture");

    await harness.runCommand({ name: "posture", args: "off" });
    expect(process.env[postureEnvironmentVariable]).toBeUndefined();

    await harness.runCommand({ name: "posture", args: "sometimes" });
    expect(lastCallArgument({ mock: harness.ui.notify, index: 0 })).toContain(
      "Invalid",
    );
    expect(process.env[postureEnvironmentVariable]).toBeUndefined();
  });

  it("/permissions explain reports the posture's resolution", async () => {
    useConfig();
    vi.stubEnv(postureEnvironmentVariable, "deny");
    const harness = createExtensionHarness({ hasUI: false });
    await harness.start();

    await harness.runCommand({
      name: "permissions",
      args: `explain bash ${askedCommand}`,
    });
    expect(lastCallArgument({ mock: harness.ui.notify, index: 0 })).toContain(
      "This session's deny posture resolves the remaining ASK to deny.",
    );
  });
});
