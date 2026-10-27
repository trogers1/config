import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BuiltinProfileName,
  ProfileConfigFile,
} from "../modules/policyHelpers";

const profiles = [
  "builtin:worker",
  "builtin:read-only",
] satisfies BuiltinProfileName[];

let fixture: string;
let home: string;
let agentDir: string;
let cwd: string;
let roots: string[];
let targets: string[];

beforeEach(() => {
  // Keep fixtures outside /tmp: its existing allow would mask regressions.
  fixture = fs.mkdtempSync(path.resolve("../.resource-discovery-"));
  home = path.join(fixture, "home");
  agentDir = path.join(fixture, "configured-agent");
  cwd = path.join(fixture, "project");
  roots = [
    path.join(home, ".agents/skills"),
    path.join(home, ".agents/snippets"),
    path.join(agentDir, "skills"),
  ];
  targets = roots.map((_, index) =>
    path.join(fixture, "config-checkout", `resource-${index}`),
  );
  fs.mkdirSync(cwd, { recursive: true });
  for (const [index, root] of roots.entries()) {
    const target = targets[index];
    if (!target) throw new Error("Missing resource fixture target");
    if (index === 1) {
      const linkedRoot = path.join(fixture, "config-checkout", "linked-root");
      fs.mkdirSync(linkedRoot, { recursive: true });
      fs.mkdirSync(path.dirname(root), { recursive: true });
      fs.symlinkSync(linkedRoot, root);
    } else {
      fs.mkdirSync(root, { recursive: true });
    }
    fs.mkdirSync(path.join(target, "references"), { recursive: true });
    fs.writeFileSync(path.join(target, "SKILL.md"), "Installed resource");
    fs.symlinkSync(target, path.join(root, "installed"));
  }
  vi.stubEnv("HOME", home);
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  vi.stubEnv("PI_SUBAGENT_PERMISSIBLE_GLOBS", undefined);
  vi.stubEnv("PI_SUBAGENT_PROFILE", undefined);
  vi.stubEnv("PI_GUARD_PROFILE_CONFIG", path.join(fixture, "profiles.jsonc"));
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(fixture, { recursive: true, force: true });
});

async function startGuard({ profile }: { profile: (typeof profiles)[number] }) {
  const config = {
    defaultProfile: profile,
    profiles: {},
  } satisfies ProfileConfigFile;
  fs.writeFileSync(
    path.join(fixture, "profiles.jsonc"),
    JSON.stringify(config),
  );
  const { createExtensionHarness } = await import("./support/extensionHarness");
  vi.stubEnv("PI_SUBAGENT_PROFILE", profile);
  vi.stubEnv("PI_SUBAGENT_PERMISSIBLE_GLOBS", "output/**");
  const harness = createExtensionHarness({ contextCwd: cwd, hasUI: false });
  await harness.start();
  return harness;
}

describe.each(profiles)("%s installed resource discovery", (profile) => {
  it("permits dedicated reads and discovery through logical links and exact targets", async () => {
    const guard = await startGuard({ profile });
    try {
      for (const root of [...roots, ...targets]) {
        const entry = roots.includes(root)
          ? path.join(root, "installed")
          : root;
        for (const directory of [
          root,
          fs.realpathSync(root),
          entry,
          path.join(entry, "references"),
        ]) {
          for (const toolName of ["ls", "find"] as const) {
            expect(
              await guard.callTool({
                toolName,
                input: {
                  path: directory,
                  ...(toolName === "find" ? { pattern: "**/*" } : {}),
                },
              }),
              `${toolName} ${directory}`,
            ).toBeUndefined();
          }
        }
        expect(
          await guard.callTool({
            toolName: "read",
            input: { path: path.join(entry, "SKILL.md") },
          }),
        ).toBeUndefined();
      }
    } finally {
      await guard.dispose();
    }
  });

  it.each(["?", "*"])(
    "treats wildcard character %s in installed target names literally",
    async (character) => {
      const root = path.join(home, ".agents", "skills");
      const target = path.join(fixture, `literal-resource-${character}`);
      const sibling = path.join(fixture, "literal-resource-a");
      for (const directory of [target, sibling]) {
        fs.mkdirSync(directory);
        fs.writeFileSync(
          path.join(directory, "reference.md"),
          "literal target evidence",
        );
      }
      fs.symlinkSync(target, path.join(root, "literal"));
      const guard = await startGuard({ profile });
      try {
        for (const toolName of ["read", "ls", "find"] as const) {
          const input = {
            path:
              toolName === "read" ? path.join(target, "reference.md") : target,
            ...(toolName === "find" ? { pattern: "**/*" } : {}),
          };
          expect(await guard.callTool({ toolName, input })).toBeUndefined();
          const denied = {
            ...input,
            path:
              toolName === "read"
                ? path.join(sibling, "reference.md")
                : sibling,
          };
          expect(
            await guard.callTool({ toolName, input: denied }),
            toolName,
          ).toMatchObject({ block: true });
        }
      } finally {
        await guard.dispose();
      }
    },
  );

  it("keeps unrelated paths, lookalike installations, content search and mutations gated", async () => {
    const guard = await startGuard({ profile });
    try {
      for (const directory of [
        "..",
        path.join(home, ".agents"),
        path.join(fixture, "config-checkout"),
        path.join(fixture, "other/.agents/skills"),
        path.join(fixture, "other/.pi/agent/skills"),
      ]) {
        for (const toolName of ["read", "ls", "find"] as const) {
          expect(
            await guard.callTool({
              toolName,
              input: {
                path: directory,
                ...(toolName === "find" ? { pattern: "**/*" } : {}),
              },
            }),
            `${toolName} ${directory}`,
          ).toMatchObject({ block: true });
        }
      }
      for (const root of [...roots, ...targets]) {
        expect(
          await guard.callTool({
            toolName: "read",
            input: { path: path.join(root, ".env") },
          }),
        ).toMatchObject({ block: true });
        for (const toolName of ["write", "edit", "grep", "bash"] as const) {
          const input =
            toolName === "bash"
              ? { command: `ls '${root}'` }
              : toolName === "grep"
                ? { path: root, pattern: "Installed" }
                : toolName === "edit"
                  ? {
                      path: path.join(root, "SKILL.md"),
                      edits: [{ oldText: "Installed", newText: "changed" }],
                    }
                  : { path: path.join(root, "SKILL.md"), content: "changed" };
          expect(
            await guard.callTool({ toolName, input }),
            `${toolName} ${root}`,
          ).toMatchObject({ block: true });
        }
      }
    } finally {
      await guard.dispose();
    }
  });
});
