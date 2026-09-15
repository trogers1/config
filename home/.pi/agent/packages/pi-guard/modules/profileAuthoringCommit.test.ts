import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse } from "jsonc-parser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { policyConfig } from "./policy";
import { parseOrThrow, profileConfigFileSchema } from "./policyHelpers";
import {
  createProfileAuthoringDraft,
  createProfileEditDraft,
  type ProfileAuthoringDraft,
} from "./profileAuthoringModel";
import {
  applyProfileAuthoringCommit,
  loadProfileConfigSnapshot,
  ProfileAuthoringValidationError,
  validateProfileAuthoringCommit,
  type RawProfileConfig,
} from "./profileConfig";

const fixture = {
  createName: "default-project",
  editName: "renamed-project",
  startupCwd: "/workspace/project",
  activeProfile: "builtin:default",
  retainedComment: "// retained composition entry",
} as const;
const temporaryDirectories: string[] = [];

function temporaryConfig({ source }: { readonly source: string }): string {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-guard-authoring-commit-"),
  );
  temporaryDirectories.push(directory);
  const configPath = path.join(directory, "profiles.jsonc");
  fs.writeFileSync(configPath, source);
  return configPath;
}

function rawConfig({
  configPath,
}: {
  readonly configPath: string;
}): RawProfileConfig {
  return parseOrThrow({
    unverifiedData: parse(fs.readFileSync(configPath, "utf8")),
    schema: profileConfigFileSchema,
    message: "Expected a profile config",
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

describe("shared profile authoring commit", () => {
  it("creates the exact raw draft without the legacy forced color", () => {
    const configPath = temporaryConfig({ source: '{\n  "profiles": {}\n}\n' });
    const snapshot = loadProfileConfigSnapshot(policyConfig, configPath);
    const initial = createProfileAuthoringDraft({
      activeProfile: fixture.activeProfile,
      startupCwd: fixture.startupCwd,
      existingNames: new Set(),
    });
    const draft: ProfileAuthoringDraft = {
      ...initial,
      definition: {
        ...initial.definition,
        description: "Project profile.",
      },
    };

    applyProfileAuthoringCommit({
      fallback: policyConfig,
      draft,
      configPath,
      expectedRevision: snapshot.sourceRevision,
    });

    expect(rawConfig({ configPath }).profiles[fixture.createName]).toEqual(
      draft.definition,
    );
    expect(rawConfig({ configPath }).profiles[fixture.createName].color).toBe(
      undefined,
    );
  });

  it("renames and rewrites the complete raw declaration in one preserved document", () => {
    const configPath = temporaryConfig({
      source: `{
  "defaultProfile": "${fixture.createName}",
  "profiles": {
    "${fixture.createName}": {
      "description": "Before.",
      "emoji": "🧰",
      "color": "cyan",
      "extends": [
        "builtin:default", ${fixture.retainedComment}
        "ruleset:git"
      ],
      "transforms": [],
      "tools": {
        "deploy": [{ "decision": "deny", "match": { "environment": "prod" } }],
        "bash": []
      },
      "protectedPathRules": []
    },
    "child": {
      "description": "Child.",
      "extends": ["${fixture.createName}", "${fixture.createName}"]
    }
  }
}
`,
    });
    const snapshot = loadProfileConfigSnapshot(policyConfig, configPath);
    const definition = snapshot.raw?.profiles[fixture.createName];
    if (!definition) throw new Error("missing edit fixture");
    const initial = createProfileEditDraft({
      name: fixture.createName,
      definition,
    });
    const draft: ProfileAuthoringDraft = {
      ...initial,
      name: fixture.editName,
      definition: {
        ...initial.definition,
        description: "After.",
        emoji: undefined,
        color: undefined,
        extends: ["ruleset:git", "builtin:default", "ruleset:git"],
        transforms: ["transform:deny-asks", "transform:deny-asks"],
      },
    };

    applyProfileAuthoringCommit({
      fallback: policyConfig,
      draft,
      configPath,
      expectedRevision: snapshot.sourceRevision,
    });

    const source = fs.readFileSync(configPath, "utf8");
    const raw = rawConfig({ configPath });
    expect(source).toContain(fixture.retainedComment);
    expect(raw.defaultProfile).toBe(fixture.editName);
    expect(raw.profiles[fixture.editName]).toEqual(draft.definition);
    expect(raw.profiles.child.extends).toEqual([
      fixture.editName,
      fixture.editName,
    ]);
    expect(raw.profiles[fixture.editName].tools?.deploy).toEqual(
      definition.tools?.deploy,
    );
  });

  it("collects typed issues from every independently invalid section", () => {
    const source = '{\n  "profiles": {}\n}\n';
    const configPath = temporaryConfig({ source });
    const initial = createProfileAuthoringDraft({
      activeProfile: fixture.activeProfile,
      startupCwd: fixture.startupCwd,
      existingNames: new Set(),
    });
    const draft: ProfileAuthoringDraft = {
      ...initial,
      definition: {
        ...initial.definition,
        description: "Invalid multi-section profile.",
        promptFile: "relative-prompt.md",
        tools: {
          bash: [
            { pattern: "echo overlap", decision: "allow" },
            { pattern: "echo overlap", decision: "deny" },
          ],
        },
        readPaths: [
          { pattern: "shared.txt", decision: "allow", contexts: ["read"] },
          { pattern: "shared.txt", decision: "deny", contexts: ["read"] },
        ],
        directoryGlobs: ["relative/**"],
      },
    };
    const write = vi.spyOn(fs, "writeFileSync");

    let caught: unknown;
    try {
      validateProfileAuthoringCommit({
        fallback: policyConfig,
        draft,
        configPath,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ProfileAuthoringValidationError);
    if (!(caught instanceof ProfileAuthoringValidationError))
      throw new Error("Expected typed authoring validation error");
    expect(
      caught.issues.map(({ section, code }) => ({ section, code })),
    ).toEqual([
      { section: "prompt", code: "invalid-prompt-file" },
      { section: "bash", code: "overlapping-rules" },
      { section: "read", code: "overlapping-rules" },
      { section: "directoryGlobs", code: "invalid-directory-globs" },
    ]);
    expect(write).not.toHaveBeenCalled();
    expect(fs.readFileSync(configPath, "utf8")).toBe(source);
  });

  it("rolls back a newly created prompt when config replacement fails", () => {
    const configPath = temporaryConfig({ source: '{\n  "profiles": {}\n}\n' });
    const promptPath = path.join(path.dirname(configPath), "prompt.md");
    const initial = createProfileAuthoringDraft({
      activeProfile: fixture.activeProfile,
      startupCwd: fixture.startupCwd,
      existingNames: new Set(),
    });
    const draft: ProfileAuthoringDraft = {
      ...initial,
      definition: {
        ...initial.definition,
        description: "Prompt profile.",
        promptFile: promptPath,
      },
    };
    const replacementError = new Error("replacement failed");
    vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw replacementError;
    });

    expect(() =>
      applyProfileAuthoringCommit({
        fallback: policyConfig,
        draft,
        configPath,
      }),
    ).toThrow(replacementError);
    expect(fs.existsSync(promptPath)).toBe(false);
  });
});
