import { describe, expect, it } from "vitest";
import { filterProfiles, formatProfileName, fuzzyScore } from "./index";

const profiles = [
  {
    name: "builtin:default",
    description: "General-purpose main session with guarded shell.",
  },
  {
    name: "builtin:read-only",
    description: "Inspection tools only; writes are restricted.",
  },
  {
    name: "builtin:reviewer",
    description: "Read-only review posture with test and build commands.",
  },
];

describe("profile picker search", () => {
  it("renders configured profile emoji and color", () => {
    expect(
      formatProfileName({
        name: "builtin:read-only",
        description: "",
        emoji: "🔎",
        color: "green",
      }),
    ).toBe("\x1b[32m🔎 builtin:read-only\x1b[0m");
  });

  it("matches a case-insensitive subsequence", () => {
    expect(fuzzyScore("rdo", "builtin:read-only")).toBeTypeOf("number");
    expect(fuzzyScore("xyz", "builtin:read-only")).toBeUndefined();
  });

  it("searches descriptions as well as profile names", () => {
    expect(
      filterProfiles(profiles, "inspection").map((profile) => profile.name),
    ).toEqual(["builtin:read-only"]);
  });

  it("ranks a name match above an equally matching description", () => {
    expect(filterProfiles(profiles, "review")[0]?.name).toBe(
      "builtin:reviewer",
    );
  });
});
