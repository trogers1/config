import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  createWriteTool,
  createExtensionRuntime,
  ExtensionRunner,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseOrThrow,
  profileConfigFileSchema,
  type ProfileConfigFile,
} from "../modules/policyHelpers";
import { startupProfileFlag } from "../modules/startupProfile";
import {
  workerProfileAuthorityDirectory,
  workerProfileAuthorityMaxBytes,
} from "../modules/workerProfileAuthority";
import type { ProfileAuthoringOverviewSelection } from "../modules/profileAuthoringOverview";
import { profileAuthoringInvalidMarker } from "../modules/profileAuthoringPresentation";
import { createExtensionHarness } from "./support/extensionHarness";

const profileNames = {
  automatic: "automatic",
  explicit: "explicit",
  manual: "manual",
} as const;
const runner = fileURLToPath(new URL("../guard-profile.mjs", import.meta.url));
let directory: string;
let configPath: string;

function writeConfig({ binding = true }: { readonly binding?: boolean } = {}) {
  const policy = {
    tools: { bash: [{ pattern: "*", decision: "deny" }] },
    readPaths: [{ pattern: "*", decision: "allow" }],
    writePaths: [{ pattern: "*", decision: "deny" }],
  } satisfies Pick<
    ProfileConfigFile["profiles"][string],
    "tools" | "readPaths" | "writePaths"
  >;
  const config = {
    defaultProfile: profileNames.manual,
    profiles: {
      [profileNames.automatic]: {
        ...policy,
        description: "Directory-selected read-only profile.",
        ...(binding ? { directoryGlobs: [directory] } : {}),
      },
      [profileNames.explicit]: {
        ...policy,
        description: "Explicit startup write permission.",
        writePaths: [{ pattern: "*", decision: "allow" }],
      },
      [profileNames.manual]: {
        ...policy,
        description: "Manual read-only selection.",
      },
    },
  } satisfies ProfileConfigFile;
  fs.writeFileSync(
    configPath,
    JSON.stringify(
      parseOrThrow({
        unverifiedData: config,
        schema: profileConfigFileSchema,
        message: "Invalid startup test configuration",
      }),
    ),
  );
}

function flags({
  profile,
}: {
  readonly profile: ReturnType<ExtensionAPI["getFlag"]>;
}) {
  return new Map([[startupProfileFlag.name, profile]]);
}

async function writeDecision({
  harness,
}: {
  readonly harness: ReturnType<typeof createExtensionHarness>;
}) {
  const input = parseOrThrow({
    unverifiedData: { path: "result.ts", content: "export {};\n" },
    schema: createWriteTool(directory).parameters,
    message: "Invalid write tool fixture",
  });
  return harness.callTool({ toolName: "write", input });
}

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-guard-startup-"));
  configPath = path.join(directory, "profiles.jsonc");
  vi.stubEnv("HOME", directory);
  vi.stubEnv("PI_GUARD_PROFILE_CONFIG", configPath);
  vi.stubEnv("PI_SUBAGENT_PROFILE", "");
  vi.stubEnv("PI_SUBAGENT_SESSION_ID", "");
  vi.stubEnv("PI_SUBAGENT_PERMISSIBLE_GLOBS", "result.ts");
  vi.stubEnv("PI_GUARD_ACTIVE_PROFILE", "");
  vi.spyOn(process, "cwd").mockReturnValue(directory);
  writeConfig();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(directory, { recursive: true, force: true });
});

