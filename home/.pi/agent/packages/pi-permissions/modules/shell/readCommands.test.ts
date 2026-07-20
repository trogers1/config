import { describe, expect, it } from "vitest";
import { splitShellCommands } from "./parse";
import { parseReadCommand, validateReadCommands } from "./readCommands";

describe("shell read commands", () => {
  it("collects concrete file operands", () => {
    expect(parseReadCommand("head -n 20 README.md")).toEqual({
      status: "safe",
      paths: ["README.md"],
    });
    expect(parseReadCommand("sed -n '1,20p' src/example.ts")).toEqual({
      status: "safe",
      paths: ["src/example.ts"],
    });
  });

  it("rejects dynamic and ambiguous composition", () => {
    for (const command of [
      'cat "$file"',
      "find . -type f | xargs cat",
      "bash -c 'cat README.md'",
      'for file in *; do cat "$file"; done',
    ]) {
      expect(
        validateReadCommands(command, splitShellCommands(command)),
      ).toBeDefined();
    }
  });

  it("accepts supported concrete readers", () => {
    const command = "cat README.md && tail -n 5 CHANGELOG.md";
    expect(
      validateReadCommands(command, splitShellCommands(command)),
    ).toBeUndefined();
  });
});
