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

function assertNoAuthoringArtifacts({
  configPath,
}: {
  readonly configPath: string;
}): void {
  const directory = path.dirname(configPath);
  const lockPath = `${configPath}.lock`;
  expect(fs.existsSync(lockPath)).toBe(false);
  expect(
    fs
      .readdirSync(directory)
      .filter((entry) => entry.startsWith(`${path.basename(lockPath)}.owner-`)),
  ).toEqual([]);
  expect(
    fs
      .readdirSync(directory)
      .filter(
        (entry) =>
          entry.startsWith(`.${path.basename(configPath)}.`) &&
          entry.endsWith(".tmp"),
      ),
  ).toEqual([]);
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
    const snapshot = loadProfileConfigSnapshot({
      fallback: policyConfig,
      configPath: configPath,
    });
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
    const snapshot = loadProfileConfigSnapshot({
      fallback: policyConfig,
      configPath: configPath,
    });
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

  it("preserves a pre-existing prompt when config replacement fails", () => {
    const configPath = temporaryConfig({ source: '{\n  "profiles": {}\n}\n' });
    const promptPath = path.join(
      path.dirname(configPath),
      "existing-prompt.md",
    );
    const content = "keep existing prompt";
    fs.writeFileSync(promptPath, content);
    const promptInode = fs.lstatSync(promptPath).ino;
    const initial = createProfileAuthoringDraft({
      activeProfile: fixture.activeProfile,
      startupCwd: fixture.startupCwd,
      existingNames: new Set(),
    });
    const draft: ProfileAuthoringDraft = {
      ...initial,
      definition: {
        ...initial.definition,
        description: "Prompt.",
        promptFile: promptPath,
      },
    };
    const rename = vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw new Error("replacement failed");
    });
    try {
      expect(() =>
        applyProfileAuthoringCommit({
          fallback: policyConfig,
          draft,
          configPath,
        }),
      ).toThrow("replacement failed");
    } finally {
      rename.mockRestore();
    }
    expect(fs.readFileSync(promptPath, "utf8")).toBe(content);
    expect(fs.lstatSync(promptPath).ino).toBe(promptInode);
    assertNoAuthoringArtifacts({ configPath });
    expect(fs.readdirSync(path.dirname(configPath)).sort()).toEqual([
      "existing-prompt.md",
      "profiles.jsonc",
    ]);
  });

  it("preserves a created prompt modified before config rollback", () => {
    const configPath = temporaryConfig({ source: '{\n  "profiles": {}\n}\n' });
    const promptPath = path.join(
      path.dirname(configPath),
      "modified-prompt.md",
    );
    const initial = createProfileAuthoringDraft({
      activeProfile: fixture.activeProfile,
      startupCwd: fixture.startupCwd,
      existingNames: new Set(),
    });
    const draft: ProfileAuthoringDraft = {
      ...initial,
      definition: {
        ...initial.definition,
        description: "Prompt.",
        promptFile: promptPath,
      },
    };
    let createdPromptInode: number | undefined;
    const rename = vi.spyOn(fs, "renameSync").mockImplementation(() => {
      createdPromptInode = fs.lstatSync(promptPath).ino;
      fs.writeFileSync(promptPath, "concurrent prompt edit");
      throw new Error("replacement failed");
    });
    try {
      expect(() =>
        applyProfileAuthoringCommit({
          fallback: policyConfig,
          draft,
          configPath,
        }),
      ).toThrow("replacement failed");
    } finally {
      rename.mockRestore();
    }
    expect(fs.readFileSync(promptPath, "utf8")).toBe("concurrent prompt edit");
    expect(fs.lstatSync(promptPath).ino).toBe(createdPromptInode);
    assertNoAuthoringArtifacts({ configPath });
    expect(fs.readdirSync(path.dirname(configPath)).sort()).toEqual([
      "modified-prompt.md",
      "profiles.jsonc",
    ]);
  });

  it("preserves an inode-replaced prompt when config replacement fails", () => {
    const configPath = temporaryConfig({ source: '{\n  "profiles": {}\n}\n' });
    const promptPath = path.join(
      path.dirname(configPath),
      "replaced-prompt.md",
    );
    const initial = createProfileAuthoringDraft({
      activeProfile: fixture.activeProfile,
      startupCwd: fixture.startupCwd,
      existingNames: new Set(),
    });
    const draft: ProfileAuthoringDraft = {
      ...initial,
      definition: {
        ...initial.definition,
        description: "Prompt.",
        promptFile: promptPath,
      },
    };
    let createdPromptInode: number | undefined;
    let replacementPromptInode: number | undefined;
    const rename = vi.spyOn(fs, "renameSync").mockImplementation(() => {
      createdPromptInode = fs.lstatSync(promptPath).ino;
      fs.unlinkSync(promptPath);
      fs.writeFileSync(promptPath, "replacement inode");
      replacementPromptInode = fs.lstatSync(promptPath).ino;
      throw new Error("replacement failed");
    });
    try {
      expect(() =>
        applyProfileAuthoringCommit({
          fallback: policyConfig,
          draft,
          configPath,
        }),
      ).toThrow("replacement failed");
    } finally {
      rename.mockRestore();
    }
    expect(fs.readFileSync(promptPath, "utf8")).toBe("replacement inode");
    expect(fs.lstatSync(promptPath).ino).toBe(replacementPromptInode);
    expect(replacementPromptInode).not.toBe(createdPromptInode);
    assertNoAuthoringArtifacts({ configPath });
    expect(fs.readdirSync(path.dirname(configPath)).sort()).toEqual([
      "profiles.jsonc",
      "replaced-prompt.md",
    ]);
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
    assertNoAuthoringArtifacts({ configPath });
    expect(fs.readdirSync(path.dirname(configPath))).toEqual([
      "profiles.jsonc",
    ]);
  });
});
