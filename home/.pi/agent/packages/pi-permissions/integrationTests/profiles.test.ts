import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createExtensionHarness,
  lastCallArgument,
} from "./support/extensionHarness";
import { policyConfig } from "../modules/policy";

describe("permissions extension", () => {
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
    expect(
      harness
        .command("profile")
        .getArgumentCompletions?.("soc")
        ?.map((completion) => completion.value),
    ).toEqual(["socrates"]);
    expect(lastCallArgument(harness.ui.setStatus, 1)).toContain("🧠");
    expect(lastCallArgument(harness.ui.setStatus, 1)).toContain("socrates");
  });

  it("restores the persisted profile and applies its prompt and read-only policy", async () => {
    const firstSession = createExtensionHarness();
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

    await expect(
      harness.callTool({
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
        harness.callTool({
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

    await expect(
      harness.callTool({
        toolName: "bash",
        input: { command: "git log --oneline > /tmp/pi-history.txt" },
      }),
    ).resolves.toBeUndefined();

    await expect(
      harness.callTool({
        toolName: "read",
        input: { path: "/tmp/pi-history.txt" },
      }),
    ).resolves.toBeUndefined();

    await expect(
      harness.callTool({
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
      harness.callTool({
        toolName: "read",
        input: { path: ".env.template" },
      }),
    ).resolves.toBeUndefined();
  });

  it("validates shell reader inputs before broad command allow rules", async () => {
    const harness = createExtensionHarness();

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
        harness.callTool({ toolName: "bash", input: { command } }),
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
        harness.callTool({ toolName: "read", input: readInput }),
      ).resolves.toBeUndefined();
      await expect(
        harness.callTool({ toolName: "edit", input: editInput }),
      ).resolves.toBeUndefined();
    } finally {
      unprotectedProfile.protectedPathPatterns = originalPatterns;
      unprotectedProfile.protectedPathExceptions = originalExceptions;
    }
  });

  it("automatically excludes env files from searches", async () => {
    const harness = createExtensionHarness();

    const builtInGrepInput: {
      path: string;
      pattern: string;
      glob?: string;
    } = { path: ".", pattern: "DATABASE_URL" };
    await expect(
      harness.callTool({ toolName: "grep", input: builtInGrepInput }),
    ).resolves.toBeUndefined();
    expect(builtInGrepInput.glob).toBe(
      "!{**/.env*,**/.env*/**,**/.git,**/.git/**}",
    );

    const safeGlobInput = {
      path: ".",
      pattern: "DATABASE_URL",
      glob: "**/*.ts",
    };
    await expect(
      harness.callTool({ toolName: "grep", input: safeGlobInput }),
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
      harness.callTool({ toolName: "bash", input: ripgrepInput }),
    ).resolves.toBeUndefined();
    expect(ripgrepInput.command).toBe(
      "rg --glob '!**/.env*' --glob '!**/.env*/**' --glob '!**/.git' --glob '!**/.git/**' --glob '**/.env.template' DATABASE_URL .",
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

    const defaultCommit = await harness.callTool({
      toolName: "bash",
      input: { command: "git commit -m test" },
    });
    expect(defaultCommit).toMatchObject({ block: true });

    await harness.runCommand("profile", "address-comments");
    await expect(
      harness.callTool({
        toolName: "bash",
        input: { command: "git commit -m test" },
      }),
    ).resolves.toBeUndefined();

    await harness.runCommand("profile", "performance-review");
    await expect(
      harness.callTool({
        toolName: "bash",
        input: { command: "glab mr view 123" },
      }),
    ).resolves.toBeUndefined();
  });

  it("provides a read-only profile for non-destructive git history inspection", async () => {
    const harness = createExtensionHarness();

    await harness.runCommand("read-only");
    expect(harness.entries.at(-1)).toMatchObject({
      customType: "pi-permissions-profile",
      data: { profile: "read-only" },
    });
    expect(lastCallArgument(harness.ui.setStatus, 1)).toContain("🔎");
    expect(lastCallArgument(harness.ui.setStatus, 1)).toContain("read-only");

    await expect(
      harness.callTool({
        toolName: "bash",
        input: { command: "git log --all --graph --oneline" },
      }),
    ).resolves.toBeUndefined();

    await expect(
      harness.callTool({
        toolName: "bash",
        input: { command: "git show HEAD~3:src/example.ts" },
      }),
    ).resolves.toBeUndefined();

    await expect(
      harness.callTool({
        toolName: "read",
        input: { path: "README.md" },
      }),
    ).resolves.toBeUndefined();

    await expect(
      harness.callTool({
        toolName: "read",
        input: { path: "/tmp/pi-read-only-scratch.txt" },
      }),
    ).resolves.toBeUndefined();

    await expect(
      harness.callTool({
        toolName: "bash",
        input: { command: "find /tmp -maxdepth 1" },
      }),
    ).resolves.toBeUndefined();

    await expect(
      harness.callTool({
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
        harness.callTool({
          toolName: "write",
          input: { path: file, content: "allowed" },
        }),
      ).resolves.toBeUndefined();

      await expect(
        harness.callTool({
          toolName: "edit",
          input: { path: file, oldText: "allowed", newText: "updated" },
        }),
      ).resolves.toBeUndefined();
    }

    await expect(
      harness.callTool({
        toolName: "bash",
        input: { command: "git log --oneline > handoff.md" },
      }),
    ).resolves.toBeUndefined();
  });

  it("asks for unspecified commands and fails closed without a UI", async () => {
    const interactive = createExtensionHarness({ confirm: true });
    await expect(
      interactive.callTool({
        toolName: "bash",
        input: { command: "python scripts/build.py" },
      }),
    ).resolves.toBeUndefined();
    expect(interactive.ui.confirm).toHaveBeenCalledOnce();

    const nonInteractive = createExtensionHarness({ hasUI: false });
    const blocked = await nonInteractive.callTool({
      toolName: "bash",
      input: { command: "python scripts/build.py" },
    });
    expect(blocked).toMatchObject({ block: true });
    expect(nonInteractive.ui.confirm).not.toHaveBeenCalled();
  });

  it("gates outside paths and denies protected paths through path tools", async () => {
    const harness = createExtensionHarness({ confirm: false });

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

    const denied = await harness.callTool({
      toolName: "bash",
      input: { command: "npx vitest src/example.test.ts" },
    });

    expect(denied?.reason).toContain("Policy guidance:");
    expect(denied?.reason).toContain("npm test -- <requested test filters>");
  });
});
