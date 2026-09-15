import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createExtensionHarness,
  lastCallArgument,
} from "./support/extensionHarness";

const temporaryDirectories: string[] = [];

function writeProfileConfig({
  startupGlob,
}: {
  readonly startupGlob: string;
}): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-guard-config-"));
  temporaryDirectories.push(directory);
  const configPath = path.join(directory, "profiles.jsonc");
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      profiles: {
        selected: {
          description: "Profile selected from the immutable startup directory.",
          extends: ["builtin:default"],
          directoryGlobs: [startupGlob],
        },
      },
    }),
  );
  return configPath;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

describe("directory-selected profiles", () => {
  it("selects a profile for a real /tmp startup directory", async () => {
    const startupCwd = fs.mkdtempSync(
      path.join(os.tmpdir(), "pi-guard-project-"),
    );
    temporaryDirectories.push(startupCwd);
    vi.stubEnv(
      "PI_GUARD_PROFILE_CONFIG",
      writeProfileConfig({ startupGlob: startupCwd }),
    );
    vi.spyOn(process, "cwd").mockReturnValue(startupCwd);

    const harness = createExtensionHarness({ contextCwd: startupCwd });
    await harness.start();

    expect(
      lastCallArgument({ mock: harness.ui.setStatus, index: 1 }),
    ).toContain("selected");
  });

  it("selects a profile bound to the home-directory root", async () => {
    const startupCwd = path.join(os.homedir(), "pi-guard-startup", "nested");
    vi.stubEnv(
      "PI_GUARD_PROFILE_CONFIG",
      writeProfileConfig({ startupGlob: "~" }),
    );
    vi.spyOn(process, "cwd").mockReturnValue(startupCwd);

    const harness = createExtensionHarness({ contextCwd: startupCwd });
    await harness.start();

    expect(
      lastCallArgument({ mock: harness.ui.setStatus, index: 1 }),
    ).toContain("selected");
  });
});
