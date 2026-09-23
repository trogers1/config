import path from "node:path";
import { describe, expect, it } from "vitest";
import { policyConfig } from "../modules/policy";
import { loadProfileConfig } from "../modules/profileConfig";
import type { RuntimeRequirementName } from "../modules/runtimeRequirements";

const repositoryProfileConfigPath = path.resolve(
  import.meta.dirname,
  "../../../pi-guard/profiles.jsonc",
);
const standardRuntimeRequirements = [
  "go-toolchain-cache",
  "vitest-vite-temp",
] as const satisfies readonly RuntimeRequirementName[];
const inheritedMcpProfiles = [
  "mcp",
  "personal-sidecar-comments",
  "personal-deny-asks",
  "personal-allow-asks",
] as const;
const configMaintenanceProfiles = [
  "config-maintenance",
  "config-maintenance-tests-hidden",
  "config-maintenance-tests-only",
  "config-maintenance-allow-asks",
] as const;

describe("checked-in profile configuration", () => {
  it("loads the mcp hard rename and selected runtime workflows", () => {
    const config = loadProfileConfig({
      fallback: policyConfig,
      configPath: repositoryProfileConfigPath,
    });

    expect(config.defaultProfile).toBe("mcp");
    expect(Object.hasOwn(config.profiles, "personal")).toBe(false);

    for (const profileName of inheritedMcpProfiles) {
      expect(config.profiles[profileName]?.runtime.requirements).toEqual(
        standardRuntimeRequirements,
      );
    }
    for (const profileName of configMaintenanceProfiles) {
      expect(config.profiles[profileName]?.runtime.requirements).toEqual(
        standardRuntimeRequirements,
      );
    }
    expect(config.profiles["config-maintenance"]?.policy.sandbox).toBe(false);
  });
});
