import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import decisionTable from "./fixtures/decision-table.json";
import { createExtensionHarness } from "./support/extensionHarness";
import { builtinProfileNames } from "../modules/policyHelpers";

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
      process.env.PI_PERMISSIONS_PROFILE_CONFIG = missingProfileConfigPath;
      process.env.PI_SUBAGENT_PROFILE = profile;
      delete process.env.PI_SUBAGENT_PERMISSIBLE_GLOBS;
      harness = createExtensionHarness({ confirm: false });
      await harness.start();
    });

    afterAll(async () => {
      await harness.shutdown();
      delete process.env.PI_PERMISSIONS_PROFILE_CONFIG;
      delete process.env.PI_SUBAGENT_PROFILE;
    });

    it.each(
      typedTable.filter(
        (row) => expectedForProfile(row, profile) !== undefined,
      ),
    )("$command", async ({ command, expected }) => {
      harness.ui.confirm.mockClear();
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
          expect(harness.ui.confirm).not.toHaveBeenCalled();
          break;
        case "ask":
          expect(result).toMatchObject({ block: true });
          expect(harness.ui.confirm).toHaveBeenCalledWith(
            "Allow bash command?",
            expect.stringContaining(command),
          );
          break;
        case "deny":
          expect(result).toMatchObject({ block: true });
          expect(harness.ui.confirm).not.toHaveBeenCalled();
          break;
      }
    });
  });
});

function expectedForProfile(
  row: DecisionTableRow,
  profile: (typeof builtinProfileNames)[number],
): Decision | undefined {
  return row.expected[profile];
}
