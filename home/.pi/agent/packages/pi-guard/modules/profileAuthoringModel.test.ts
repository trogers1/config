import { describe, expect, it } from "vitest";
import type { ProfileConfigProfile } from "./policyHelpers";
import {
  createProfileAuthoringDraft,
  createProfileEditDraft,
  decodePromptAuthoring,
  defaultCustomProfileEmoji,
  profileAuthoringDraftIsDirty,
  profileAuthoringSectionIds,
  serializePromptAuthoring,
  suggestedProfileName,
} from "./profileAuthoringModel";

const fixture = {
  activeProfile: "builtin:default",
  startupCwd: "/workspace/client-app",
  baseName: "default-client-app",
} as const;

describe("profile authoring model", () => {
  it("keeps the synchronized section order", () => {
    expect(profileAuthoringSectionIds).toEqual([
      "general",
      "prompt",
      "composition",
      "transforms",
      "bash",
      "read",
      "write",
      "protected",
      "sandbox",
      "directoryGlobs",
    ]);
  });

  it("reuses the active-profile and startup-directory name suggestion", () => {
    expect(
      suggestedProfileName({
        profile: fixture.activeProfile,
        cwd: fixture.startupCwd,
        existingNames: new Set([fixture.baseName, `${fixture.baseName}-2`]),
      }),
    ).toBe(`${fixture.baseName}-3`);
  });

  it("initializes CREATE as one raw declaration draft", () => {
    const draft = createProfileAuthoringDraft({
      activeProfile: fixture.activeProfile,
      startupCwd: fixture.startupCwd,
      existingNames: new Set(),
    });

    expect(draft).toEqual({
      mode: "create",
      name: fixture.baseName,
      definition: {
        description: "",
        emoji: defaultCustomProfileEmoji,
        extends: [fixture.activeProfile],
        directoryGlobs: [fixture.startupCwd],
      },
    });
    expect(profileAuthoringDraftIsDirty({ draft, initial: draft })).toBe(true);
  });

  it("copies exact EDIT raw state and detects semantic draft changes", () => {
    const definition: ProfileConfigProfile = {
      description: "Existing profile.",
      promptFile: null,
      extends: [fixture.activeProfile, fixture.activeProfile],
      transforms: [],
      protectedPathRules: [],
    };
    const initial = createProfileEditDraft({
      name: fixture.baseName,
      definition,
    });
    const changed = {
      ...initial,
      definition: { ...initial.definition, description: "Changed." },
    };

    expect(initial.definition).toEqual(definition);
    expect(initial.definition).not.toBe(definition);
    expect(profileAuthoringDraftIsDirty({ draft: initial, initial })).toBe(
      false,
    );
    expect(profileAuthoringDraftIsDirty({ draft: changed, initial })).toBe(
      true,
    );
  });

  it("preserves Prompt omission, null, and file as distinct raw states", () => {
    const promptPath = "/tmp/profile-prompt.md";
    const values = [
      { mode: "inherit" },
      { mode: "disable" },
      { mode: "file", path: promptPath },
    ] as const;

    expect(values.map((value) => serializePromptAuthoring({ value }))).toEqual([
      undefined,
      null,
      promptPath,
    ]);
    expect(
      [undefined, null, promptPath].map((promptFile) =>
        decodePromptAuthoring({ promptFile }),
      ),
    ).toEqual(values);
  });
});
