import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import decisionTable from "./fixtures/decision-table.json";
import { createExtensionHarness } from "./support/extensionHarness";
import { builtinProfileNames } from "../modules/policyHelpers";
import { postureEnvironmentVariable, postureNames } from "../modules/posture";

type Decision = "allow" | "ask" | "deny";

type DecisionTableRow = {
  command: string;
  expected: Partial<Record<(typeof builtinProfileNames)[number], Decision>>;
};

const typedTable = decisionTable as DecisionTableRow[];
const profiles = builtinProfileNames;

const missingProfileConfigPath = path.resolve(
  "integrationTests/fixtures/does-not-exist.jsonc",
);

// The decision table is the plan's migration witness: it must observe
// decisions the way the agent experiences them — through the extension
// harness (session start, profile selection, tool_call gating), not by
// calling the resolver directly. Mapping for an interactive harness with
// confirmations declined:
//   allow → no block, no prompt
//   ask   → block, ui.confirm invoked
//   deny  → block, no prompt
describe("decision table", () => {
  it("contains an expectation for every shipped builtin profile", () => {
    const coveredProfiles = new Set(
      typedTable.flatMap((row) => Object.keys(row.expected)),
    );
    expect(coveredProfiles).toEqual(new Set(builtinProfileNames));
  });

  it("pins every command against every shipped builtin profile", () => {
    const expectedProfiles = new Set<string>(builtinProfileNames);

    for (const row of typedTable) {
      expect(
        new Set(Object.keys(row.expected)),
        `Incomplete decision-table row for command: ${row.command}`,
      ).toEqual(expectedProfiles);
    }
  });

  describe.each(profiles)("%s", (profile) => {
    let harness: ReturnType<typeof createExtensionHarness>;

    beforeAll(async () => {
      process.env.PI_GUARD_PROFILE_CONFIG = missingProfileConfigPath;
      process.env.PI_SUBAGENT_PROFILE = profile;
      delete process.env.PI_SUBAGENT_PERMISSIBLE_GLOBS;
      harness = createExtensionHarness({ confirm: false });
      await harness.start();
    });

    afterAll(async () => {
      await harness.shutdown();
      delete process.env.PI_GUARD_PROFILE_CONFIG;
      delete process.env.PI_SUBAGENT_PROFILE;
    });

    it.each(
      typedTable.filter(
        (row) => expectedForProfile(row, profile) !== undefined,
      ),
    )("$command", async ({ command, expected }) => {
      harness.ui.custom.mockClear();
      const decision = expectedForProfile({ command, expected }, profile);
      if (!decision)
        throw new Error(`Missing decision-table expectation for ${profile}`);

      const result = await harness.callTool({
        toolName: "bash",
        input: { command },
      });

      switch (decision) {
        case "allow":
          expect(result).toBeUndefined();
          expect(harness.ui.custom).not.toHaveBeenCalled();
          break;
        case "ask":
          expect(result).toMatchObject({ block: true });
          expect(harness.ui.custom).toHaveBeenCalledOnce();
          expect(
            harness.customComponents.at(-1)?.render?.(160).join("\n"),
          ).toContain(command);
          break;
        case "deny":
          expect(result).toMatchObject({ block: true });
          expect(harness.ui.custom).not.toHaveBeenCalled();
          break;
      }
    });
  });
});

// The posture safety net: a session posture resolves every ASK left after
// composition at the permission gate, and changes nothing composition
// decided. An ASK path that bypassed the gate would open a prompt here or
// resolve differently from the posture, and fail.
describe.each(postureNames)(
  "decision table under the %s posture",
  (posture) => {
    describe.each(profiles)("%s", (profile) => {
      let harness: ReturnType<typeof createExtensionHarness>;

      beforeAll(async () => {
        process.env.PI_GUARD_PROFILE_CONFIG = missingProfileConfigPath;
        process.env.PI_SUBAGENT_PROFILE = profile;
        process.env[postureEnvironmentVariable] = posture;
        delete process.env.PI_SUBAGENT_PERMISSIBLE_GLOBS;
        harness = createExtensionHarness({ confirm: false });
        await harness.start();
      });

      afterAll(async () => {
        await harness.shutdown();
        delete process.env.PI_GUARD_PROFILE_CONFIG;
        delete process.env.PI_SUBAGENT_PROFILE;
        delete process.env[postureEnvironmentVariable];
      });

      it.each(
        typedTable.filter(
          (row) => expectedForProfile(row, profile) !== undefined,
        ),
      )("$command", async ({ command, expected }) => {
        harness.ui.custom.mockClear();
        const composed = expectedForProfile({ command, expected }, profile);
        if (!composed)
          throw new Error(`Missing decision-table expectation for ${profile}`);

        const result = await harness.callTool({
          toolName: "bash",
          input: { command },
        });

        expect(harness.ui.custom).not.toHaveBeenCalled();
        if ((composed === "ask" ? posture : composed) === "allow")
          expect(result).toBeUndefined();
        else expect(result).toMatchObject({ block: true });
      });
    });
  },
);

function expectedForProfile(
  row: DecisionTableRow,
  profile: (typeof builtinProfileNames)[number],
): Decision | undefined {
  return row.expected[profile];
}
