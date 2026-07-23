import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createExtensionHarness,
  lastCallArgument,
} from "./support/extensionHarness";
import { policyConfig } from "../modules/policy";

describe("permissions extension", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("selects the subagent profile from the environment", async () => {
    vi.stubEnv("PI_SUBAGENT_PROFILE", "read-only");
    const harness = createExtensionHarness();

    await harness.start();

    expect(lastCallArgument(harness.ui.setStatus, 1)).toContain("read-only");
    await expect(
      harness.callTool({
        toolName: "write",
        input: { path: "notes.md", content: "blocked" },
      }),
    ).resolves.toMatchObject({ block: true });
  });

  it("does not let a permissive subagent write glob widen the selected profile", async () => {
    vi.stubEnv("PI_SUBAGENT_PROFILE", "read-only");
    vi.stubEnv("PI_SUBAGENT_WRITE_GLOBS", "**");
    const harness = createExtensionHarness({ hasUI: false });
    await harness.start();

    const denied = await harness.callTool({
      toolName: "write",
      input: { path: "notes.md", content: "still blocked" },
    });
    expect(denied).toMatchObject({ block: true });
    expect(denied?.reason).toContain("read-only profile");

    // The env scope is a cap, not a replacement: profile-specific allows
    // continue to work when they also fall within the declared scope.
    await expect(
      harness.callToolWithoutPrompt({
        toolName: "write",
        input: { path: "handoff.md", content: "allowed by both layers" },
      }),
    ).resolves.toBeUndefined();
  });

  it("provides a non-interactive worker profile", async () => {
    vi.stubEnv("PI_SUBAGENT_PROFILE", "worker");
    const harness = createExtensionHarness({ hasUI: false });
    await harness.start();

    await expect(
      harness.callToolWithoutPrompt({
        toolName: "bash",
        input: { command: "npm test" },
      }),
    ).resolves.toBeUndefined();

    const unspecified = await harness.callTool({
      toolName: "bash",
      input: { command: "python scripts/build.py" },
    });
    expect(unspecified).toMatchObject({ block: true });
    expect(unspecified?.reason).toContain("non-interactive worker");
  });

  it("enforces subagent write scopes for tools and Bash paths", async () => {
    vi.stubEnv("PI_SUBAGENT_PROFILE", "worker");
    vi.stubEnv(
      "PI_SUBAGENT_WRITE_GLOBS",
      "modules/allowed.ts,tests/unit/**,.env",
    );
    const harness = createExtensionHarness({ hasUI: false });
    await harness.start();

    await expect(
      harness.callToolWithoutPrompt({
        toolName: "write",
        input: { path: "modules/allowed.ts", content: "allowed" },
      }),
    ).resolves.toBeUndefined();
    await expect(
      harness.callToolWithoutPrompt({
        toolName: "edit",
        input: { path: "tests/unit/example.test.ts", edits: [] },
      }),
    ).resolves.toBeUndefined();

    for (const event of [
      {
        toolName: "write",
        input: { path: "modules/outside.ts", content: "blocked" },
      },
      {
        toolName: "bash",
        input: { command: "npm test -- tests/integration/example.test.ts" },
      },
    ]) {
      const denied = await harness.callTool(event);
      expect(denied).toMatchObject({ block: true });
      expect(denied?.reason).toContain("PI_SUBAGENT_WRITE_GLOBS");
    }

    // Even an explicitly in-scope path remains subject to the profile's
    // protected-path layer.
    const protectedWrite = await harness.callTool({
      toolName: "write",
      input: { path: ".env", content: "blocked" },
    });
    expect(protectedWrite).toMatchObject({ block: true });
    expect(protectedWrite?.reason).toContain(
      "protected from disclosure and mutation",
    );
  });

  it("fails startup for an unknown subagent profile", async () => {
    vi.stubEnv("PI_SUBAGENT_PROFILE", "missing");
    const harness = createExtensionHarness();

    await expect(harness.start()).resolves.toBeUndefined();
    expect(harness.errors).toHaveLength(1);
    expect(harness.errors[0]?.event).toBe("session_start");
    expect(harness.errors[0]?.error).toBeInstanceOf(Error);
    expect(String(harness.errors[0]?.error)).toContain(
      "Unknown PI_SUBAGENT_PROFILE 'missing'",
    );

    const blocked = await harness.callToolWithoutPrompt({
      toolName: "bash",
      input: { command: "git status --short" },
    });
    expect(blocked).toMatchObject({ block: true });
    expect(blocked?.reason).toContain("Invalid PI_SUBAGENT_PROFILE 'missing'");
    expect(blocked?.reason).toContain("The permissions gate remains loaded");
  });

  it("rejects commands and tools before start", async () => {
    const harness = createExtensionHarness();

    await expect(
      harness.callTool({ toolName: "bash", input: { command: "git status" } }),
    ).rejects.toThrow("Harness must be started before callTool");
    await expect(harness.runCommand("profile")).rejects.toThrow(
      "Harness must be started before runCommand",
    );
  });

  it("starts in the configured default profile and clears its status on shutdown", async () => {
    const harness = createExtensionHarness();

    await harness.start();

    expect(lastCallArgument(harness.ui.setStatus, 0)).toBe("permissions");
    expect(lastCallArgument(harness.ui.setStatus, 1)).toContain("default");

    await harness.shutdown();
    expect(harness.ui.setStatus).toHaveBeenLastCalledWith(
      "permissions",
      undefined,
    );
  });

  it("shows, validates, autocompletes, and switches profiles through /profile", async () => {
    const harness = createExtensionHarness();
    await harness.start();

    await harness.runCommand("profile");
    expect(harness.ui.notify).toHaveBeenLastCalledWith(
      expect.stringContaining("Active profile: default"),
      "info",
    );

    await harness.runCommand("profile", "missing");
    expect(harness.ui.notify).toHaveBeenLastCalledWith(
      expect.stringContaining("Unknown profile 'missing'"),
      "error",
    );

    await harness.runCommand("profile", "socrates");
    expect(harness.entries.at(-1)).toMatchObject({
      customType: "pi-permissions-profile",
      data: { profile: "socrates" },
    });
    const completions = await harness
      .command("profile")
      .getArgumentCompletions?.("soc");
    expect(completions?.map((completion) => completion.value)).toEqual([
      "socrates",
    ]);
    expect(lastCallArgument(harness.ui.setStatus, 1)).toContain("🧠");
    expect(lastCallArgument(harness.ui.setStatus, 1)).toContain("socrates");
  });

  it("restores the persisted profile and applies its prompt and read-only policy", async () => {
    const firstSession = createExtensionHarness();
    await firstSession.start();
    await firstSession.runCommand("socrates");

    const resumedSession = createExtensionHarness({
      entries: firstSession.entries,
    });
    await resumedSession.start("resume");

    const prompt = await resumedSession.beforeAgent();
    expect(prompt?.systemPrompt).toContain("# Active profile: socrates");
    expect(prompt?.systemPrompt).toContain("Base system prompt");

    const write = await resumedSession.callTool({
      toolName: "write",
      input: { path: "notes.md", content: "not allowed" },
    });
    expect(write).toMatchObject({ block: true });
  });

  it("allows and denies real default-profile bash rules through tool_call", async () => {
    const harness = createExtensionHarness();
    await harness.start();

    await expect(
      harness.callToolWithoutPrompt({
        toolName: "bash",
        input: { command: "git status --short" },
      }),
    ).resolves.toBeUndefined();

    const denied = await harness.callTool({
      toolName: "bash",
      input: { command: "git checkout main" },
    });
    expect(denied).toMatchObject({ block: true });
    expect(denied?.reason).toContain("Command denied by explicit rule");
  });

  it("allows safe default-profile git inspection commands without allowing mutating variants", async () => {
    const harness = createExtensionHarness();
    await harness.start();

    for (const command of [
      "git blame src/example.ts",
      "git rev-list --all --max-count=10",
      "git ls-tree HEAD src",
      "git cat-file -p HEAD",
      "git for-each-ref refs/heads",
      "git remote -v",
      "git stash list",
      "git stash show stash@{0}",
      "git branch --list feature/*",
      "git branch --show-current",
      "git tag --list v*",
      "git worktree list --porcelain",
    ]) {
      await expect(
        harness.callToolWithoutPrompt({
          toolName: "bash",
          input: { command },
        }),
      ).resolves.toBeUndefined();
    }

    for (const command of [
      "git branch -d feature/test",
      "git branch --move old new",
      "git tag -d v1.0.0",
      "git worktree add ../scratch HEAD",
      "git diff --output patch.diff",
      "git fsck --lost-found",
    ]) {
      const denied = await harness.callTool({
        toolName: "bash",
        input: { command },
      });
      expect(denied).toMatchObject({ block: true });
    }
  });

  it("allows default-profile scratch redirection and reads only in /tmp", async () => {
    const harness = createExtensionHarness();
    await harness.start();

    await expect(
      harness.callToolWithoutPrompt({
        toolName: "bash",
        input: { command: "git log --oneline > /tmp/pi-history.txt" },
      }),
    ).resolves.toBeUndefined();

    await expect(
      harness.callToolWithoutPrompt({
        toolName: "read",
        input: { path: "/tmp/pi-history.txt" },
      }),
    ).resolves.toBeUndefined();

    await expect(
      harness.callToolWithoutPrompt({
        toolName: "bash",
        input: { command: "tail /tmp/pi-history.txt" },
      }),
    ).resolves.toBeUndefined();

    const projectFile = await harness.callTool({
      toolName: "bash",
      input: { command: "git log --oneline > history.txt" },
    });
    expect(projectFile).toMatchObject({ block: true });
    expect(projectFile?.reason).toContain("output redirection denied");

    const secondRedirect = await harness.callTool({
      toolName: "bash",
      input: {
        command: "git log --oneline > /tmp/pi-history.txt > history.txt",
      },
    });
    expect(secondRedirect).toMatchObject({ block: true });
  });

  it("denies write-capable find forms in the default profile", async () => {
    const harness = createExtensionHarness();
    await harness.start();

    for (const command of [
      "find . -delete",
      "find . -exec rm {} ;",
      "find . -execdir rm {} ;",
    ]) {
      const denied = await harness.callTool({
        toolName: "bash",
        input: { command },
      });
      expect(denied).toMatchObject({ block: true });
    }
  });

  it("protects .env* paths while permitting .env.template", async () => {
    const harness = createExtensionHarness();
    await harness.start();

    for (const toolName of ["read", "grep", "ls"] as const) {
      const denied = await harness.callTool({
        toolName,
        input:
          toolName === "grep"
            ? { path: ".env.production", pattern: "SECRET" }
            : { path: ".env.production" },
      });
      expect(denied).toMatchObject({ block: true });
    }

    await expect(
      harness.callToolWithoutPrompt({
        toolName: "read",
        input: { path: ".env.template" },
      }),
    ).resolves.toBeUndefined();
  });

  it("validates shell reader inputs before broad command allow rules", async () => {
    const harness = createExtensionHarness();
    await harness.start();

    for (const command of [
      "cat .env",
      "cat .env.local",
      "head .env.production",
      "tail nested/.env.local",
      "sed -n '1,20p' .env",
      "nl .env",
      "sort .env.test",
      "wc -l .env",
      "file .env",
      "cat .env*",
      "head */.env*",
      "sed -n '1,20p' **/.env*",
      'f=.env; cat "$f"',
      'cat "$(printf .env)"',
      "head `printf .env`",
      "find . -type f -print0 | xargs -0 cat",
      "bash -c 'cat .env'",
      "eval 'tail .env'",
      'for f in .env*; do cat "$f"; done',
    ]) {
      const denied = await harness.callTool({
        toolName: "bash",
        input: { command },
      });
      expect(denied).toMatchObject({ block: true });
      expect(harness.ui.confirm).not.toHaveBeenCalled();
    }

    for (const profile of ["read-only", "socrates"] as const) {
      await harness.runCommand("profile", profile);
      const denied = await harness.callTool({
        toolName: "bash",
        input: { command: "cat .env" },
      });
      expect(denied).toMatchObject({ block: true });
    }
    const nonInteractive = createExtensionHarness({ hasUI: false });
    await nonInteractive.start();
    await expect(
      nonInteractive.callTool({
        toolName: "bash",
        input: { command: "cat .env" },
      }),
    ).resolves.toMatchObject({ block: true });

    // Return to the default profile for safe-reader allow checks.
    await harness.runCommand("profile", "default");
    for (const command of [
      "cat README.md",
      "head -n 20 README.md",
      "tail --lines=20 src/example.ts",
      "sed -n '1,20p' src/example.ts",
      "nl src/example.ts",
      "sort fixtures/names.txt",
      "wc -l README.md",
      "file README.md",
      "cat .env.template",
      "head nested/.env.template",
    ]) {
      await expect(
        harness.callToolWithoutPrompt({ toolName: "bash", input: { command } }),
      ).resolves.toBeUndefined();
    }
  });

  it("changes protected read and edit access when switching profiles", async () => {
    const unprotectedProfile = policyConfig.profiles["performance-review"];
    const originalPatterns = unprotectedProfile.protectedPathPatterns;
    const originalExceptions = unprotectedProfile.protectedPathExceptions;
    unprotectedProfile.protectedPathPatterns = [];
    unprotectedProfile.protectedPathExceptions = [];

    try {
      const harness = createExtensionHarness();
      await harness.start();
      const readInput = { path: ".env" };
      const editInput = {
        path: ".env",
        edits: [{ oldText: "PLACEHOLDER", newText: "REDACTED" }],
      };

      await expect(
        harness.callTool({ toolName: "read", input: readInput }),
      ).resolves.toMatchObject({ block: true });
      await expect(
        harness.callTool({ toolName: "edit", input: editInput }),
      ).resolves.toMatchObject({ block: true });

      await harness.runCommand("profile", "performance-review");

      await expect(
        harness.callToolWithoutPrompt({ toolName: "read", input: readInput }),
      ).resolves.toBeUndefined();
      await expect(
        harness.callToolWithoutPrompt({ toolName: "edit", input: editInput }),
      ).resolves.toBeUndefined();
    } finally {
      unprotectedProfile.protectedPathPatterns = originalPatterns;
      unprotectedProfile.protectedPathExceptions = originalExceptions;
    }
  });

  it("automatically excludes env files from searches", async () => {
    const harness = createExtensionHarness();
    await harness.start();

    const builtInGrepInput: {
      path: string;
      pattern: string;
      glob?: string;
    } = { path: ".", pattern: "DATABASE_URL" };
    await expect(
      harness.callToolWithoutPrompt({
        toolName: "grep",
        input: builtInGrepInput,
      }),
    ).resolves.toBeUndefined();
    expect(builtInGrepInput.glob).toBe(
      "!{**/.env*,**/.env*/**,**/.git,**/.git/**,**/secrets/*.tfvars}",
    );

    const safeGlobInput = {
      path: ".",
      pattern: "DATABASE_URL",
      glob: "**/*.ts",
    };
    await expect(
      harness.callToolWithoutPrompt({ toolName: "grep", input: safeGlobInput }),
    ).resolves.toBeUndefined();
    expect(safeGlobInput.glob).toBe("**/*.ts");

    const unsafeGlob = await harness.callTool({
      toolName: "grep",
      input: { path: ".", pattern: "DATABASE_URL", glob: "**/*" },
    });
    expect(unsafeGlob).toMatchObject({ block: true });
    expect(unsafeGlob?.reason).toContain("protected by the active profile");

    const ripgrepInput = { command: "rg DATABASE_URL ." };
    await expect(
      harness.callToolWithoutPrompt({ toolName: "bash", input: ripgrepInput }),
    ).resolves.toBeUndefined();
    expect(ripgrepInput.command).toBe(
      "rg --glob '!**/.env*' --glob '!**/.env*/**' --glob '!**/.git' --glob '!**/.git/**' --glob '!**/secrets/*.tfvars' --glob '**/.env.template' DATABASE_URL .",
    );

    for (const command of [
      "grep -R DATABASE_URL .",
      "git grep DATABASE_URL",
      "rg --glob '**/*' DATABASE_URL .",
    ]) {
      const denied = await harness.callTool({
        toolName: "bash",
        input: { command },
      });
      expect(denied).toMatchObject({ block: true });
    }
  });

  it("applies profile-specific production overrides", async () => {
    const harness = createExtensionHarness();
    await harness.start();

    const defaultCommit = await harness.callTool({
      toolName: "bash",
      input: { command: "git commit -m test" },
    });
    expect(defaultCommit).toMatchObject({ block: true });

    await harness.runCommand("profile", "address-comments");
    await expect(
      harness.callToolWithoutPrompt({
        toolName: "bash",
        input: { command: "git commit -m test" },
      }),
    ).resolves.toBeUndefined();

    await harness.runCommand("profile", "performance-review");
    await expect(
      harness.callToolWithoutPrompt({
        toolName: "bash",
        input: { command: "glab mr view 123" },
      }),
    ).resolves.toBeUndefined();
  });

  it("provides a read-only profile for non-destructive git history inspection", async () => {
    const harness = createExtensionHarness();
    await harness.start();

    await harness.runCommand("read-only");
    expect(harness.entries.at(-1)).toMatchObject({
      customType: "pi-permissions-profile",
      data: { profile: "read-only" },
    });
    expect(lastCallArgument(harness.ui.setStatus, 1)).toContain("🔎");
    expect(lastCallArgument(harness.ui.setStatus, 1)).toContain("read-only");

    await expect(
      harness.callToolWithoutPrompt({
        toolName: "bash",
        input: { command: "git log --all --graph --oneline" },
      }),
    ).resolves.toBeUndefined();

    await expect(
      harness.callToolWithoutPrompt({
        toolName: "bash",
        input: { command: "git show HEAD~3:src/example.ts" },
      }),
    ).resolves.toBeUndefined();

    await expect(
      harness.callToolWithoutPrompt({
        toolName: "read",
        input: { path: "README.md" },
      }),
    ).resolves.toBeUndefined();

    await expect(
      harness.callToolWithoutPrompt({
        toolName: "read",
        input: { path: "/tmp/pi-read-only-scratch.txt" },
      }),
    ).resolves.toBeUndefined();

    await expect(
      harness.callToolWithoutPrompt({
        toolName: "bash",
        input: { command: "find /tmp -maxdepth 1" },
      }),
    ).resolves.toBeUndefined();

    await expect(
      harness.callToolWithoutPrompt({
        toolName: "bash",
        input: {
          command: "git log --oneline > /tmp/pi-read-only-redirect.txt",
        },
      }),
    ).resolves.toBeUndefined();

    const outsideRead = await harness.callTool({
      toolName: "read",
      input: { path: path.resolve(process.cwd(), "../outside.txt") },
    });
    expect(outsideRead).toMatchObject({ block: true });
    expect(outsideRead?.reason).toContain("read-only profile");

    for (const command of [
      "find ../outside -maxdepth 1",
      "git log -- ../outside",
      "cd .. && ls",
    ]) {
      const denied = await harness.callTool({
        toolName: "bash",
        input: { command },
      });
      expect(denied).toMatchObject({ block: true });
      expect(denied?.reason).toContain("Bash path reference denied");
    }

    const outsideFind = await harness.callTool({
      toolName: "find",
      input: { path: path.resolve(process.cwd(), "../outside") },
    });
    expect(outsideFind).toMatchObject({ block: true });

    for (const command of [
      "git pull",
      "git checkout main",
      "git bisect start",
      "git log --oneline > history.txt",
    ]) {
      const denied = await harness.callTool({
        toolName: "bash",
        input: { command },
      });
      expect(denied).toMatchObject({ block: true });
    }

    for (const toolName of ["edit", "write"]) {
      const denied = await harness.callTool({
        toolName,
        input: { path: "notes.md", content: "not allowed" },
      });
      expect(denied).toMatchObject({ block: true });
    }

    for (const file of ["handoff.md", "progress.md"]) {
      await expect(
        harness.callToolWithoutPrompt({
          toolName: "write",
          input: { path: file, content: "allowed" },
        }),
      ).resolves.toBeUndefined();

      await expect(
        harness.callToolWithoutPrompt({
          toolName: "edit",
          input: { path: file, oldText: "allowed", newText: "updated" },
        }),
      ).resolves.toBeUndefined();
    }

    await expect(
      harness.callToolWithoutPrompt({
        toolName: "bash",
        input: { command: "git log --oneline > handoff.md" },
      }),
    ).resolves.toBeUndefined();
  });

  it("asks for unspecified commands and fails closed without a UI", async () => {
    const interactive = createExtensionHarness({ confirm: true });
    await interactive.start();
    await expect(
      interactive.callTool({
        toolName: "bash",
        input: { command: "python scripts/build.py" },
      }),
    ).resolves.toBeUndefined();
    expect(interactive.ui.confirm).toHaveBeenCalledOnce();

    const nonInteractive = createExtensionHarness({ hasUI: false });
    await nonInteractive.start();
    const blocked = await nonInteractive.callTool({
      toolName: "bash",
      input: { command: "python scripts/build.py" },
    });
    expect(blocked).toMatchObject({ block: true });
    expect(nonInteractive.ui.confirm).not.toHaveBeenCalled();
  });

  it("gates outside paths and denies protected paths through path tools", async () => {
    const harness = createExtensionHarness({ confirm: false });
    await harness.start();

    const outside = await harness.callTool({
      toolName: "read",
      input: { path: path.resolve(process.cwd(), "../outside.txt") },
    });
    expect(outside).toMatchObject({ block: true });
    expect(harness.ui.confirm).toHaveBeenCalledOnce();

    harness.ui.confirm.mockClear();
    const protectedPath = await harness.callTool({
      toolName: "read",
      input: { path: ".env" },
    });
    expect(protectedPath).toMatchObject({ block: true });
    expect(protectedPath?.reason).toContain("denied by policy");
    expect(harness.ui.confirm).not.toHaveBeenCalled();
  });

  it("returns configured steering from production deny rules", async () => {
    const harness = createExtensionHarness();
    await harness.start();

    const denied = await harness.callTool({
      toolName: "bash",
      input: { command: "npx vitest src/example.test.ts" },
    });

    expect(denied?.reason).toContain("Policy guidance:");
    expect(denied?.reason).toContain("npm test -- <requested test filters>");
  });
});
