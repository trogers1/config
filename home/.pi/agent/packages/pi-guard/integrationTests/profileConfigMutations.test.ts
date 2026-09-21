import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse } from "jsonc-parser";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyProfileAuthoringCommit,
  applyProfileRuleChanges,
  loadProfileConfig,
  loadProfileConfigSnapshot,
  loadRawProfileConfig,
  ProfileConfigConflictError,
  ProfileConfigLockTimeoutError,
  forceRemoveProfileConfigLock,
  profileConfigLockSettings,
  resolveProfileConfigPath,
  setProfileConfigLockWaitForTesting,
  validateProfileAuthoringCommit,
} from "../modules/profileConfig";
import {
  createProfileStore,
  currentProfileStoreState,
  isUsableProfileStoreState,
  profileStoreStatus,
  refreshProfileStore,
  type ProfileStoreState,
  type UsableProfileStoreState,
} from "../modules/profileStore";
import {
  createProfileAuthoringDraft,
  createProfileEditDraft,
  type ProfileAuthoringDraft,
} from "../modules/profileAuthoringModel";
import {
  decodeSandboxAuthoring,
  serializeSandboxAuthoring,
} from "../modules/profileAuthoring";
import { policyConfig } from "../modules/policy";
import {
  parseOrThrow,
  profileConfigFileSchema,
  type ProfileConfigProfile,
} from "../modules/policyHelpers";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { force: true, recursive: true });
});
function tempConfig(): string {
  const directory = fs.mkdtempSync(path.join(tmpdir(), "pi-guard-profile-"));
  directories.push(directory);
  return path.join(directory, "profiles.jsonc");
}
function isProfiles(
  value: unknown,
): value is Record<string, Record<string, unknown>> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every(
      (profile) =>
        typeof profile === "object" &&
        profile !== null &&
        !Array.isArray(profile),
    )
  );
}
function profiles(configPath: string): Record<string, Record<string, unknown>> {
  const document: unknown = parse(fs.readFileSync(configPath, "utf8"));
  if (typeof document !== "object" || document === null)
    throw new Error("document");
  const raw = "profiles" in document ? document.profiles : undefined;
  if (!isProfiles(raw)) throw new Error("profiles");
  return raw;
}
function editDraft({
  configPath,
  name,
}: {
  readonly configPath: string;
  readonly name: string;
}): Extract<ProfileAuthoringDraft, { readonly mode: "edit" }> {
  const definition = loadProfileConfigSnapshot({
    fallback: policyConfig,
    configPath: configPath,
  }).raw?.profiles[name];
  if (!definition) throw new Error(`missing profile '${name}'`);
  return createProfileEditDraft({ name, definition });
}
function commitEdit({
  configPath,
  draft,
  expectedRevision,
}: {
  readonly configPath: string;
  readonly draft: Extract<ProfileAuthoringDraft, { readonly mode: "edit" }>;
  readonly expectedRevision?: string;
}): void {
  applyProfileAuthoringCommit({
    fallback: policyConfig,
    configPath,
    draft,
    expectedRevision,
  });
}

const baseDefinition = {
  description: "Existing",
  extends: ["builtin:default"],
} satisfies ProfileConfigProfile;

const storeFixture = {
  profile: "existing",
  source: JSON.stringify({ profiles: { existing: baseDefinition } }),
} as const;

function profileStore({ configPath }: { readonly configPath: string }) {
  return createProfileStore({ fallback: policyConfig, configPath });
}

