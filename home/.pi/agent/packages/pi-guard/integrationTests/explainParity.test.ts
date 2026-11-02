import { describe, expect, it, vi } from "vitest";
import type { ProfileConfigFile } from "../modules/policyHelpers";
import { PERMISSION_BLOCK_PREFIX } from "../extensions/guard";
import { postureEnvironmentVariable, postureNames } from "../modules/posture";
import {
  createExtensionHarness,
  lastCallArgument,
} from "./support/extensionHarness";
import {
  installProfileUpdateFixture,
  writeConfig,
} from "./support/profileUpdateTestSupport";

installProfileUpdateFixture({});

const config = {
  defaultProfile: "plain",
  profiles: {
    plain: {
      description: "Parity fixture rules",
      extends: ["builtin:default"],
      sandbox: false,
      tools: {
        bash: [
          { pattern: "git status *", decision: "allow" },
          { pattern: "blocked-cmd *", decision: "deny" },
        ],
      },
      readPaths: [
        { pattern: "parity-ask/**", decision: "ask" },
        { pattern: "parity-deny/**", decision: "deny" },
      ],
    },
    denying: {
      description: "Parity fixture with deny-asks",
      extends: ["plain"],
      transforms: ["transform:deny-asks"],
    },
    allowing: {
      description: "Parity fixture with allow-asks",
      extends: ["plain"],
      transforms: ["transform:allow-asks"],
    },
  },
} satisfies ProfileConfigFile;

const commands = [
  // Shell parse uncertainty: a synthesized ASK.
  "git status 'unterminated",
  // A denied segment wins over parse uncertainty.
  "blocked-cmd now; git status 'unterminated",
  // A dynamic path reference: a synthesized path ASK.
  'cat "$PARITY_FILE"',
  // No command rule matches: an ordinary ASK.
  "parity-unknown-command --flag",
];

const reads = [
  // An ordinary ASK path rule.
  "parity-ask/a.txt",
  // An ordinary deny path rule.
  "parity-deny/a.txt",
  // A shipped protected-path deny.
  ".env",
];

async function explainedDecision({
  harness,
  args,
}: {
  readonly harness: ReturnType<typeof createExtensionHarness>;
  readonly args: string;
}): Promise<{
  readonly decision: string | undefined;
  readonly report: string;
}> {
  await harness.runCommand({ name: "permissions", args });
  const report = lastCallArgument({ mock: harness.ui.notify, index: 0 });
  if (typeof report !== "string")
    throw new Error("Expected /permissions explain to notify a report");
  return { decision: /Decision: (\w+)/.exec(report)?.[1], report };
}

// /permissions explain must report exactly what the gate enforces, for every
// profile ASK resolution and session posture. Without a UI, an unresolved
// ASK blocks, so explain's "ask" corresponds to a block.
describe.each(Object.keys(config.profiles))("explain parity: %s", (profile) => {
  describe.each([undefined, ...postureNames])("posture %s", (posture) => {
    it.each(commands)("%s", async (command) => {
      process.env.PI_GUARD_PROFILE_CONFIG = writeConfig({ config });
      process.env.PI_SUBAGENT_PROFILE = profile;
      vi.stubEnv(postureEnvironmentVariable, posture ?? "");
      const harness = createExtensionHarness({ hasUI: false });
      await harness.start();

      const result = await harness.callToolDecisivelyWithoutPrompt({
        toolName: "bash",
        input: { command },
      });
      const { decision: explained, report } = await explainedDecision({
        harness,
        args: `explain bash ${command}`,
      });

      expect(explained).toBeDefined();
      // A posture resolves every remaining ASK, so explain never shows one.
      if (posture !== undefined) expect(explained).not.toBe("ask");
      expect(result?.block ?? false).toBe(explained !== "allow");
      // A composed deny explains its cause, exactly as the gate reports it.
      // (A posture denial is explained by the posture note instead.)
      if (posture === undefined && explained === "deny") {
        expect(result?.block).toBe(true);
        const reason = result?.reason;
        if (
          typeof reason !== "string" ||
          !reason.startsWith(PERMISSION_BLOCK_PREFIX)
        )
          throw new Error(
            `Expected a marked gate deny reason, got ${String(reason)}`,
          );
        expect(report).toContain(
          reason.slice(PERMISSION_BLOCK_PREFIX.length).split("\n")[0],
        );
      }
    });

    it.each(reads)("read %s", async (path) => {
      process.env.PI_GUARD_PROFILE_CONFIG = writeConfig({ config });
      process.env.PI_SUBAGENT_PROFILE = profile;
      vi.stubEnv(postureEnvironmentVariable, posture ?? "");
      const harness = createExtensionHarness({ hasUI: false });
      await harness.start();

      const result = await harness.callToolDecisivelyWithoutPrompt({
        toolName: "read",
        input: { path },
      });
      const { decision } = await explainedDecision({
        harness,
        args: `explain read ${path}`,
      });

      expect(decision).toBeDefined();
      if (posture !== undefined) expect(decision).not.toBe("ask");
      expect(result?.block ?? false).toBe(decision !== "allow");
    });
  });
});
