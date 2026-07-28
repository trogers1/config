import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import decisionTable from "./fixtures/decision-table.json";
import { createExtensionHarness } from "./support/extensionHarness";

type Decision = "allow" | "ask" | "deny";

type DecisionTableRow = {
  command: string;
  expected: Record<string, Decision>;
};

const typedTable = decisionTable as DecisionTableRow[];
const profiles = Object.keys(typedTable[0].expected);

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

    it.each(typedTable)("$command", async ({ command, expected }) => {
      harness.ui.confirm.mockClear();

      const result = await harness.callTool({
        toolName: "bash",
        input: { command },
      });

      switch (expected[profile]) {
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
