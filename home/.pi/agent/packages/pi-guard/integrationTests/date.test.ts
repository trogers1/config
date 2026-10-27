import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createExtensionHarness } from "./support/extensionHarness";

const missingConfig = path.resolve(
  "integrationTests/fixtures/does-not-exist.jsonc",
);

afterEach(() => vi.unstubAllEnvs());

describe.each(["builtin:default", "builtin:read-only"])(
  "%s date permissions",
  (profile) => {
    it("allows static current-time displays through the Bash permission gate", async () => {
      vi.stubEnv("PI_GUARD_PROFILE_CONFIG", missingConfig);
      vi.stubEnv("PI_SUBAGENT_PROFILE", profile);
      const harness = createExtensionHarness({ confirm: false });
      await harness.start();
      try {
        for (const command of [
          "date",
          "date -u",
          "date '+%Y-%m-%dT%H:%M:%SZ'",
          "date -u '+%Y-%m-%dT%H:%M:%SZ'",
          'date -u "+%Y/%m/%d %H:%M:%S"',
          "date -u +%s",
          "date -u '+'",
          "date '-u' '+%s'",
          "date -u +%s && pwd",
          "date '+*'",
          'date -u "+?"',
          "date '+[ab]'",
          "date -u '+*/secret'",
          "date +\\*",
          "date -u +\\?",
          "date +\\[ab]",
          "date -u +\\*/secret",
        ]) {
          harness.ui.custom.mockClear();
          expect(
            await harness.callTool({ toolName: "bash", input: { command } }),
            command,
          ).toBeUndefined();
          expect(harness.ui.custom, command).not.toHaveBeenCalled();
        }
      } finally {
        await harness.shutdown();
      }
    });

    it("does not auto-allow setting, file input, extra options, or dynamic arguments", async () => {
      vi.stubEnv("PI_GUARD_PROFILE_CONFIG", missingConfig);
      vi.stubEnv("PI_SUBAGENT_PROFILE", profile);
      const harness = createExtensionHarness({ confirm: false });
      await harness.start();
      try {
        for (const command of [
          "date -s '2026-07-01'",
          "date --set '2026-07-01'",
          "date --set=2026-07-01",
          "date -u -s '2026-07-01'",
          "date -us '2026-07-01'",
          "date -u --set=2026-07-01",
          "date 070112002026",
          "date -u 070112002026",
          "date -f dates.txt",
          "date -u -f dates.txt",
          "date -u --file=dates.txt",
          "date -u +%s -s '2026-07-01'",
          "date -u '+%s' 070112002026",
          "date -u '+%s' --set=2026-07-01",
          "date -u '+%s' '+%Y'",
          "date -u --unknown",
          "date +*",
          "date -u +?",
          "date +[ab]",
          "date -u +*/secret",
          "date +'*'?",
          "date +\\\\*",
          "date -u +$FORMAT",
          'date -u "+${FORMAT}"',
          "date -u '+%s' && untrusted-command",
          'date -u "+$(untrusted-command)"',
        ]) {
          harness.ui.custom.mockClear();
          expect(
            await harness.callTool({ toolName: "bash", input: { command } }),
            command,
          ).toMatchObject({ block: true });
          if (profile === "builtin:default") {
            expect(harness.ui.custom, command).toHaveBeenCalled();
          } else {
            expect(harness.ui.custom, command).not.toHaveBeenCalled();
          }
        }
      } finally {
        await harness.shutdown();
      }
    });
  },
);
