import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { decideBash } from "../extensions/guard";
import {
  loadRawProfileConfig,
  loadProfileConfig,
} from "../modules/profileConfig";
import { policyConfig } from "../modules/policy";
import { createExtensionHarness } from "./support/extensionHarness";

const originalConfigPath = process.env.PI_GUARD_PROFILE_CONFIG;
const files: string[] = [];

afterEach(() => {
  if (originalConfigPath === undefined) {
    delete process.env.PI_GUARD_PROFILE_CONFIG;
  } else {
    process.env.PI_GUARD_PROFILE_CONFIG = originalConfigPath;
  }
  for (const file of files.splice(0)) fs.rmSync(file, { force: true });
});

function temporaryConfig(): string {
  const file = path.join(
    tmpdir(),
    `pi-guard-profile-add-${crypto.randomUUID()}.jsonc`,
  );
  files.push(file);
  fs.writeFileSync(file, '// Keep user comments\n{\n  "profiles": {}\n}\n');
  return file;
}

describe("/profile-add", () => {
  it("preserves wizard flow and final-selection stacking through creation, persistence, and activation", async () => {
    const configPath = temporaryConfig();
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const harness = createExtensionHarness({
      // Select an allow ruleset before its deny counterpart and the complete
      // default profile. Final wizard selection must win the tied rule.
      customResults: [
        "ruleset:deps-mutations-allow",
        "ruleset:deps-mutations-guard",
        "builtin:default",
        "Done",
        "transform:deny-asks",
        "⛔️ .env",
        "✅ **/credentials/**",
      ],
      selectResults: ["Add another protected path", "Continue"],
      confirm: true,
      // A blank optional emoji uses the custom profile default.
      inputResults: ["local-test-work", "Local test work", ""],
    });
    await harness.start();

    await harness.runCommand("profile-add");

    const raw = loadRawProfileConfig(configPath);
    expect(raw?.profiles["local-test-work"]).toMatchObject({
      description: "Local test work",
      emoji: "💅",
      color: "magenta",
      // The persisted order is the wizard selection order; later entries win
      // equal-specificity composition ties.
      extends: [
        "ruleset:deps-mutations-allow",
        "ruleset:deps-mutations-guard",
        "builtin:default",
      ],
      transforms: ["transform:deny-asks"],
      sandbox: { network: "deny" },
      protectedPathRules: [
        { pattern: ".env", decision: "deny" },
        { pattern: "**/credentials/**", decision: "allow" },
      ],
    });
    expect(fs.readFileSync(configPath, "utf8")).toContain(
      "// Keep user comments",
    );

    const resolved = loadProfileConfig(policyConfig, configPath);
    expect(
      decideBash("npm install example", resolved.profiles["local-test-work"]),
    ).toBe("deny");
    const compositionPreview = harness.customComponents[3]
      ?.render(80)
      .join("\n");
    expect(compositionPreview).toMatch(/1\. .*builtin:default/);
    expect(compositionPreview).toMatch(/2\. .*ruleset:deps-mutations-guard/);
    expect(compositionPreview).toContain(
      "Default general-purpose main session",
    );
    // The rendered stack, persisted extends order, and effective rule winner
    // above are deliberately all checked: reversing one cannot silently drift
    // from the UI contract.
    expect(compositionPreview.indexOf("builtin:default")).toBeLessThan(
      compositionPreview.indexOf("ruleset:deps-mutations-guard"),
    );
    expect(
      compositionPreview.indexOf("ruleset:deps-mutations-guard"),
    ).toBeLessThan(compositionPreview.indexOf("ruleset:deps-mutations-allow"));
    const transformPicker = harness.customComponents[4]?.render(80).join("\n");
    expect(transformPicker).toContain("Turn every ask decision into deny.");
    const secondProtectedPathModal = harness.customComponents[6]
      ?.render(80)
      .join("\n");
    expect(secondProtectedPathModal).toContain("Rules added so far:");
    expect(secondProtectedPathModal).toContain("1. ✅ **/credentials/**");
    expect(secondProtectedPathModal).toContain("2. ⛔️ .env");
    const protectedRuleLines = secondProtectedPathModal.split("\n");
    expect(
      protectedRuleLines.findIndex((line) =>
        line.includes("1. ✅ **/credentials/**"),
      ),
    ).toBeLessThan(
      protectedRuleLines.findIndex((line) => line.includes("2. ⛔️ .env")),
    );

    expect(harness.entries.at(-1)).toMatchObject({
      customType: "pi-guard-profile",
      data: { profile: "local-test-work" },
    });
    expect(harness.ui.notify).toHaveBeenLastCalledWith(
      "Created and activated profile: local-test-work",
      "info",
    );
  });

  it("does not modify configuration when composition is cancelled", async () => {
    const configPath = temporaryConfig();
    const before = fs.readFileSync(configPath, "utf8");
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const harness = createExtensionHarness({ customResults: [null] });
    await harness.start();

    await harness.runCommand("profile-add");

    expect(fs.readFileSync(configPath, "utf8")).toBe(before);
    expect(harness.ui.notify).toHaveBeenLastCalledWith(
      "Profile creation cancelled: choose at least one base.",
      "warning",
    );
  });
});