describe("switchable startup profile lifecycle", () => {
  it("uses directory/default automatic selection unchanged when omitted", async () => {
    const harness = createExtensionHarness({ hasUI: false });
    await harness.start();
    expect(process.env.PI_GUARD_ACTIVE_PROFILE).toBe(profileNames.automatic);
    expect((await writeDecision({ harness }))?.block).toBe(true);
    expect(harness.entries).toEqual([]);
  });

  it("overrides directory and saved selection before the first tool; later switches persist", async () => {
    const manager = SessionManager.inMemory(directory);
    const previous = createExtensionHarness({ sessionManager: manager });
    await previous.start();
    await previous.runCommand({
      name: "profile-select",
      args: profileNames.manual,
    });
    await previous.dispose();

    const harness = createExtensionHarness({
      hasUI: false,
      sessionManager: manager,
      flags: flags({ profile: profileNames.explicit }),
    });
    await harness.start();
    expect(harness.errors).toEqual([]);
    expect(process.env.PI_GUARD_ACTIVE_PROFILE).toBe(profileNames.explicit);
    expect(await writeDecision({ harness })).toBeUndefined();
    await harness.runCommand({
      name: "profile-select",
      args: profileNames.manual,
    });
    expect((await writeDecision({ harness }))?.block).toBe(true);
    await harness.dispose();

    // Omit the flag on resume: directory policy still outranks saved choices.
    const boundResume = createExtensionHarness({ sessionManager: manager });
    await boundResume.start();
    expect(process.env.PI_GUARD_ACTIVE_PROFILE).toBe(profileNames.automatic);
    await boundResume.dispose();
    writeConfig({ binding: false });
    const unboundResume = createExtensionHarness({ sessionManager: manager });
    await unboundResume.start();
    expect(process.env.PI_GUARD_ACTIVE_PROFILE).toBe(profileNames.manual);
  });

  it("keeps the explicit choice above directory selection when config changes during loading", async () => {
    const harness = createExtensionHarness({
      flags: flags({ profile: profileNames.explicit }),
    });
    // This is a new valid revision between factory load and session_start.
    fs.appendFileSync(configPath, "\n// concurrent source revision\n");
    await harness.start();
    expect(harness.errors).toEqual([]);
    expect(process.env.PI_GUARD_ACTIVE_PROFILE).toBe(profileNames.explicit);
    expect(await writeDecision({ harness })).toBeUndefined();
  });

  it("ignores the launching parent's active-profile marker without an override", async () => {
    vi.stubEnv("PI_GUARD_ACTIVE_PROFILE", profileNames.explicit);
    const harness = createExtensionHarness();
    await harness.start();
    expect(process.env.PI_GUARD_ACTIVE_PROFILE).toBe(profileNames.automatic);
  });

  it("persists the initial selection without requiring a later manual switch", async () => {
    writeConfig({ binding: false });
    const manager = SessionManager.inMemory(directory);
    const harness = createExtensionHarness({
      sessionManager: manager,
      flags: flags({ profile: profileNames.explicit }),
    });
    await harness.start();
    await harness.dispose();
    const resumed = createExtensionHarness({ sessionManager: manager });
    await resumed.start();
    expect(await writeDecision({ harness: resumed })).toBeUndefined();
  });

  it.each([
    { reason: "reload" },
    { reason: "new" },
    { reason: "resume" },
    { reason: "fork" },
  ] as const)(
    "does not reapply on $reason lifecycle events",
    async ({ reason }) => {
      const harness = createExtensionHarness({
        flags: flags({ profile: profileNames.explicit }),
      });
      await harness.start();
      await harness.runCommand({
        name: "profile-select",
        args: profileNames.manual,
      });
      await harness.start({ reason });
      expect(process.env.PI_GUARD_ACTIVE_PROFILE).toBe(profileNames.automatic);
      expect((await writeDecision({ harness }))?.block).toBe(true);
    },
  );

  it.each([
    { profile: "not-a-profile" },
    { profile: "" },
    { profile: " explicit " },
    { profile: true },
  ])(
    "keeps every tool fail-closed for invalid override $profile",
    async ({ profile }) => {
      const harness = createExtensionHarness({
        hasUI: false,
        flags: flags({ profile }),
      });
      await harness.start();
      expect(harness.errors).toHaveLength(1);
      expect((await writeDecision({ harness }))?.reason).toContain(
        `--${startupProfileFlag.name}`,
      );
      await harness.runCommand({
        name: "profile-select",
        args: profileNames.explicit,
      });
      expect((await writeDecision({ harness }))?.block).toBe(true);
    },
  );

  it("rejects a conflicting authoritative subagent even when the override grants writes", async () => {
    vi.stubEnv("PI_SUBAGENT_PROFILE", profileNames.automatic);
    const harness = createExtensionHarness({
      flags: flags({ profile: profileNames.explicit }),
    });
    await harness.start();
    expect((await writeDecision({ harness }))?.reason).toContain(
      "conflicts with authoritative PI_SUBAGENT_PROFILE",
    );
  });

  it("persists a human worker choice across refresh, reload and fresh resume without widening scope or siblings", async () => {
    vi.stubEnv("PI_SUBAGENT_PROFILE", profileNames.automatic);
    vi.stubEnv("PI_SUBAGENT_SESSION_ID", "worker-one");
    const harness = createExtensionHarness({
      flags: flags({ profile: profileNames.automatic }),
    });
    await harness.start();
    expect((await writeDecision({ harness }))?.block).toBe(true);
    await harness.runCommand({
      name: "profile-select",
      args: profileNames.explicit,
    });
    expect(await writeDecision({ harness })).toBeUndefined();
    fs.appendFileSync(configPath, "\n// refreshed configuration\n");
    expect(await writeDecision({ harness })).toBeUndefined();
    for (const reason of ["reload", "resume", "new", "fork"] as const) {
      await harness.start({ reason });
      expect(await writeDecision({ harness })).toBeUndefined();
    }
    const outside = parseOrThrow({
      unverifiedData: { path: "outside.ts", content: "blocked" },
      schema: createWriteTool(directory).parameters,
      message: "Invalid outside write fixture",
    });
    expect(
      (await harness.callTool({ toolName: "write", input: outside }))?.reason,
    ).toContain("PI_SUBAGENT_PERMISSIBLE_GLOBS");
    const authorityDirectory = workerProfileAuthorityDirectory({});
    const authorityFile = path.join(
      authorityDirectory,
      fs.readdirSync(authorityDirectory)[0],
    );
    const authorityWrite = parseOrThrow({
      unverifiedData: { path: authorityFile, content: "{}" },
      schema: createWriteTool(directory).parameters,
      message: "Invalid authority write fixture",
    });
    expect(
      (await harness.callTool({ toolName: "write", input: authorityWrite }))
        ?.reason,
    ).toContain("PI_SUBAGENT_PERMISSIBLE_GLOBS");
    await expect(
      harness.executeTool({
        name: "profile-select",
        params: { profile: profileNames.explicit },
      }),
    ).rejects.toThrow("Tool not registered");
    await harness.dispose();

    const resumed = createExtensionHarness({ hasUI: false });
    await resumed.start();
    expect(await writeDecision({ harness: resumed })).toBeUndefined();
    await resumed.dispose();
    vi.stubEnv("PI_SUBAGENT_SESSION_ID", "worker-two");
    const sibling = createExtensionHarness();
    await sibling.start();
    expect((await writeDecision({ harness: sibling }))?.block).toBe(true);
    await sibling.dispose();
    vi.stubEnv("PI_SUBAGENT_PROFILE", "");
    const parent = createExtensionHarness();
    await parent.start();
    expect((await writeDecision({ harness: parent }))?.block).toBe(true);
  });

  it("rejects a valid oversized worker scope without changing selection or creating authority", async () => {
    vi.stubEnv("PI_SUBAGENT_PROFILE", profileNames.explicit);
    vi.stubEnv("PI_SUBAGENT_SESSION_ID", "oversized-scope-worker");
    // Multibyte scope is below the character limit but above the byte limit.
    vi.stubEnv(
      "PI_SUBAGENT_PERMISSIBLE_GLOBS",
      `result.ts,${"é".repeat(workerProfileAuthorityMaxBytes / 2)}`,
    );
    const harness = createExtensionHarness();
    await harness.start();
    expect(harness.errors).toEqual([]);
    expect(await writeDecision({ harness })).toBeUndefined();
    await expect(
      harness.runCommand({ name: "profile-select", args: profileNames.manual }),
    ).rejects.toThrow(
      `Worker profile authority exceeds ${workerProfileAuthorityMaxBytes} bytes`,
    );
    expect(fs.existsSync(workerProfileAuthorityDirectory({}))).toBe(false);
    expect(process.env.PI_GUARD_ACTIVE_PROFILE).toBe(profileNames.explicit);
    expect(await writeDecision({ harness })).toBeUndefined();
    await harness.dispose();
    const resumed = createExtensionHarness({ hasUI: false });
    await resumed.start();
    expect(resumed.errors).toEqual([]);
    expect(await writeDecision({ harness: resumed })).toBeUndefined();
  });

  it("preserves existing authority and tools when a human selection exceeds the byte limit", async () => {
    vi.stubEnv("PI_SUBAGENT_PROFILE", profileNames.automatic);
    vi.stubEnv("PI_SUBAGENT_SESSION_ID", "oversized-profile-worker");
    const harness = createExtensionHarness();
    await harness.start();
    await harness.runCommand({
      name: "profile-select",
      args: profileNames.explicit,
    });
    const root = workerProfileAuthorityDirectory({});
    const file = path.join(root, fs.readdirSync(root)[0]);
    const before = fs.readFileSync(file, "utf8");
    const oversizedProfile = "p".repeat(workerProfileAuthorityMaxBytes);
    const config = parseOrThrow({
      unverifiedData: JSON.parse(fs.readFileSync(configPath, "utf8")),
      schema: profileConfigFileSchema,
      message: "Invalid oversized profile test configuration",
    });
    fs.writeFileSync(
      configPath,
      JSON.stringify(
        parseOrThrow({
          unverifiedData: {
            ...config,
            profiles: {
              ...config.profiles,
              [oversizedProfile]: config.profiles[profileNames.manual],
            },
          } satisfies ProfileConfigFile,
          schema: profileConfigFileSchema,
          message: "Invalid oversized profile test configuration",
        }),
      ),
    );
    await expect(
      harness.runCommand({ name: "profile-select", args: oversizedProfile }),
    ).rejects.toThrow(
      `Worker profile authority exceeds ${workerProfileAuthorityMaxBytes} bytes`,
    );
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    expect(process.env.PI_GUARD_ACTIVE_PROFILE).toBe(profileNames.explicit);
    expect(await writeDecision({ harness })).toBeUndefined();
    await harness.dispose();
    const resumed = createExtensionHarness({ hasUI: false });
    await resumed.start();
    expect(resumed.errors).toEqual([]);
    expect(await writeDecision({ harness: resumed })).toBeUndefined();
  });

  it("rejects renaming the human-selected worker profile before saving", async () => {
    vi.stubEnv("PI_SUBAGENT_PROFILE", profileNames.automatic);
    vi.stubEnv("PI_SUBAGENT_SESSION_ID", "rename-worker");
    const harness = createExtensionHarness({
      interactiveUi: true,
      confirm: true,
    });
    await harness.start();
    await harness.runCommand({
      name: "profile-select",
      args: profileNames.explicit,
    });
    const before = fs.readFileSync(configPath, "utf8");
    const root = workerProfileAuthorityDirectory({});
    const file = path.join(root, fs.readdirSync(root)[0]);
    const authorityBefore = fs.readFileSync(file, "utf8");
    const pending = harness.runCommand({ name: "profile-edit", args: "" });
    (await harness.ui.waitForProfileAuthoringOverview()).choose({
      selection: {
        kind: "section",
        id: "general",
      } satisfies ProfileAuthoringOverviewSelection,
    });
    const general = await harness.ui.waitForProfileGeneralForm();
    general.press("CtrlU");
    general.type("renamed");
    general.press("Enter");
    (await harness.ui.waitForProfileAuthoringOverview()).choose({
      selection: {
        kind: "action",
        id: "submit",
      } satisfies ProfileAuthoringOverviewSelection,
    });
    const invalidGeneral = await harness.ui.waitForProfileGeneralForm();
    const rendered = invalidGeneral.render(1_000).join("\n");
    expect(rendered).toContain(profileAuthoringInvalidMarker);
    expect(rendered).toContain("saved human worker profile selection");
    invalidGeneral.press("Escape");
    (await harness.ui.waitForProfileAuthoringOverview()).cancel();
    await pending;
    expect(fs.readFileSync(configPath, "utf8")).toBe(before);
    expect(fs.readFileSync(file, "utf8")).toBe(authorityBefore);
    expect(await writeDecision({ harness })).toBeUndefined();
    await harness.dispose();
    const resumed = createExtensionHarness({ hasUI: false });
    await resumed.start();
    expect(resumed.errors).toEqual([]);
    expect(process.env.PI_GUARD_ACTIVE_PROFILE).toBe(profileNames.explicit);
    expect(await writeDecision({ harness: resumed })).toBeUndefined();
  });

  it.each([{ ancestors: 0 }, { ancestors: 1 }, { ancestors: 2 }])(
    "fails startup closed for a dangling authority directory symlink ($ancestors ancestors)",
    async ({ ancestors }) => {
      vi.stubEnv("PI_SUBAGENT_PROFILE", profileNames.explicit);
      vi.stubEnv("PI_SUBAGENT_SESSION_ID", "dangling-directory-worker");
      let entry = workerProfileAuthorityDirectory({});
      for (let level = 0; level < ancestors; level++)
        entry = path.dirname(entry);
      fs.mkdirSync(path.dirname(entry), { recursive: true, mode: 0o700 });
      fs.symlinkSync(path.join(directory, "missing-target"), entry);
      const harness = createExtensionHarness();
      await harness.start();
      expect(harness.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining(
          `Unsafe worker profile authority path: ${entry}`,
        ),
        "error",
      );
      expect((await writeDecision({ harness }))?.reason).toContain(
        `Unsafe worker profile authority path: ${entry}`,
      );
      expect(process.env.PI_GUARD_ACTIVE_PROFILE).toBeUndefined();
      expect(fs.lstatSync(entry).isSymbolicLink()).toBe(true);
    },
  );

  it("persists human keyboard picker choices, but not cancellation", async () => {
    vi.stubEnv("PI_SUBAGENT_PROFILE", profileNames.automatic);
    vi.stubEnv("PI_SUBAGENT_SESSION_ID", "picker-worker");
    const sessionManager = SessionManager.inMemory(directory);
    const harness = createExtensionHarness({
      sessionManager,
      customResults: [null, profileNames.explicit],
    });
    const modelRuntime = await ModelRuntime.create({
      authPath: path.join(directory, "auth.json"),
      modelsPath: null,
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
    const runner = new ExtensionRunner(
      [],
      createExtensionRuntime(),
      directory,
      sessionManager,
      new ModelRegistry(modelRuntime),
    );
    runner.setUIContext(
      { ...runner.getUIContext(), ...harness.context.ui },
      "tui",
    );
    const context = runner.createContext();
    await harness.start();
    const shortcut = harness.shortcuts.get("ctrl+shift+i");
    if (!shortcut) throw new Error("Profile picker shortcut is missing");
    await shortcut.handler(context);
    expect(fs.existsSync(workerProfileAuthorityDirectory({}))).toBe(false);
    await shortcut.handler(context);
    runner.invalidate("Picker test finished");
    expect(await writeDecision({ harness })).toBeUndefined();
    await harness.dispose();
    const resumed = createExtensionHarness({ hasUI: false });
    await resumed.start();
    expect(await writeDecision({ harness: resumed })).toBeUndefined();
  });

  it.each([
    { hasUI: false, workerId: "worker", error: "human UI" },
    { hasUI: true, workerId: "", error: "PI_SUBAGENT_SESSION_ID" },
    { hasUI: true, workerId: "../escape", error: "binding" },
  ])(
    "rejects an untrusted worker selection ($hasUI, $workerId)",
    async ({ hasUI, workerId, error }) => {
      vi.stubEnv("PI_SUBAGENT_PROFILE", profileNames.automatic);
      vi.stubEnv("PI_SUBAGENT_SESSION_ID", workerId);
      const harness = createExtensionHarness({ hasUI });
      await harness.start();
      if (workerId === "../escape") {
        expect((await writeDecision({ harness }))?.reason).toContain(error);
      } else {
        await expect(
          harness.runCommand({
            name: "profile-select",
            args: profileNames.explicit,
          }),
        ).rejects.toThrow(error);
        expect((await writeDecision({ harness }))?.block).toBe(true);
      }
      expect(fs.existsSync(workerProfileAuthorityDirectory({}))).toBe(false);
    },
  );

  it("keeps startup conflicts fail-closed even with a saved human override", async () => {
    vi.stubEnv("PI_SUBAGENT_PROFILE", profileNames.automatic);
    vi.stubEnv("PI_SUBAGENT_SESSION_ID", "worker");
    const harness = createExtensionHarness();
    await harness.start();
    await harness.runCommand({
      name: "profile-select",
      args: profileNames.explicit,
    });
    await harness.dispose();
    const resumed = createExtensionHarness({
      flags: flags({ profile: profileNames.explicit }),
    });
    await resumed.start();
    expect((await writeDecision({ harness: resumed }))?.reason).toContain(
      "conflicts with authoritative PI_SUBAGENT_PROFILE",
    );
  });

  it.each([
    { change: "scope" },
    { change: "profile" },
    { change: "malformed" },
    { change: "symlink" },
  ])(
    "fails closed when saved worker authority has a $change mismatch",
    async ({ change }) => {
      vi.stubEnv("PI_SUBAGENT_PROFILE", profileNames.automatic);
      vi.stubEnv("PI_SUBAGENT_SESSION_ID", "worker");
      const harness = createExtensionHarness();
      await harness.start();
      await harness.runCommand({
        name: "profile-select",
        args: profileNames.explicit,
      });
      await harness.dispose();
      if (change === "scope") vi.stubEnv("PI_SUBAGENT_PERMISSIBLE_GLOBS", "**");
      else if (change === "profile")
        vi.stubEnv("PI_SUBAGENT_PROFILE", profileNames.manual);
      else {
        const root = workerProfileAuthorityDirectory({});
        const file = path.join(root, fs.readdirSync(root)[0]);
        if (change === "malformed") fs.writeFileSync(file, "{}");
        else {
          fs.renameSync(file, `${file}.target`);
          fs.symlinkSync(`${file}.target`, file);
        }
      }
      const resumed = createExtensionHarness();
      await resumed.start();
      expect((await writeDecision({ harness: resumed }))?.block).toBe(true);
      expect(process.env.PI_GUARD_ACTIVE_PROFILE).toBeUndefined();
    },
  );

  it("rejects an unknown authoritative subagent rather than taking a valid override", async () => {
    vi.stubEnv("PI_SUBAGENT_PROFILE", "unknown-worker");
    const harness = createExtensionHarness({
      flags: flags({ profile: profileNames.explicit }),
    });
    await harness.start();
    expect((await writeDecision({ harness }))?.reason).toContain(
      "Invalid PI_SUBAGENT_PROFILE",
    );
  });

  it("keeps invalid configuration fail-closed with an explicit built-in selection", async () => {
    fs.writeFileSync(configPath, "not valid JSONC");
    const harness = createExtensionHarness({
      flags: flags({ profile: "builtin:default" }),
    });
    await harness.start();
    expect(harness.errors).toHaveLength(1);
    expect((await writeDecision({ harness }))?.block).toBe(true);
  });
});

describe("read-only launcher preflight process", () => {
  it.each([{ profile: profileNames.explicit }, { profile: "builtin:default" }])(
    "validates $profile without creating sessions",
    ({ profile }) => {
      const before = fs.readdirSync(directory);
      const result = spawnSync(
        process.execPath,
        [runner, "--profile", profile, "--cwd", directory],
        {
          env: process.env,
          encoding: "utf8",
          timeout: 10_000,
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ profile });
      expect(fs.readdirSync(directory)).toEqual(before);
    },
  );

  it.each([
    {
      profile: "missing",
      subagent: "",
      config: "valid",
      message: "Unknown --guard-profile",
    },
    {
      profile: profileNames.explicit,
      subagent: profileNames.automatic,
      config: "valid",
      message: "conflicts",
    },
    {
      profile: profileNames.explicit,
      subagent: "unknown",
      config: "valid",
      message: "Invalid PI_SUBAGENT_PROFILE",
    },
    {
      profile: profileNames.explicit,
      subagent: "",
      config: "invalid",
      message: "Invalid pi-guard profile config",
    },
  ])(
    "fails before launch: $message",
    ({ profile, subagent, config, message }) => {
      if (config === "invalid") fs.writeFileSync(configPath, "invalid JSONC");
      const result = spawnSync(
        process.execPath,
        [runner, "--profile", profile, "--cwd", directory],
        {
          env: { ...process.env, PI_SUBAGENT_PROFILE: subagent },
          encoding: "utf8",
          timeout: 10_000,
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(message);
    },
  );
});