describe("profile config mutations", () => {
  it("rolls back a newly created prompt when the locked config replacement fails", () => {
    const configPath = tempConfig();
    const promptPath = path.join(path.dirname(configPath), "new-prompt.md");
    fs.writeFileSync(configPath, '{ "profiles": {} }\n');
    const initial = createProfileAuthoringDraft({
      activeProfile: "builtin:default",
      startupCwd: path.dirname(configPath),
      existingNames: new Set(),
    });
    const draft: ProfileAuthoringDraft = {
      ...initial,
      name: "prompt-rollback",
      definition: {
        ...initial.definition,
        description: "Prompt rollback profile.",
        promptFile: promptPath,
      },
    };
    const renameSync = fs.renameSync.bind(fs);
    const rename = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (to === configPath)
        throw new Error("simulated config replacement failure");
      return renameSync(from, to);
    });
    expect(() =>
      applyProfileAuthoringCommit({
        fallback: policyConfig,
        configPath,
        draft,
      }),
    ).toThrow("simulated config replacement failure");
    rename.mockRestore();
    expect(fs.existsSync(promptPath)).toBe(false);
    expect(
      loadRawProfileConfig({ configPath })?.profiles["prompt-rollback"],
    ).toBeUndefined();
  });

  it("creates profiles through an authoring draft and narrowly applies ASK rules", () => {
    const configPath = tempConfig();
    fs.writeFileSync(configPath, '// retained\n{\n  "profiles": {}\n}\n');
    const initial = createProfileAuthoringDraft({
      activeProfile: "builtin:default",
      startupCwd: "/local-work",
      existingNames: new Set(),
    });
    const draft: ProfileAuthoringDraft = {
      ...initial,
      name: "local-work",
      definition: { ...initial.definition, description: "Local work" },
    };
    applyProfileAuthoringCommit({ fallback: policyConfig, configPath, draft });
    applyProfileRuleChanges({
      fallback: policyConfig,
      configPath,
      target: { mode: "update", profile: "local-work" },
      changes: [
        { kind: "bash", pattern: "echo profile-rule", decision: "allow" },
      ],
    });
    expect(fs.readFileSync(configPath, "utf8")).toContain("// retained");
    expect(
      loadProfileConfig({ fallback: policyConfig, configPath: configPath })
        .profiles["local-work"].tools.bash,
    ).toContainEqual({
      pattern: "echo profile-rule",
      decision: "allow",
    });
  });

  it("leaves omitted declarations byte-untouched, including ASK alternatives and contexts", () => {
    const configPath = tempConfig();
    const before = `// retain\n{
  "profiles": {
    "existing": {
      "description": "Existing", "extends": ["builtin:default"],
      "tools": { "deploy": [{ "decision": "deny", "match": { "environment": "prod" } }], "bash": [{ "pattern": "npm *", "decision": "ask", "alternatives": ["npm test"] }] },
      "readPaths": [{ "pattern": "secret/**", "decision": "ask", "contexts": ["grep"], "alternatives": ["request access"] }],
      "directoryGlobs": ["/old/**"]
    }
  }
}\n`;
    fs.writeFileSync(configPath, before);
    const initial = editDraft({ configPath, name: "existing" });
    commitEdit({
      configPath,
      draft: {
        ...initial,
        definition: { ...initial.definition, sandbox: false },
      },
    });
    const raw = profiles(configPath).existing;
    expect(raw.sandbox).toBe(false);
    expect(raw.tools).toEqual({
      deploy: [{ decision: "deny", match: { environment: "prod" } }],
      bash: [{ pattern: "npm *", decision: "ask", alternatives: ["npm test"] }],
    });
    expect(raw.readPaths).toEqual([
      {
        pattern: "secret/**",
        decision: "ask",
        contexts: ["grep"],
        alternatives: ["request access"],
      },
    ]);
    expect(raw.directoryGlobs).toEqual(["/old/**"]);
    expect(fs.readFileSync(configPath, "utf8")).toContain("// retain");
  });

  it("writes candidates in exact order while retaining LCS comments", () => {
    const configPath = tempConfig();
    fs.writeFileSync(
      configPath,
      `{
  "profiles": { "existing": {
    "description": "Existing", "extends": ["builtin:default"],
    "tools": { "bash": [
      { "pattern": "A", "decision": "allow" },
      // retained B
      { "pattern": "B", "decision": "deny" }
    ] },
    "directoryGlobs": ["/work/a/**", "/work/b/**"]
  } }
}\n`,
    );
    const initial = editDraft({ configPath, name: "existing" });
    commitEdit({
      configPath,
      draft: {
        ...initial,
        definition: {
          ...initial.definition,
          tools: {
            bash: [
              { pattern: "B", decision: "deny" },
              { pattern: "C", decision: "allow" },
            ],
          },
          directoryGlobs: ["/work/b/**", "/work/c/**"],
        },
      },
    });
    expect(profiles(configPath).existing.tools).toEqual({
      bash: [
        { pattern: "B", decision: "deny" },
        { pattern: "C", decision: "allow" },
      ],
    });
    expect(profiles(configPath).existing.directoryGlobs).toEqual([
      "/work/b/**",
      "/work/c/**",
    ]);
    expect(fs.readFileSync(configPath, "utf8")).toContain("// retained B");
  });

  it("retains row and sandbox comments when a neighboring value changes", () => {
    const configPath = tempConfig();
    fs.writeFileSync(
      configPath,
      `{"profiles":{"existing":{"description":"Existing","extends":["builtin:default"],"directoryGlobs":[
// keep a
"/work/a/**",
// keep b
"/work/b/**"],"sandbox":{"network":"deny", // retain network
"allowAppleEvents":false // retain events
}}}}`,
    );
    const initial = editDraft({ configPath, name: "existing" });
    commitEdit({
      configPath,
      draft: {
        ...initial,
        definition: {
          ...initial.definition,
          directoryGlobs: ["/work/new/**", "/work/a/**", "/work/b/**"],
          sandbox: { network: "allow", allowAppleEvents: false },
        },
      },
    });
    expect(profiles(configPath).existing.directoryGlobs).toEqual([
      "/work/new/**",
      "/work/a/**",
      "/work/b/**",
    ]);
    const source = fs.readFileSync(configPath, "utf8");
    expect(source).toContain("// keep b");
    expect(source).toContain("// retain events");
  });

  it("preserves comments on unchanged rules when a neighboring rule changes", () => {
    const configPath = tempConfig();
    fs.writeFileSync(
      configPath,
      `{
  "profiles": {
    "existing": {
      "description": "Existing",
      "extends": ["builtin:default"],
      "tools": {
        "bash": [
          // retained first-rule comment
          { "pattern": "keep", "decision": "ask" },
          { "pattern": "change", "decision": "ask" }
        ]
      }
    }
  }
}\n`,
    );
    const initial = editDraft({ configPath, name: "existing" });
    commitEdit({
      configPath,
      draft: {
        ...initial,
        definition: {
          ...initial.definition,
          tools: {
            bash: [
              { pattern: "keep", decision: "ask" },
              { pattern: "changed", decision: "deny" },
            ],
          },
        },
      },
    });
    expect(fs.readFileSync(configPath, "utf8")).toContain(
      "// retained first-rule comment",
    );
    expect(profiles(configPath).existing.tools).toEqual({
      bash: [
        { pattern: "keep", decision: "ask" },
        { pattern: "changed", decision: "deny" },
      ],
    });
  });

  it("rejects protected rules that do not satisfy their stricter schema", () => {
    const configPath = tempConfig();
    const before = `{"profiles":{"existing":{"description":"Existing","extends":["builtin:default"]}}}`;
    fs.writeFileSync(configPath, before);
    const initial = editDraft({ configPath, name: "existing" });
    const protectedPathRules = [{ pattern: ".env", decision: "deny" as const }];
    Object.defineProperty(protectedPathRules[0], "decision", { value: "ask" });
    const invalid: ProfileAuthoringDraft = {
      ...initial,
      definition: {
        ...initial.definition,
        protectedPathRules,
      },
    };
    expect(() =>
      applyProfileAuthoringCommit({
        fallback: policyConfig,
        configPath,
        draft: invalid,
      }),
    ).toThrow("schema validation failed");
    expect(fs.readFileSync(configPath, "utf8")).toBe(before);
  });

  it("rejects optimistic and byte-identical stale authoring candidates without writing", () => {
    const configPath = tempConfig();
    const reviewed = `{"profiles":{"existing":{"description":"Existing","extends":["builtin:default"],"readPaths":[{"pattern":"unchanged.txt","decision":"ask","contexts":["read"]}]}}}`;
    fs.writeFileSync(configPath, reviewed);
    const initial = editDraft({ configPath, name: "existing" });
    const prepared = validateProfileAuthoringCommit({
      fallback: policyConfig,
      configPath,
      draft: initial,
    });
    expect(prepared.updated).toBe(reviewed);
    const externallyChanged = `${reviewed}\n// changed by another editor\n`;
    fs.writeFileSync(configPath, externallyChanged);
    expect(() =>
      commitEdit({
        configPath,
        draft: initial,
        expectedRevision: prepared.sourceRevision,
      }),
    ).toThrow(ProfileConfigConflictError);
    expect(fs.readFileSync(configPath, "utf8")).toBe(externallyChanged);
    expect(fs.readdirSync(path.dirname(configPath))).toEqual([
      "profiles.jsonc",
    ]);
  });

  it("rejects stale ASK rule changes without writing", () => {
    const configPath = tempConfig();
    const reviewed = `{"profiles":{"existing":{"description":"Existing","extends":["builtin:default"],"tools":{"bash":[{"pattern":"unchanged","decision":"allow"}]}}}}`;
    fs.writeFileSync(configPath, reviewed);
    const expectedRevision = loadProfileConfigSnapshot({
      fallback: policyConfig,
      configPath: configPath,
    }).sourceRevision;
    const externallyChanged = `${reviewed}\n// changed by another editor\n`;
    fs.writeFileSync(configPath, externallyChanged);
    expect(() =>
      applyProfileRuleChanges({
        fallback: policyConfig,
        configPath,
        expectedRevision,
        target: { mode: "update", profile: "existing" },
        changes: [{ kind: "bash", pattern: "unchanged", decision: "allow" }],
      }),
    ).toThrow(ProfileConfigConflictError);
    expect(fs.readFileSync(configPath, "utf8")).toBe(externallyChanged);
    expect(fs.readdirSync(path.dirname(configPath))).toEqual([
      "profiles.jsonc",
    ]);
  });

  it("rewrites complete declarations, omitting explicit fields while preserving custom siblings", () => {
    const configPath = tempConfig();
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        profiles: {
          existing: {
            ...baseDefinition,
            sandbox: { network: "deny" },
            directoryGlobs: ["/old/**"],
            tools: {
              deploy: [{ decision: "ask" }],
              bash: [{ pattern: "old", decision: "ask" }],
            },
            readPaths: [{ pattern: "x", decision: "ask", contexts: ["read"] }],
          },
        },
      }),
    );
    const initial = editDraft({ configPath, name: "existing" });
    commitEdit({
      configPath,
      draft: {
        ...initial,
        definition: {
          ...initial.definition,
          sandbox: undefined,
          directoryGlobs: undefined,
          tools: { deploy: [{ decision: "ask" }], bash: undefined },
        },
      },
    });
    const raw = profiles(configPath).existing;
    expect(raw).not.toHaveProperty("sandbox");
    expect(raw).not.toHaveProperty("directoryGlobs");
    expect(raw.tools).toEqual({ deploy: [{ decision: "ask" }] });
    expect(raw.readPaths).toEqual([
      { pattern: "x", decision: "ask", contexts: ["read"] },
    ]);
  });

  it("keeps no-op authoring commits write-free and rejects invalid candidates before artifacts", () => {
    const configPath = tempConfig();
    const before =
      '{\n  "profiles": {\n    "existing": { "description": "Existing", "extends": ["builtin:default"] }\n  }\n}\n';
    fs.writeFileSync(configPath, before);
    const initial = editDraft({ configPath, name: "existing" });
    expect(
      validateProfileAuthoringCommit({
        fallback: policyConfig,
        configPath,
        draft: initial,
      }).updated,
    ).toBe(before);
    commitEdit({ configPath, draft: initial });
    const invalid: ProfileAuthoringDraft = {
      ...initial,
      definition: { ...initial.definition, directoryGlobs: ["relative"] },
    };
    expect(() =>
      applyProfileAuthoringCommit({
        fallback: policyConfig,
        configPath,
        draft: invalid,
      }),
    ).toThrow("not-absolute");
    expect(fs.readFileSync(configPath, "utf8")).toBe(before);
    expect(fs.readdirSync(path.dirname(configPath))).toEqual([
      "profiles.jsonc",
    ]);
  });

  it("renames exact graph references while retaining declaration syntax and key position", () => {
    const configPath = tempConfig();
    fs.writeFileSync(
      configPath,
      `{
  "defaultProfile": "old\\\"name",
  "profiles": {
    // retain old declaration
    "old\\\"name": { "description": "Old", "extends": ["builtin:default"], "directoryGlobs": ["/old\\\"name/**"] },
    "child": { "description": "Child", "extends": ["builtin:default", "old\\\"name", "old\\\"name"] },
    "old\\\"name-more": { "description": "Similar parent", "extends": ["builtin:default"] }
  }
}\n`,
    );
    const initial = editDraft({ configPath, name: 'old"name' });
    commitEdit({ configPath, draft: { ...initial, name: 'new"name' } });
    const source = fs.readFileSync(configPath, "utf8");
    expect(source).toContain("// retain old declaration");
    expect(source).toContain('"new\\\"name": { "description": "Old"');
    expect(source).toContain(
      '"extends": ["builtin:default", "new\\\"name", "new\\\"name"]',
    );
    expect(source).toContain('"directoryGlobs": ["/old\\\"name/**"]');
    const document = parseOrThrow({
      unverifiedData: parse(source),
      schema: profileConfigFileSchema,
      message: "renamed profile document is invalid",
    });
    expect(document.defaultProfile).toBe('new"name');
    expect(Object.keys(document.profiles)).toEqual([
      'new"name',
      "child",
      'old"name-more',
    ]);
  });

  it("composes local metadata and declaration changes in one authoring candidate", () => {
    const configPath = tempConfig();
    fs.writeFileSync(
      configPath,
      `{"profiles":{"existing":{"description":"Existing","extends":["builtin:default"]}}}`,
    );
    const initial = editDraft({ configPath, name: "existing" });
    commitEdit({
      configPath,
      draft: {
        ...initial,
        name: "renamed",
        definition: {
          ...initial.definition,
          emoji: "🛡️",
          directoryGlobs: ["/work/**"],
        },
      },
    });
    expect(profiles(configPath).renamed).toMatchObject({
      emoji: "🛡️",
      directoryGlobs: ["/work/**"],
    });
    expect(fs.readdirSync(path.dirname(configPath))).toEqual([
      "profiles.jsonc",
    ]);
  });

  it("normalizes standalone sandbox overwrites before runtime validation", () => {
    const configPath = tempConfig();
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        profiles: {
          standalone: {
            description: "Standalone sandbox overwrite normalization profile.",
            tools: { bash: [{ pattern: "*", decision: "allow" }] },
            readPaths: [{ pattern: "*", decision: "allow" }],
            writePaths: [{ pattern: "*", decision: "allow" }],
            sandbox: {
              network: "deny",
              extraWritePaths: [],
              overwritePathArrays: ["extraWritePaths"],
            },
          },
        },
      }),
    );
    expect(
      loadProfileConfig({ fallback: policyConfig, configPath: configPath })
        .profiles.standalone.sandbox,
    ).toEqual({ network: "deny", extraWritePaths: [] });
  });

  it("refreshes changed composed snapshots and fails closed until a valid source is restored", () => {
    const configPath = tempConfig();
    fs.writeFileSync(configPath, storeFixture.source);
    const store = profileStore({ configPath });
    const initial: ProfileStoreState = refreshProfileStore({ store });
    expect(initial.status).toBe(profileStoreStatus.refreshed);
    expect(isUsableProfileStoreState({ state: initial })).toBe(true);
    const identical = refreshProfileStore({ store });
    expect(identical.status).toBe(profileStoreStatus.unchanged);

    fs.writeFileSync(
      configPath,
      JSON.stringify({
        profiles: {
          existing: {
            ...baseDefinition,
            tools: { bash: [{ pattern: "echo changed", decision: "allow" }] },
          },
        },
      }),
    );
    const changed = { state: refreshProfileStore({ store }) };
    expect(changed.state.status).toBe(profileStoreStatus.refreshed);
    if (!isUsableProfileStoreState(changed))
      throw new Error("changed snapshot was not usable");
    expect(
      changed.state.snapshot.config.profiles.existing.tools.bash,
    ).toContainEqual({
      pattern: "echo changed",
      decision: "allow",
    });

    fs.writeFileSync(configPath, "{ malformed");
    const invalid = refreshProfileStore({ store });
    expect(invalid.status).toBe(profileStoreStatus.invalid);
    expect("snapshot" in invalid).toBe(false);
    expect(
      isUsableProfileStoreState({ state: currentProfileStoreState({ store }) }),
    ).toBe(false);
    fs.rmSync(configPath);
    const missing = refreshProfileStore({ store });
    expect(missing.status).toBe(profileStoreStatus.missing);
    expect("snapshot" in missing).toBe(false);

    fs.writeFileSync(
      configPath,
      JSON.stringify({ profiles: { replacement: baseDefinition } }),
    );
    // Profile selection is intentionally outside the store. This replacement
    // snapshot must remain available so the runtime can resolve its refreshed
    // directory/default authority before validating the newly selected name.
    const replacement = refreshProfileStore({ store });
    expect(replacement.status).toBe(profileStoreStatus.refreshed);
    expect("snapshot" in replacement).toBe(true);

    fs.writeFileSync(configPath, storeFixture.source);
    const restored = refreshProfileStore({ store });
    expect(restored.status).toBe(profileStoreStatus.refreshed);
  });

  it("keeps selection authority and policy on one revision across an explicit source interleaving", () => {
    const configPath = tempConfig();
    const firstSource = JSON.stringify({
      defaultProfile: "first",
      profiles: {
        first: {
          ...baseDefinition,
          tools: { bash: [{ pattern: "echo coherent", decision: "allow" }] },
        },
      },
    });
    const secondSource = JSON.stringify({
      defaultProfile: "second",
      profiles: {
        second: {
          ...baseDefinition,
          tools: { bash: [{ pattern: "echo coherent", decision: "deny" }] },
        },
      },
    });
    fs.writeFileSync(configPath, firstSource);
    let reads = 0;

    const snapshot = loadProfileConfigSnapshot({
      fallback: policyConfig,
      configPath,
      runtime: {
        readSource: ({ configPath: requestedPath }) => {
          expect(requestedPath).toBe(configPath);
          reads++;
          // Model an external replacement at the only possible source-read
          // boundary. Snapshot fields must still all describe firstSource.
          fs.writeFileSync(configPath, secondSource);
          return firstSource;
        },
      },
    });

    expect(reads).toBe(1);
    expect(snapshot.config.defaultProfile).toBe("first");
    expect(snapshot.declarations.map(({ profile }) => profile)).toEqual([
      "first",
    ]);
    expect(snapshot.config.profiles.first.tools.bash).toContainEqual({
      pattern: "echo coherent",
      decision: "allow",
    });
    expect(snapshot.config.profiles.second).toBeUndefined();
  });

  it("proves both exported mutation entry points time out behind the public cooperative lock, then replay after release", () => {
    const configPath = tempConfig();
    const lockPath = `${configPath}${profileConfigLockSettings.suffix}`;
    fs.writeFileSync(configPath, storeFixture.source);
    const draft = {
      ...editDraft({ configPath, name: storeFixture.profile }),
      definition: {
        ...baseDefinition,
        description: "Replayed authoring",
        tools: {
          bash: [{ pattern: "echo replayed-lock", decision: "allow" }],
        },
      },
    } satisfies ProfileAuthoringDraft;
    const mutations = [
      {
        apply: () =>
          applyProfileRuleChanges({
            fallback: policyConfig,
            configPath,
            target: { mode: "update", profile: storeFixture.profile },
            changes: [
              {
                kind: "bash",
                pattern: "echo replayed-lock",
                decision: "allow",
              },
            ],
          }),
      },
      {
        apply: () =>
          applyProfileAuthoringCommit({
            fallback: policyConfig,
            configPath,
            draft,
          }),
      },
    ];
    const resetWait = setProfileConfigLockWaitForTesting({ wait: () => {} });
    try {
      for (const mutation of mutations) {
        const before = fs.readFileSync(configPath, "utf8");
        fs.writeFileSync(lockPath, JSON.stringify({ token: "public-holder" }));
        expect(mutation.apply).toThrow(ProfileConfigLockTimeoutError);
        expect(fs.readFileSync(configPath, "utf8")).toBe(before);
        fs.unlinkSync(lockPath);
        mutation.apply();
      }
    } finally {
      resetWait();
    }
    expect(profiles(configPath).existing.description).toBe(
      "Replayed authoring",
    );
    expect(profiles(configPath).existing.tools).toEqual({
      bash: [{ pattern: "echo replayed-lock", decision: "allow" }],
    });
  });

  it("fails closed when an adopted resolved-default file is deleted", () => {
    const defaultPath = resolveProfileConfigPath({});
    const existsSync = fs.existsSync.bind(fs);
    const readFileSync = fs.readFileSync.bind(fs);
    let present = true;
    const exists = vi
      .spyOn(fs, "existsSync")
      .mockImplementation((file) =>
        file === defaultPath ? present : existsSync(file),
      );
    const read = vi
      .spyOn(fs, "readFileSync")
      .mockImplementation((file, options) =>
        file === defaultPath
          ? storeFixture.source
          : readFileSync(file, options),
      );
    try {
      const store = createProfileStore({ fallback: policyConfig });
      expect(refreshProfileStore({ store }).status).toBe(
        profileStoreStatus.refreshed,
      );
      present = false;
      expect(refreshProfileStore({ store }).status).toBe(
        profileStoreStatus.missing,
      );
    } finally {
      read.mockRestore();
      exists.mockRestore();
    }
  });

  it("accepts an active built-in profile from the resolved configuration", () => {
    const configPath = tempConfig();
    fs.writeFileSync(configPath, JSON.stringify({ profiles: {} }));
    const store = createProfileStore({ fallback: policyConfig, configPath });

    const result = { state: refreshProfileStore({ store }) };
    expect(isUsableProfileStoreState(result)).toBe(true);
    if (!isUsableProfileStoreState(result))
      throw new Error("built-in profile state was not usable");
    const usableState: UsableProfileStoreState = result.state;
    expect(
      usableState.snapshot.config.profiles["builtin:default"],
    ).toBeDefined();
  });

  it("refreshes a child when an inherited parent composition changes", () => {
    const configPath = tempConfig();
    const source = ({ parentRule }: { readonly parentRule: string }) =>
      JSON.stringify({
        profiles: {
          parent: {
            ...baseDefinition,
            tools: { bash: [{ pattern: parentRule, decision: "allow" }] },
          },
          existing: { description: "Child", extends: ["parent"] },
        },
      });
    fs.writeFileSync(configPath, source({ parentRule: "echo first" }));
    const store = profileStore({ configPath });
    const initial = refreshProfileStore({ store });
    if (!("snapshot" in initial)) throw new Error("initial store state");
    expect(initial.snapshot.config.profiles.existing.tools.bash).toContainEqual(
      { pattern: "echo first", decision: "allow" },
    );
    fs.writeFileSync(configPath, source({ parentRule: "echo refreshed" }));
    const refreshed = refreshProfileStore({ store });
    expect(refreshed.status).toBe(profileStoreStatus.refreshed);
    if (!("snapshot" in refreshed)) throw new Error("refreshed store state");
    expect(
      refreshed.snapshot.config.profiles.existing.tools.bash,
    ).toContainEqual({ pattern: "echo refreshed", decision: "allow" });
  });

  it("drops the current snapshot when reading the source fails", () => {
    const configPath = tempConfig();
    fs.writeFileSync(configPath, storeFixture.source);
    const store = profileStore({ configPath });
    expect(
      isUsableProfileStoreState({ state: refreshProfileStore({ store }) }),
    ).toBe(true);
    const readFileSync = fs.readFileSync.bind(fs);
    const read = vi
      .spyOn(fs, "readFileSync")
      .mockImplementation((file, options) => {
        if (file === configPath) throw new Error("simulated read failure");
        return readFileSync(file, options);
      });
    const failed = refreshProfileStore({ store });
    read.mockRestore();
    expect(failed.status).toBe(profileStoreStatus.invalid);
    expect("snapshot" in failed).toBe(false);
    expect("snapshot" in currentProfileStoreState({ store })).toBe(false);
  });

  it("never recovers valid, malformed, old, or future lock files during bounded contention", () => {
    const configPath = tempConfig();
    fs.writeFileSync(configPath, storeFixture.source);
    const lockPath = `${configPath}${profileConfigLockSettings.suffix}`;
    const resetWait = setProfileConfigLockWaitForTesting({ wait: () => {} });
    try {
      for (const contents of [
        JSON.stringify({ token: "valid" }),
        "{ malformed",
        JSON.stringify({ token: "old", createdAtMilliseconds: 0 }),
        JSON.stringify({
          token: "future",
          createdAtMilliseconds: Date.now() + 99_999,
        }),
      ]) {
        fs.writeFileSync(lockPath, contents);
        expect(() =>
          applyProfileRuleChanges({
            fallback: policyConfig,
            configPath,
            target: { mode: "update", profile: storeFixture.profile },
            changes: [
              { kind: "bash", pattern: "echo must-timeout", decision: "allow" },
            ],
          }),
        ).toThrow(ProfileConfigLockTimeoutError);
        expect(fs.readFileSync(lockPath, "utf8")).toBe(contents);
        fs.unlinkSync(lockPath);
      }
    } finally {
      resetWait();
    }
  });

  it("force removes only the observed public lock generation", () => {
    const configPath = tempConfig();
    const lockPath = `${configPath}${profileConfigLockSettings.suffix}`;
    const sidecar = `${lockPath}${profileConfigLockSettings.ownerSuffix}foreign`;
    fs.writeFileSync(configPath, storeFixture.source);
    fs.writeFileSync(sidecar, JSON.stringify({ token: "foreign" }));
    fs.linkSync(sidecar, lockPath);
    const stat = fs.lstatSync(lockPath);
    expect(
      forceRemoveProfileConfigLock({
        configPath,
        observedLockIdentity: { device: stat.dev, inode: stat.ino },
      }),
    ).toBe("removed");
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(fs.existsSync(sidecar)).toBe(true);
    expect(fs.readFileSync(configPath, "utf8")).toBe(storeFixture.source);
  });

  it("does not force a lock with the same inode identity but a different token", () => {
    const configPath = tempConfig();
    const lockPath = `${configPath}${profileConfigLockSettings.suffix}`;
    fs.writeFileSync(lockPath, JSON.stringify({ token: "current" }));
    const current = fs.lstatSync(lockPath);

    expect(
      forceRemoveProfileConfigLock({
        configPath,
        observedLockIdentity: {
          device: current.dev,
          inode: current.ino,
          token: "observed-generation",
        },
      }),
    ).toBe("lock-changed");
    expect(fs.readFileSync(lockPath, "utf8")).toBe(
      JSON.stringify({ token: "current" }),
    );
  });

  it("returns already-released when the observed lock disappears before Force unlink", () => {
    const configPath = tempConfig();
    const lockPath = `${configPath}${profileConfigLockSettings.suffix}`;
    fs.writeFileSync(lockPath, JSON.stringify({ token: "observed" }));
    const observed = fs.lstatSync(lockPath);
    const unlinkSync = fs.unlinkSync.bind(fs);
    const unlink = vi.spyOn(fs, "unlinkSync").mockImplementation((target) => {
      if (target === lockPath) {
        unlinkSync(target);
        throw Object.assign(new Error("lock disappeared"), { code: "ENOENT" });
      }
      return unlinkSync(target);
    });

    try {
      expect(
        forceRemoveProfileConfigLock({
          configPath,
          observedLockIdentity: {
            device: observed.dev,
            inode: observed.ino,
            token: "observed",
          },
        }),
      ).toBe("already-released");
    } finally {
      unlink.mockRestore();
    }
  });

  it("does not force a disappeared or replacement lock", () => {
    const configPath = tempConfig();
    const lockPath = `${configPath}${profileConfigLockSettings.suffix}`;
    fs.writeFileSync(lockPath, "first");
    const first = fs.lstatSync(lockPath);
    fs.unlinkSync(lockPath);
    expect(
      forceRemoveProfileConfigLock({
        configPath,
        observedLockIdentity: { device: first.dev, inode: first.ino },
      }),
    ).toBe("already-released");
    fs.writeFileSync(lockPath, "second");
    expect(
      forceRemoveProfileConfigLock({
        configPath,
        observedLockIdentity: { device: first.dev, inode: first.ino },
      }),
    ).toBe("lock-changed");
    expect(fs.existsSync(lockPath)).toBe(true);
  });

  it("leaves an unpublished owner sidecar inert after a pre-publication crash", () => {
    const configPath = tempConfig();
    const lockPath = `${configPath}${profileConfigLockSettings.suffix}`;
    const foreignSidecar = `${lockPath}${profileConfigLockSettings.ownerSuffix}foreign`;
    const foreignContents = JSON.stringify({ token: "foreign" });
    fs.writeFileSync(configPath, storeFixture.source);
    fs.writeFileSync(foreignSidecar, foreignContents);
    expect(fs.lstatSync(foreignSidecar).nlink).toBe(1);

    applyProfileRuleChanges({
      fallback: policyConfig,
      configPath,
      target: { mode: "update", profile: storeFixture.profile },
      changes: [{ kind: "bash", pattern: "echo acquired", decision: "allow" }],
    });

    expect(fs.existsSync(lockPath)).toBe(false);
    expect(fs.readFileSync(foreignSidecar, "utf8")).toBe(foreignContents);
    expect(profiles(configPath).existing.tools).toEqual({
      bash: [{ pattern: "echo acquired", decision: "allow" }],
    });
  });

  it("uses exactly the bounded lock attempts and waits", () => {
    const configPath = tempConfig();
    const lockPath = `${configPath}${profileConfigLockSettings.suffix}`;
    fs.writeFileSync(configPath, storeFixture.source);
    fs.writeFileSync(lockPath, JSON.stringify({ token: "blocked" }));
    let waits = 0;
    let publications = 0;
    const realLink = fs.linkSync.bind(fs);
    const link = vi
      .spyOn(fs, "linkSync")
      .mockImplementation((owner, target) => {
        if (target === lockPath) publications++;
        return realLink(owner, target);
      });
    const resetWait = setProfileConfigLockWaitForTesting({
      wait: () => waits++,
    });
    try {
      expect(() =>
        applyProfileRuleChanges({
          fallback: policyConfig,
          configPath,
          target: { mode: "update", profile: storeFixture.profile },
          changes: [
            { kind: "bash", pattern: "echo bounded", decision: "allow" },
          ],
        }),
      ).toThrow(ProfileConfigLockTimeoutError);
      expect(publications).toBe(profileConfigLockSettings.maximumAttempts);
      expect(waits).toBe(profileConfigLockSettings.maximumAttempts);
    } finally {
      resetWait();
      link.mockRestore();
    }
  });

  it("cleans its owner sidecar after normal acquire and release", () => {
    const configPath = tempConfig();
    fs.writeFileSync(configPath, storeFixture.source);
    applyProfileRuleChanges({
      fallback: policyConfig,
      configPath,
      target: { mode: "update", profile: storeFixture.profile },
      changes: [
        { kind: "bash", pattern: "echo owner-cleanup", decision: "allow" },
      ],
    });
    expect(fs.readdirSync(path.dirname(configPath))).toEqual([
      "profiles.jsonc",
    ]);
    expect(profiles(configPath).existing.tools).toEqual({
      bash: [{ pattern: "echo owner-cleanup", decision: "allow" }],
    });
  });

  it("fails closed and removes an unpublished sidecar when hard-link publication is unsupported", () => {
    const configPath = tempConfig();
    fs.writeFileSync(configPath, storeFixture.source);
    const link = vi.spyOn(fs, "linkSync").mockImplementation(() => {
      throw Object.assign(new Error("unsupported"), { code: "EPERM" });
    });
    try {
      expect(() =>
        applyProfileRuleChanges({
          fallback: policyConfig,
          configPath,
          target: { mode: "update", profile: storeFixture.profile },
          changes: [
            { kind: "bash", pattern: "echo no-fallback", decision: "allow" },
          ],
        }),
      ).toThrow("hard-link lock publication is unavailable");
    } finally {
      link.mockRestore();
    }
    expect(fs.readdirSync(path.dirname(configPath))).toEqual([
      "profiles.jsonc",
    ]);
    expect(fs.readFileSync(configPath, "utf8")).toBe(storeFixture.source);
  });

  it("rejects ownership loss before missing-prompt or config effects and preserves the replacement", () => {
    const configPath = tempConfig();
    const lockPath = `${configPath}${profileConfigLockSettings.suffix}`;
    const promptPath = path.join(
      path.dirname(configPath),
      "must-not-create.md",
    );
    const replacement = JSON.stringify({ token: "replacement" });
    fs.writeFileSync(configPath, storeFixture.source);
    const draft = {
      ...editDraft({ configPath, name: storeFixture.profile }),
      definition: {
        ...baseDefinition,
        description: "must not commit",
        promptFile: promptPath,
      },
    } satisfies ProfileAuthoringDraft;
    const realLink = fs.linkSync.bind(fs);
    const link = vi
      .spyOn(fs, "linkSync")
      .mockImplementation((owner, target) => {
        realLink(owner, target);
        if (target === lockPath) {
          fs.unlinkSync(lockPath);
          fs.writeFileSync(lockPath, replacement);
        }
      });
    try {
      expect(() =>
        applyProfileAuthoringCommit({
          fallback: policyConfig,
          configPath,
          draft,
        }),
      ).toThrow("lock ownership was lost");
    } finally {
      link.mockRestore();
    }
    expect(fs.readFileSync(lockPath, "utf8")).toBe(replacement);
    expect(fs.readFileSync(configPath, "utf8")).toBe(storeFixture.source);
    expect(fs.existsSync(promptPath)).toBe(false);
    expect(fs.readdirSync(path.dirname(configPath)).sort()).toEqual([
      "profiles.jsonc",
      "profiles.jsonc.lock",
    ]);
  });

  it("permits a writer which passed its final ownership check to commit after Force", () => {
    const configPath = tempConfig();
    const lockPath = `${configPath}${profileConfigLockSettings.suffix}`;
    fs.writeFileSync(configPath, storeFixture.source);
    const renameSync = fs.renameSync.bind(fs);
    const rename = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (to === configPath) {
        const stat = fs.lstatSync(lockPath);
        expect(
          forceRemoveProfileConfigLock({
            configPath,
            observedLockIdentity: {
              device: stat.dev,
              inode: stat.ino,
            },
          }),
        ).toBe("removed");
      }
      return renameSync(from, to);
    });
    try {
      applyProfileRuleChanges({
        fallback: policyConfig,
        configPath,
        target: { mode: "update", profile: storeFixture.profile },
        changes: [{ kind: "bash", pattern: "echo late", decision: "allow" }],
      });
    } finally {
      rename.mockRestore();
    }
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(profiles(configPath).existing.tools).toEqual({
      bash: [{ pattern: "echo late", decision: "allow" }],
    });
  });

  it("permits a late normal release to remove a successor public lock", () => {
    const configPath = tempConfig();
    const lockPath = `${configPath}${profileConfigLockSettings.suffix}`;
    const successor = JSON.stringify({ token: "successor" });
    fs.writeFileSync(configPath, storeFixture.source);
    const unlinkSync = fs.unlinkSync.bind(fs);
    const unlink = vi.spyOn(fs, "unlinkSync").mockImplementation((target) => {
      if (target === lockPath) {
        unlinkSync(lockPath);
        fs.writeFileSync(lockPath, successor);
      }
      return unlinkSync(target);
    });
    try {
      applyProfileRuleChanges({
        fallback: policyConfig,
        configPath,
        target: { mode: "update", profile: storeFixture.profile },
        changes: [
          { kind: "bash", pattern: "echo released", decision: "allow" },
        ],
      });
    } finally {
      unlink.mockRestore();
    }
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(profiles(configPath).existing.tools).toEqual({
      bash: [{ pattern: "echo released", decision: "allow" }],
    });
  });

  it("reacquires normally and replays an independent mutation from a fresh source", () => {
    const configPath = tempConfig();
    const lockPath = `${configPath}${profileConfigLockSettings.suffix}`;
    fs.writeFileSync(configPath, storeFixture.source);
    fs.writeFileSync(lockPath, JSON.stringify({ token: "first-writer" }));
    let waits = 0;
    const resetWait = setProfileConfigLockWaitForTesting({
      wait: () => {
        waits++;
        fs.unlinkSync(lockPath);
        fs.writeFileSync(
          configPath,
          JSON.stringify({
            profiles: {
              existing: {
                ...baseDefinition,
                tools: {
                  bash: [{ pattern: "echo independent", decision: "deny" }],
                },
              },
            },
          }),
        );
      },
    });
    try {
      applyProfileRuleChanges({
        fallback: policyConfig,
        configPath,
        target: { mode: "update", profile: storeFixture.profile },
        changes: [
          { kind: "bash", pattern: "echo replayed", decision: "allow" },
        ],
      });
    } finally {
      resetWait();
    }
    expect(waits).toBe(1);
    expect(profiles(configPath).existing.tools).toEqual({
      bash: [
        { pattern: "echo independent", decision: "deny" },
        { pattern: "echo replayed", decision: "allow" },
      ],
    });
  });

  it("commits a matching expected revision and leaves no lock artifacts", () => {
    const configPath = tempConfig();
    fs.writeFileSync(configPath, storeFixture.source);
    const expectedRevision = loadProfileConfigSnapshot({
      fallback: policyConfig,
      configPath,
    }).sourceRevision;
    applyProfileRuleChanges({
      fallback: policyConfig,
      configPath,
      expectedRevision,
      target: { mode: "update", profile: storeFixture.profile },
      changes: [
        { kind: "bash", pattern: "echo revision-match", decision: "allow" },
      ],
    });
    expect(fs.readdirSync(path.dirname(configPath))).toEqual([
      "profiles.jsonc",
    ]);
    expect(profiles(configPath).existing.tools).toEqual({
      bash: [{ pattern: "echo revision-match", decision: "allow" }],
    });
  });

  it("preserves config, prompt, temporaries, sidecars, and replacement contents when Force sees a changed generation", () => {
    const configPath = tempConfig();
    const lockPath = `${configPath}${profileConfigLockSettings.suffix}`;
    const promptPath = path.join(path.dirname(configPath), "prompt.md");
    const temporaryPath = path.join(
      path.dirname(configPath),
      ".profiles.jsonc.foreign.tmp",
    );
    const sidecarPath = `${lockPath}${profileConfigLockSettings.ownerSuffix}foreign`;
    const replacement = JSON.stringify({ token: "replacement" });
    fs.writeFileSync(configPath, storeFixture.source);
    fs.writeFileSync(promptPath, "foreign prompt");
    fs.writeFileSync(temporaryPath, "foreign temporary");
    fs.writeFileSync(sidecarPath, JSON.stringify({ token: "foreign" }));
    fs.linkSync(sidecarPath, lockPath);
    const observed = fs.lstatSync(lockPath);
    fs.unlinkSync(lockPath);
    fs.writeFileSync(lockPath, replacement);
    expect(
      forceRemoveProfileConfigLock({
        configPath,
        observedLockIdentity: {
          device: observed.dev,
          inode: observed.ino,
          token: "foreign",
        },
      }),
    ).toBe("lock-changed");
    expect(fs.readFileSync(configPath, "utf8")).toBe(storeFixture.source);
    expect(fs.readFileSync(promptPath, "utf8")).toBe("foreign prompt");
    expect(fs.readFileSync(temporaryPath, "utf8")).toBe("foreign temporary");
    expect(fs.readFileSync(sidecarPath, "utf8")).toBe(
      JSON.stringify({ token: "foreign" }),
    );
    expect(fs.readFileSync(lockPath, "utf8")).toBe(replacement);
  });

  it("canonicalizes empty appends but retains empty overwrites", () => {
    const append = {
      network: "deny",
      extraWritePaths: [],
    } satisfies Parameters<typeof decodeSandboxAuthoring>[0]["raw"];
    const overwrite = {
      network: "deny",
      extraWritePaths: [],
      overwritePathArrays: ["extraWritePaths"],
    } satisfies Parameters<typeof decodeSandboxAuthoring>[0]["raw"];
    expect(
      serializeSandboxAuthoring({
        value: decodeSandboxAuthoring({ raw: append }),
      }),
    ).toEqual({ network: "deny" });
    expect(
      serializeSandboxAuthoring({
        value: decodeSandboxAuthoring({ raw: overwrite }),
      }),
    ).toEqual(overwrite);
  });
});
