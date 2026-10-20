import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  createWriteTool,
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

  it("accepts the same subagent selection but does not let later switches bypass it", async () => {
    vi.stubEnv("PI_SUBAGENT_PROFILE", profileNames.automatic);
    const harness = createExtensionHarness({
      flags: flags({ profile: profileNames.automatic }),
    });
    await harness.start();
    expect(harness.errors).toEqual([]);
    await expect(
      harness.runCommand({
        name: "profile-select",
        args: profileNames.explicit,
      }),
    ).rejects.toThrow("authoritative");
    expect((await writeDecision({ harness }))?.block).toBe(true);
  });

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
