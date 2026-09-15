import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse } from "jsonc-parser";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyProfileAuthoringCommit,
  applyProfileRuleChanges,
  loadProfileConfig,
  loadProfileConfigSnapshot,
  ProfileConfigConflictError,
  validateProfileAuthoringCommit,
} from "../modules/profileConfig";
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
import type { ProfileConfigProfile } from "../modules/policyHelpers";

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
  const definition = loadProfileConfigSnapshot(policyConfig, configPath).raw
    ?.profiles[name];
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

describe("profile config mutations", () => {
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
      loadProfileConfig(policyConfig, configPath).profiles["local-work"].tools
        .bash,
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
    const expectedRevision = loadProfileConfigSnapshot(
      policyConfig,
      configPath,
    ).sourceRevision;
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
    const document = parse(source) as {
      defaultProfile: string;
      profiles: Record<string, { extends?: string[] }>;
    };
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
      loadProfileConfig(policyConfig, configPath).profiles.standalone.sandbox,
    ).toEqual({ network: "deny", extraWritePaths: [] });
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
