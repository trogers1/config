import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { policyConfig } from "../modules/policy";
import type { ProfilePolicy } from "../modules/policyHelpers";
import { createExtensionHarness } from "./support/extensionHarness";

const missingProfileConfigPath = path.resolve(
  "integrationTests/fixtures/does-not-exist.jsonc",
);

describe("shipped profile catalog", () => {
  beforeEach(() => {
    process.env.PI_PERMISSIONS_PROFILE_CONFIG = missingProfileConfigPath;
    delete process.env.PI_SUBAGENT_PERMISSIBLE_GLOBS;
  });

  afterEach(() => {
    delete process.env.PI_PERMISSIONS_PROFILE_CONFIG;
    delete process.env.PI_SUBAGENT_PROFILE;
  });

  async function harnessFor(
    profile: string,
  ): Promise<ReturnType<typeof createExtensionHarness>> {
    process.env.PI_SUBAGENT_PROFILE = profile;
    const harness = createExtensionHarness({ hasUI: false });
    await harness.start();
    return harness;
  }

  it("builtin:committer allows git commit", async () => {
    const harness = await harnessFor("builtin:committer");
    await expect(
      harness.callToolWithoutPrompt({
        toolName: "bash",
        input: { command: "git commit -m test" },
      }),
    ).resolves.toBeUndefined();
  });

  it("builtin:reviewer denies edit but allows npm test", async () => {
    const harness = await harnessFor("builtin:reviewer");

    const edit = await harness.callTool({
      toolName: "edit",
      input: { path: "src/example.ts", edits: [] },
    });
    expect(edit).toMatchObject({ block: true });

    await expect(
      harness.callToolWithoutPrompt({
        toolName: "bash",
        input: { command: "npm test" },
      }),
    ).resolves.toBeUndefined();
  });

  it.each([
    "npm run test -- --watch",
    "npm test -- --watch",
    "pnpm run test -- --watch",
    "pnpm test -- --watch",
    "yarn run test -- --watch",
    "yarn test -- --watch",
    "cargo build --release",
    "cargo test",
    "cargo check",
    "cargo clippy",
    "go build",
    "go test",
  ])(
    "builtin:reviewer allows advertised test/build commands without prompting: %s",
    async (command) => {
      const harness = await harnessFor("builtin:reviewer");
      await expect(
        harness.callToolWithoutPrompt({
          toolName: "bash",
          input: { command },
        }),
        command,
      ).resolves.toBeUndefined();
    },
  );

  it("builtin:scribe-only denies writes outside docs but allows README.md", async () => {
    const harness = await harnessFor("builtin:scribe-only");

    const sourceWrite = await harness.callTool({
      toolName: "write",
      input: { path: "src/x.ts", content: "blocked" },
    });
    expect(sourceWrite).toMatchObject({ block: true });

    await expect(
      harness.callToolWithoutPrompt({
        toolName: "write",
        input: { path: "README.md", content: "allowed" },
      }),
    ).resolves.toBeUndefined();
  });

  it("builtin:deps-mutator allows npm install but denies npm publish", async () => {
    const harness = await harnessFor("builtin:deps-mutator");

    await expect(
      harness.callToolWithoutPrompt({
        toolName: "bash",
        input: { command: "npm install lodash" },
      }),
    ).resolves.toBeUndefined();

    const publish = await harness.callTool({
      toolName: "bash",
      input: { command: "npm publish" },
    });
    expect(publish).toMatchObject({ block: true });
  });

  it("builtin:no-shell denies git status but allows edit", async () => {
    const harness = await harnessFor("builtin:no-shell");

    const bash = await harness.callTool({
      toolName: "bash",
      input: { command: "git status --short" },
    });
    expect(bash).toMatchObject({ block: true });

    await expect(
      harness.callToolWithoutPrompt({
        toolName: "edit",
        input: { path: "src/example.ts", edits: [] },
      }),
    ).resolves.toBeUndefined();
  });

  it("builtin:implementation-only denies test writes but reads tests", async () => {
    const harness = await harnessFor("builtin:implementation-only");

    await expect(
      harness.callToolWithoutPrompt({
        toolName: "read",
        input: { path: "src/example.test.ts" },
      }),
    ).resolves.toBeUndefined();

    const testWrite = await harness.callTool({
      toolName: "write",
      input: { path: "src/example.test.ts", content: "blocked" },
    });
    expect(testWrite).toMatchObject({ block: true });
  });

  it("builtin:git-full allows git push", async () => {
    const harness = await harnessFor("builtin:git-full");
    await expect(
      harness.callToolWithoutPrompt({
        toolName: "bash",
        input: { command: "git push origin main" },
      }),
    ).resolves.toBeUndefined();
  });

  it("tests-hidden is renamed from tests-disallowed", () => {
    const profiles = policyConfig.profiles as Record<string, ProfilePolicy>;
    expect(profiles["builtin:tests-hidden"]).toBeDefined();
    expect(profiles["builtin:tests-disallowed"]).toBeUndefined();
  });

  it("builtin:read-only blocks destructive find, grep, and git guards", async () => {
    const harness = await harnessFor("builtin:read-only");
    for (const command of [
      "find /tmp -delete",
      "find -delete",
      "find -exec rm -f {} \\;",
      "find -execdir rm -f {} \\;",
      "grep foo /tmp",
      "git fsck --lost-found",
      "git grep foo /tmp",
      "git diff --output /tmp/patch.diff",
      "git merge-tree --write-tree HEAD HEAD",
      "sed -i '' -e 's/foo/bar/' HEAD",
    ]) {
      const result = await harness.callTool({
        toolName: "bash",
        input: { command },
      });
      expect(result, command).toMatchObject({ block: true });
    }
  });

  it("builtin:read-only still allows safe git inspection commands", async () => {
    const harness = await harnessFor("builtin:read-only");
    for (const command of [
      "git fsck --full",
      "git symbolic-ref HEAD",
      "git symbolic-ref --short HEAD",
      "git config --get user.name",
      "git merge-tree HEAD HEAD HEAD",
      "git diff-tree HEAD",
    ]) {
      await expect(
        harness.callTool({
          toolName: "bash",
          input: { command },
        }),
        command,
      ).resolves.toBeUndefined();
    }
  });

  it("builtin:default reads global Pi skills and Pi documentation", async () => {
    const root = path.parse(process.cwd()).root;
    const harness = createExtensionHarness({
      contextCwd: path.join(root, "workspace", "project"),
      hasUI: false,
    });
    process.env.PI_SUBAGENT_PROFILE = "builtin:default";
    await harness.start();

    const readableReferences = [
      path.join(
        root,
        "Users",
        "example",
        ".pi",
        "agent",
        "skills",
        "review",
        "SKILL.md",
      ),
      path.join(
        root,
        "opt",
        "node_modules",
        "@earendil-works",
        "pi-coding-agent",
        "README.md",
      ),
      path.join(
        root,
        "opt",
        "node_modules",
        "@earendil-works",
        "pi-coding-agent",
        "docs",
        "skills.md",
      ),
    ];

    for (const referencePath of readableReferences) {
      await expect(
        harness.callToolWithoutPrompt({
          toolName: "read",
          input: { path: referencePath },
        }),
      ).resolves.toBeUndefined();
    }
  });

  it("builtin:tests-hidden hides test files", async () => {
    const harness = await harnessFor("builtin:tests-hidden");
    const result = await harness.callTool({
      toolName: "read",
      input: { path: "src/example.test.ts" },
    });
    expect(result).toMatchObject({ block: true });
    expect(result?.reason).toContain("denied by policy");
  });
});
