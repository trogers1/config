import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createExtensionHarness } from "./support/extensionHarness";

const missingConfig = path.resolve(
  "integrationTests/fixtures/does-not-exist.jsonc",
);

afterEach(() => vi.unstubAllEnvs());

describe.each(["builtin:default", "builtin:read-only"])(
  "%s Git hashing permissions",
  (profile) => {
    it("allows the fixed form and checks protected files after option-looking filenames", async () => {
      vi.stubEnv("PI_GUARD_PROFILE_CONFIG", missingConfig);
      vi.stubEnv("PI_SUBAGENT_PROFILE", profile);
      const harness = createExtensionHarness({ confirm: false });
      await harness.start();
      try {
        await expect(
          harness.callToolWithoutPrompt({
            toolName: "bash",
            input: {
              command: "git hash-object --no-filters -- handoff.md progress.md",
            },
          }),
        ).resolves.toBeUndefined();

        // After --, these are filenames, not options consuming the next word.
        for (const filename of ["-c", "--format"]) {
          await expect(
            harness.callTool({
              toolName: "bash",
              input: {
                command: `git hash-object --no-filters -- ${filename} .env`,
              },
            }),
          ).resolves.toMatchObject({ block: true });
        }
      } finally {
        await harness.shutdown();
      }
    });

    it("preserves delegated scope after option-looking filenames", async () => {
      vi.stubEnv("PI_GUARD_PROFILE_CONFIG", missingConfig);
      vi.stubEnv("PI_SUBAGENT_PROFILE", profile);
      vi.stubEnv("PI_SUBAGENT_PERMISSIBLE_GLOBS", "handoff.md,-c,--format");
      const harness = createExtensionHarness({ confirm: false });
      await harness.start();
      try {
        for (const filename of ["-c", "--format"]) {
          const result = await harness.callTool({
            toolName: "bash",
            input: {
              command: `git hash-object --no-filters -- ${filename} ../outside/file`,
            },
          });
          expect(result).toMatchObject({ block: true });
          expect(result?.reason).toContain("PI_SUBAGENT_PERMISSIBLE_GLOBS");
        }
      } finally {
        await harness.shutdown();
      }
    });
  },
);
