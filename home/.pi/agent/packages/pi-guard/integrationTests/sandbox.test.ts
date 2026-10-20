import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { RuleSetName } from "../modules/ruleSets.lib/index";
import { createExtensionHarness } from "./support/extensionHarness";

const tempDirectories: string[] = [];

// These are OS-acceptance tests, so they must be able to initialize a real
// Seatbelt boundary. macOS rejects nested sandbox-exec invocations.
beforeAll(() => {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw new Error(
      `sandbox.test.ts requires a supported macOS or Linux backend; received '${process.platform}'.`,
    );
  }
  if (process.platform !== "darwin") return;

  const probe = spawnSync(
    "/usr/bin/sandbox-exec",
    ["-p", "(version 1) (allow default)", "/usr/bin/true"],
    { encoding: "utf8" },
  );
  const output = `${probe.stdout ?? ""}${probe.stderr ?? ""}`;
  const errorCode =
    probe.error && "code" in probe.error && typeof probe.error.code === "string"
      ? probe.error.code
      : undefined;
  if (
    errorCode === "EPERM" ||
    /sandbox_apply: Operation not permitted/i.test(output)
  ) {
    throw new Error(
      "sandbox.test.ts is an OS-acceptance suite and must run outside an existing macOS sandbox; sandbox-exec cannot create a nested sandbox.",
    );
  }
});

afterEach(() => {
  delete process.env.PI_GUARD_PROFILE_CONFIG;
  delete process.env.PI_SUBAGENT_PROFILE;
  delete process.env.PI_SUBAGENT_PERMISSIBLE_GLOBS;
  for (const fixture of tempDirectories.splice(0)) {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

function createLoopbackServer(): net.Server {
  return net.createServer((socket) => {
    // Clients in these sandbox tests can be terminated by the sandbox before
    // their close handshake completes. That reset is expected test transport
    // behavior, not an unhandled server failure.
    socket.on("error", (error) => {
      if ((error as NodeJS.ErrnoException).code !== "ECONNRESET") throw error;
    });
    socket.end("connected");
  });
}

function fixture() {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), `pi-sandbox-e2e-${crypto.randomUUID()}`),
  );
  tempDirectories.push(root);
  fs.mkdirSync(path.join(root, "allowed", "locked"), { recursive: true });
  fs.mkdirSync(path.join(root, "protected"));
  fs.mkdirSync(path.join(root, "outside"));
  fs.mkdirSync(path.join(root, "extra"));
  fs.mkdirSync(path.join(root, ".git"));
  fs.writeFileSync(path.join(root, "allowed", "ordinary"), "ordinary");
  fs.writeFileSync(path.join(root, "protected", "secret"), "do-not-disclose");
  fs.writeFileSync(path.join(root, "allowed", ".env"), "TOKEN=secret");
  fs.writeFileSync(path.join(root, "allowed", ".env.template"), "TOKEN=");
  fs.writeFileSync(path.join(root, ".env"), "TOKEN=secret");
  fs.writeFileSync(path.join(root, ".env.template"), "TOKEN=");
  fs.writeFileSync(path.join(root, ".git", "config"), "[core]\n");
  return root;
}

function runGit(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 10_000,
  });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${result.stderr || result.stdout}`,
    );
  }
  return result.stdout.trim();
}

function linkedWorktreeFixture(): { main: string; worktree: string } {
  const root = fs.mkdtempSync(
    path.join(import.meta.dirname, ".linked-worktree-"),
  );
  tempDirectories.push(root);
  const main = path.join(root, "main");
  const worktree = path.join(root, "worktree");
  fs.mkdirSync(main);
  runGit(main, ["init", "--initial-branch=main"]);
  runGit(main, ["config", "user.name", "Pi Guard Test"]);
  runGit(main, ["config", "user.email", "pi-guard@example.test"]);
  fs.writeFileSync(path.join(main, "base.txt"), "base\n");
  runGit(main, ["add", "base.txt"]);
  runGit(main, ["commit", "-m", "base"]);
  runGit(main, ["worktree", "add", "-b", "topic", worktree]);
  fs.writeFileSync(path.join(worktree, "topic.txt"), "topic\n");
  runGit(worktree, ["add", "topic.txt"]);
  runGit(worktree, ["commit", "-m", "topic"]);
  fs.writeFileSync(path.join(main, "main.txt"), "main\n");
  runGit(main, ["add", "main.txt"]);
  runGit(main, ["commit", "-m", "main"]);
  return { main, worktree };
}

function writeProfileConfig({
  sandboxOverrides = {},
  sandboxEnabled = true,
  runtimeRuleSets = [],
}: {
  sandboxOverrides?: Record<string, unknown>;
  sandboxEnabled?: boolean;
  runtimeRuleSets?: readonly RuleSetName[];
}): void {
  const configDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), `pi-sandbox-profile-${crypto.randomUUID()}`),
  );
  tempDirectories.push(configDirectory);
  const configPath = path.join(configDirectory, "profiles.jsonc");
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      defaultProfile: "sandbox-acceptance",
      profiles: {
        "sandbox-acceptance": {
          description:
            "Sandbox acceptance profile for protected paths and filesystem boundaries",
          // Unparsed interpreter expressions remain ordinary `ask` decisions;
          // this transform intentionally auto-approves them so these tests
          // prove the registered Bash override supplies the OS boundary.
          extends: ["builtin:default", ...runtimeRuleSets],
          transforms: ["transform:allow-asks"],
          readPaths: [{ pattern: "*", decision: "allow" }],
          writePaths: [{ pattern: "*", decision: "allow" }],
          protectedPathRules: [
            { pattern: "**/.env*", decision: "deny" },
            { pattern: "**/.env.template", decision: "allow" },
            { pattern: "protected/**", decision: "deny" },
            { pattern: "allowed/locked/**", decision: "deny" },
            { pattern: "**/.git", decision: "deny" },
            { pattern: "**/.git/**", decision: "deny" },
          ],
          sandbox: sandboxEnabled
            ? {
                network: "deny",
                allowLocalBinding: false,
                overwritePathArrays: ["kernelUnenforcedProtectedPaths"],
                extraWritePaths: ["extra"],
                extraDenyWritePaths: ["outside"],
                ...sandboxOverrides,
              }
            : false,
        },
        // A disabled selected profile still needs a configured sandbox-capable
        // profile so the extension registers its one switchable Bash override.
        "sandbox-capable": {
          description:
            "Sandbox-capable fallback profile for switchable Bash boundaries",
          extends: ["builtin:default"],
          sandbox: { network: "deny" },
        },
      },
    }),
  );
  process.env.PI_GUARD_PROFILE_CONFIG = configPath;
}

function writeOverwriteProfileConfig(
  parentWritable: string,
  childWritable: string,
): void {
  const configDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), `pi-sandbox-profile-${crypto.randomUUID()}`),
  );
  tempDirectories.push(configDirectory);
  const configPath = path.join(configDirectory, "profiles.jsonc");
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      defaultProfile: "child",
      profiles: {
        parent: {
          description:
            "Synthetic parent profile granting one extra writable path",
          extends: ["builtin:default"],
          // Keep the policy gate permissive so this test isolates the kernel
          // write boundary rather than protected-path or operand decisions.
          readPaths: [{ pattern: "*", decision: "allow" }],
          writePaths: [{ pattern: "*", decision: "allow" }],
          protectedPathRules: [],
          sandbox: {
            network: "deny",
            extraWritePaths: [parentWritable],
          },
        },
        child: {
          description:
            "Synthetic child profile replacing the parent's extra writable path",
          extends: ["parent"],
          sandbox: {
            overwritePathArrays: ["extraWritePaths"],
            extraWritePaths: [childWritable],
          },
        },
      },
    }),
  );
  process.env.PI_GUARD_PROFILE_CONFIG = configPath;
}

function writeComposedProfileConfig(): void {
  const configDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), `pi-sandbox-profile-${crypto.randomUUID()}`),
  );
  tempDirectories.push(configDirectory);
  const configPath = path.join(configDirectory, "profiles.jsonc");
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      defaultProfile: "inherited",
      profiles: {
        base: {
          description:
            "Base profile for composed denied-network sandbox posture",
          extends: ["builtin:default"],
          sandbox: {
            network: "deny",
            allowLocalBinding: false,
            overwritePathArrays: ["kernelUnenforcedProtectedPaths"],
            extraWritePaths: ["inherited-token-lock"],
          },
        },
        inherited: {
          description:
            "Inherited profile retaining its base sandbox capabilities",
          extends: ["base"],
        },
        replacement: {
          description:
            "Replacement profile overriding the inherited sandbox network posture",
          extends: ["base"],
          sandbox: { network: "allow" },
        },
        disabled: {
          description:
            "Disabled profile explicitly turning off the inherited sandbox",
          extends: ["base"],
          sandbox: false,
        },
      },
    }),
  );
  process.env.PI_GUARD_PROFILE_CONFIG = configPath;
}

function exitCodeFrom({ result }: { result: unknown }): number {
  if (
    typeof result !== "object" ||
    result === null ||
    !("details" in result) ||
    typeof result.details !== "object" ||
    result.details === null ||
    !("exitCode" in result.details) ||
    typeof result.details.exitCode !== "number"
  ) {
    throw new Error("Registered Bash tool did not return a numeric exit code");
  }
  return result.details.exitCode;
}

async function runThroughPi({
  root,
  command,
  sandboxOverrides = {},
  sandboxEnabled = true,
  timeout = 10,
  signal,
  profile,
  runtimeRuleSets,
}: {
  root: string;
  command: string;
  sandboxOverrides?: Record<string, unknown>;
  sandboxEnabled?: boolean;
  timeout?: number;
  signal?: AbortSignal;
  profile?: string;
  runtimeRuleSets?: readonly RuleSetName[];
}): Promise<number> {
  writeProfileConfig({
    sandboxOverrides,
    sandboxEnabled,
    runtimeRuleSets,
  });
  if (profile) process.env.PI_SUBAGENT_PROFILE = profile;
  const harness = createExtensionHarness({ contextCwd: root, hasUI: false });
  await harness.start();
  try {
    const gate = await harness.callTool({
      toolName: "bash",
      input: { command, timeout },
    });
    expect(gate?.block, gate?.reason).not.toBe(true);
    return exitCodeFrom({
      result: await harness.executeTool({
        name: "bash",
        params: { command, timeout },
        options: { signal },
      }),
    });
  } finally {
    await harness.shutdown();
  }
}

function node({ source }: { source: string }): string {
  return `node -e ${JSON.stringify(source)}`;
}

/**
 * Full acceptance path: Pi lifecycle and tool-call gate → this package's
 * registered Bash override → real platform backend → fixture filesystem.
 * Commands involving protected paths use Node expressions deliberately: the
 * gate cannot infer arbitrary interpreter code, so the kernel boundary is the
 * behavior under test.
 */
describe("sandbox full-harness OS acceptance", () => {
  it("extra-root precedence creates a real sibling Git worktree without widening the gate or denies", async () => {
    // All repository and profile fixtures stay in this checkout, never HOME
    // or an external temporary directory. Do not use the allow-asks helper.
    const root = fs.mkdtempSync(path.join(import.meta.dirname, ".extra-root-"));
    tempDirectories.push(root);
    const main = path.join(root, "main");
    const trees = path.join(root, "trees");
    const workspace = path.join(trees, "source");
    const target = path.join(trees, "target");
    fs.mkdirSync(main);
    fs.mkdirSync(trees);
    function git({ args }: { args: string[] }): void {
      const result = spawnSync("git", args, {
        cwd: main,
        encoding: "utf8",
        timeout: 10_000,
      });
      if (result.status !== 0) throw new Error(result.stderr || "Git failed");
    }
    git({ args: ["init", "--initial-branch=main"] });
    fs.writeFileSync(path.join(main, "base.txt"), "base\n");
    git({ args: ["add", "base.txt"] });
    git({
      args: [
        "-c",
        "user.name=Pi Guard Test",
        "-c",
        "user.email=pi-guard@example.test",
        "commit",
        "-m",
        "base",
      ],
    });
    git({ args: ["worktree", "add", "--detach", workspace] });
    for (const name of ["protected", "locked"]) {
      fs.mkdirSync(path.join(trees, name));
    }
    const configPath = path.join(root, "profiles.jsonc");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        defaultProfile: "baseline",
        profiles: {
          baseline: {
            description: "Unmodified default sandbox boundary",
            extends: ["builtin:default"],
          },
          granted: {
            description:
              "Explicit sibling worktree roots retaining inherited asks",
            extends: ["baseline"],
            protectedPathRules: [
              { pattern: path.join(trees, "protected"), decision: "deny" },
            ],
            sandbox: {
              network: "deny",
              extraWritePaths: [path.join(main, ".git"), trees],
              extraDenyWritePaths: [path.join(trees, "locked")],
            },
          },
          denied: {
            description: "Explicit ancestor deny must beat the extra root",
            extends: ["granted"],
            writePaths: [{ pattern: trees, decision: "deny" }],
          },
          worker: {
            description: "Worker retaining its outside-workspace denies",
            extends: ["builtin:worker"],
            tools: { bash: [{ pattern: "node *", decision: "allow" }] },
          },
          "worker-granted": {
            description: "A sibling grant cannot reopen worker parent denies",
            extends: ["worker"],
            sandbox: { extraWritePaths: [target] },
          },
        },
      }),
    );
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    function createWorkspaceHarness() {
      // The gate captures process.cwd at extension registration, separately
      // from the execution context. Reproduce a Pi started in the worktree.
      const previousCwd = process.cwd();
      try {
        process.chdir(workspace);
        return createExtensionHarness({ contextCwd: workspace, confirm: true });
      } finally {
        process.chdir(previousCwd);
      }
    }
    const harness = createWorkspaceHarness();
    await harness.start();
    async function execute({
      source,
      success,
    }: {
      source: string;
      success: boolean;
    }): Promise<void> {
      const command = node({ source });
      // Approve this opaque interpreter request only; never transform path asks.
      const gate = await harness.callTool({
        toolName: "bash",
        input: { command, timeout: 10 },
      });
      expect(gate?.block, gate?.reason).not.toBe(true);
      const result = await harness.executeTool({
        name: "bash",
        params: { command, timeout: 10 },
      });
      const code = exitCodeFrom({ result });
      if (success) {
        expect(code, JSON.stringify(result)).toBe(0);
      } else {
        expect(code, JSON.stringify(result)).not.toBe(0);
        expect(JSON.stringify(result)).toMatch(
          /EPERM|EACCES|EROFS|Operation not permitted/,
        );
      }
    }
    try {
      expect(harness.errors).toEqual([]);
      await execute({
        source: `require('fs').writeFileSync(${JSON.stringify(path.join(trees, "default-marker"))}, 'blocked')`,
        success: false,
      });
      expect(fs.existsSync(path.join(trees, "default-marker"))).toBe(false);
      await harness.runCommand({ name: "profile-select", args: "granted" });
      const promptsBefore = harness.customComponents.length;
      const directGate = await harness.callTool({
        toolName: "write",
        input: { path: path.join(trees, "direct-marker"), content: "ask" },
      });
      expect(directGate?.block).not.toBe(true);
      expect(harness.customComponents.length).toBeGreaterThan(promptsBefore);
      await execute({
        source: [
          "const fs = require('fs');",
          `require('child_process').execFileSync('git', ['worktree', 'add', '--detach', ${JSON.stringify(target)}], { timeout: 10000 });`,
          "fs.writeFileSync('workspace-marker', 'ok');",
          `for (const destination of ${JSON.stringify([path.join(trees, "protected", "marker"), path.join(trees, "locked", "marker"), path.join(root, "unapproved-marker")])}) {`,
          "try { fs.writeFileSync(destination, 'escaped'); throw new Error('Unexpected writable path: ' + destination); }",
          "catch (error) { if (!['EPERM', 'EACCES', 'EROFS'].includes(error.code)) throw error; }",
          "}",
        ].join(" "),
        success: true,
      });
      expect(fs.readFileSync(path.join(target, ".git"), "utf8")).toMatch(
        /^gitdir: /,
      );
      expect(fs.readFileSync(path.join(target, "base.txt"), "utf8")).toBe(
        "base\n",
      );
      expect(
        fs.readFileSync(path.join(workspace, "workspace-marker"), "utf8"),
      ).toBe("ok");
      for (const marker of ["protected/marker", "locked/marker"]) {
        expect(fs.existsSync(path.join(trees, marker))).toBe(false);
      }
      expect(fs.existsSync(path.join(root, "unapproved-marker"))).toBe(false);
      await harness.runCommand({ name: "profile-select", args: "denied" });
      await execute({
        source: `require('fs').writeFileSync(${JSON.stringify(path.join(trees, "denied-marker"))}, 'blocked')`,
        success: false,
      });
      expect(fs.existsSync(path.join(trees, "denied-marker"))).toBe(false);
      await harness.runCommand({ name: "profile-select", args: "worker" });
      await execute({
        source: "require('fs').writeFileSync('worker-marker', 'ok')",
        success: true,
      });
      expect(
        fs.readFileSync(path.join(workspace, "worker-marker"), "utf8"),
      ).toBe("ok");
      await harness.runCommand({
        name: "profile-select",
        args: "worker-granted",
      });
      await execute({
        source: `require('fs').writeFileSync(${JSON.stringify(path.join(target, "worker-denied-marker"))}, 'blocked')`,
        success: false,
      });
      expect(fs.existsSync(path.join(target, "worker-denied-marker"))).toBe(
        false,
      );
    } finally {
      await harness.shutdown();
    }
    process.env.PI_SUBAGENT_PERMISSIBLE_GLOBS = ".";
    const scoped = createWorkspaceHarness();
    await scoped.start();
    try {
      await scoped.runCommand({ name: "profile-select", args: "granted" });
      const command = node({
        source: `require('fs').writeFileSync(${JSON.stringify(path.join(trees, "scoped-marker"))}, 'blocked')`,
      });
      const gate = await scoped.callTool({
        toolName: "bash",
        input: { command, timeout: 10 },
      });
      expect(gate?.block, gate?.reason).not.toBe(true);
      expect(
        exitCodeFrom({
          result: await scoped.executeTool({
            name: "bash",
            params: { command, timeout: 10 },
          }),
        }),
      ).not.toBe(0);
      expect(fs.existsSync(path.join(trees, "scoped-marker"))).toBe(false);
      expect(scoped.errors).toEqual([]);
    } finally {
      await scoped.shutdown();
    }
  }, 40_000);

  it("allows an unparsed protected read without sandboxing and denies the identical read when sandboxed", async () => {
    const localRoot = fixture();
    const expression = node({
      source:
        "require('fs').writeFileSync('allowed/disclosed', require('fs').readFileSync('protected/secret'))",
    });
    expect(
      await runThroughPi({
        root: localRoot,
        command: expression,
        sandboxEnabled: false,
      }),
    ).toBe(0);
    expect(
      fs.readFileSync(path.join(localRoot, "allowed", "disclosed"), "utf8"),
    ).toBe("do-not-disclose");

    const sandboxedRoot = fixture();
    expect(
      await runThroughPi({ root: sandboxedRoot, command: expression }),
    ).not.toBe(0);
    expect(
      fs.existsSync(path.join(sandboxedRoot, "allowed", "disclosed")),
    ).toBe(false);

    // The session commands must provide the same boundary transition without
    // requiring a profile-config change or a new Pi session.
    const toggledRoot = fixture();
    writeProfileConfig({});
    const harness = createExtensionHarness({
      contextCwd: toggledRoot,
      hasUI: false,
    });
    await harness.start();
    try {
      await harness.runCommand("sandbox-off");
      expect(
        exitCodeFrom({
          result: await harness.executeTool({
            name: "bash",
            params: { command: expression, timeout: 10 },
          }),
        }),
      ).toBe(0);
      expect(
        fs.readFileSync(path.join(toggledRoot, "allowed", "disclosed"), "utf8"),
      ).toBe("do-not-disclose");

      fs.rmSync(path.join(toggledRoot, "allowed", "disclosed"));
      await harness.runCommand("sandbox-on");
      expect(
        exitCodeFrom({
          result: await harness.executeTool({
            name: "bash",
            params: { command: expression, timeout: 10 },
          }),
        }),
      ).not.toBe(0);
      expect(
        fs.existsSync(path.join(toggledRoot, "allowed", "disclosed")),
      ).toBe(false);
    } finally {
      await harness.shutdown();
    }
  });

  it("selects inherited, replacement, and explicitly disabled sandbox postures from a composed custom profile", async () => {
    const root = fixture();
    const server = createLoopbackServer();
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("Test loopback server did not provide a TCP port");
      }
      const command = node({
        source: `require('net').connect(${address.port}, '127.0.0.1').once('connect', () => process.exit(0)).once('error', () => process.exit(1))`,
      });
      writeComposedProfileConfig();
      const harness = createExtensionHarness({
        contextCwd: root,
        hasUI: false,
      });
      await harness.start();
      try {
        expect(
          exitCodeFrom({
            result: await harness.executeTool({
              name: "bash",
              params: { command, timeout: 10 },
            }),
          }),
        ).not.toBe(0);

        await harness.runCommand({
          name: "profile-select",
          args: "replacement",
        });
        expect(
          exitCodeFrom({
            result: await harness.executeTool({
              name: "bash",
              params: { command, timeout: 10 },
            }),
          }),
        ).toBe(0);

        await harness.runCommand({
          name: "profile-select",
          args: "disabled",
        });
        expect(
          exitCodeFrom({
            result: await harness.executeTool({
              name: "bash",
              params: { command, timeout: 10 },
            }),
          }),
        ).toBe(0);
      } finally {
        await harness.shutdown();
      }
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("retains inherited writable paths when a child inherits the sandbox", async () => {
    const root = fixture();
    writeComposedProfileConfig();
    const harness = createExtensionHarness({ contextCwd: root, hasUI: false });
    await harness.start();
    try {
      const command = node({
        source:
          "require('fs').mkdirSync('inherited-token-lock', { recursive: true }); require('fs').writeFileSync('inherited-token-lock/token.lock', 'locked')",
      });
      expect(
        exitCodeFrom({
          result: await harness.executeTool({
            name: "bash",
            params: { command, timeout: 10 },
          }),
        }),
      ).toBe(0);
      expect(
        fs.readFileSync(
          path.join(root, "inherited-token-lock/token.lock"),
          "utf8",
        ),
      ).toBe("locked");
    } finally {
      await harness.shutdown();
    }
  });

  it("overwrites inherited extra write paths only when the child explicitly replaces them", async () => {
    const root = fixture();
    // CWD descendants are already writable under the sandbox, so create
    // unique absolute exception roots outside it to prove overwrite semantics.
    const parentWritable = fs.mkdtempSync(
      path.join(os.tmpdir(), `pi-sandbox-parent-${crypto.randomUUID()}-`),
    );
    const childWritable = fs.mkdtempSync(
      path.join(os.tmpdir(), `pi-sandbox-child-${crypto.randomUUID()}-`),
    );
    tempDirectories.push(parentWritable, childWritable);
    writeOverwriteProfileConfig(parentWritable, childWritable);
    const harness = createExtensionHarness({ contextCwd: root, hasUI: false });
    await harness.start();
    try {
      expect(
        exitCodeFrom({
          result: await harness.executeTool({
            name: "bash",
            params: {
              command: `printf child-content > ${JSON.stringify(path.join(childWritable, "child-marker"))}`,
              timeout: 10,
            },
          }),
        }),
      ).toBe(0);
      expect(
        fs.readFileSync(path.join(childWritable, "child-marker"), "utf8"),
      ).toBe("child-content");

      expect(
        exitCodeFrom({
          result: await harness.executeTool({
            name: "bash",
            params: {
              command: `printf parent-content > ${JSON.stringify(path.join(parentWritable, "parent-marker"))}`,
              timeout: 10,
            },
          }),
        }),
      ).not.toBe(0);
      expect(fs.existsSync(path.join(parentWritable, "parent-marker"))).toBe(
        false,
      );
    } finally {
      await harness.shutdown();
    }
  });

  it("rejects a direct protected operand at the gate before Bash can create a marker", async () => {
    const root = fixture();
    writeProfileConfig({});
    const harness = createExtensionHarness({ contextCwd: root, hasUI: false });
    await harness.start();
    try {
      const gate = await harness.callTool({
        toolName: "bash",
        input: {
          command: "cat protected/secret > allowed/gate-marker",
          timeout: 10,
        },
      });
      expect(gate).toMatchObject({ block: true });
      expect(fs.existsSync(path.join(root, "allowed", "gate-marker"))).toBe(
        false,
      );
    } finally {
      await harness.shutdown();
    }
  });

  it("reads an ordinary allowed fixture", async () => {
    const root = fixture();
    expect(await runThroughPi({ root, command: "cat allowed/ordinary" })).toBe(
      0,
    );
  });

  it("gives every sandboxed Pi process a private, existing SRT temporary directory", async () => {
    const root = fixture();
    const output = path.join(root, "allowed", "sandbox-tmpdir");

    expect(
      await runThroughPi({
        root,
        command: node({
          source:
            "require('fs').writeFileSync('allowed/sandbox-tmpdir', process.env.TMPDIR)",
        }),
      }),
    ).toBe(0);

    const temporaryDirectory = fs.readFileSync(output, "utf8");
    expect(temporaryDirectory).toMatch(/^\/private\/tmp\/pi-guard-/);
    expect(fs.statSync(temporaryDirectory).isDirectory()).toBe(true);
    expect(fs.statSync(temporaryDirectory).mode & 0o777).toBe(0o700);
  });

  it("runs a project Vitest script with only the exact Vite temporary root", async () => {
    // Keep the fixture beneath this package so npm resolves the real installed
    // Vitest binary from the ancestor node_modules, while Vite still creates
    // its runtime directory beneath the fixture's own startup root.
    const root = path.resolve(import.meta.dirname, "fixtures/vitest-runtime");
    const fixtureNodeModules = path.join(root, "node_modules");
    fs.rmSync(fixtureNodeModules, { recursive: true, force: true });
    fs.mkdirSync(fixtureNodeModules);
    process.env.PI_SUBAGENT_PERMISSIBLE_GLOBS = "runtime.fixture.ts";
    const runtimeRuleSets = [
      "ruleset:go-runtime-commands",
      "ruleset:vitest",
    ] as const satisfies readonly RuleSetName[];

    try {
      expect(
        await runThroughPi({
          root,
          command: "npm test",
          timeout: 120,
          runtimeRuleSets,
        }),
      ).toBe(0);

      for (const relativePath of [
        "node_modules/.vite-temp-sibling/marker",
        "node_modules/broad-marker",
      ]) {
        expect(
          await runThroughPi({
            root,
            command: node({
              source: `const fs = require('fs'); const path = require('path'); const target = ${JSON.stringify(relativePath)}; fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, 'blocked');`,
            }),
            runtimeRuleSets,
          }),
        ).not.toBe(0);
        expect(fs.existsSync(path.join(root, relativePath))).toBe(false);
      }
    } finally {
      fs.rmSync(fixtureNodeModules, { recursive: true, force: true });
    }
  });

  it("permits Go's module-cache metadata through the complete sandboxed Pi path", async () => {
    const root = fixture();
    const cacheParent = path.join(
      os.homedir(),
      "go",
      "pkg",
      "mod",
      "cache",
      "download",
    );
    expect(fs.existsSync(cacheParent)).toBe(true);

    // Go writes module stat and download metadata here even when all required
    // source modules are already cached. This executes through the complete Pi
    // tool, policy gate, SRT wrapper, and macOS Seatbelt backend.
    expect(
      await runThroughPi({
        root,
        command: node({
          source:
            "const fs = require('fs'); const path = require('path'); const directory = fs.mkdtempSync(path.join(process.env.HOME, 'go/pkg/mod/cache/download/pi-guard-sandbox-')); fs.rmSync(directory, { recursive: true });",
        }),
        runtimeRuleSets: ["ruleset:go-runtime-commands"],
      }),
    ).toBe(0);
  });

  it("runs Go through the complete sandboxed Pi path with SRT's private TMPDIR", async () => {
    const root = fixture();
    fs.writeFileSync(path.join(root, "go.mod"), "module sandbox-temp-check\n");
    const programDirectory = path.join(root, "allowed", "go-temp-check");
    fs.mkdirSync(programDirectory);
    fs.writeFileSync(
      path.join(programDirectory, "main.go"),
      `package main

import (
  "os"
  "path/filepath"
)

func main() {
  directory, err := os.MkdirTemp("", "pi-guard-go-")
  if err != nil {
    panic(err)
  }
  defer os.RemoveAll(directory)
  if err := os.WriteFile(filepath.Join(directory, "written"), []byte("ok"), 0o600); err != nil {
    panic(err)
  }
}
`,
    );

    // This is the user-facing failure mode: Go must create its compiler work
    // directory before it can compile or run the program. Execute it through
    // the real Pi tool, policy gate, SRT wrapper, and macOS Seatbelt backend.
    expect(
      await runThroughPi({
        root,
        command: "go run ./allowed/go-temp-check",
        timeout: 120,
        runtimeRuleSets: ["ruleset:go-runtime-commands"],
      }),
    ).toBe(0);
  });

  it("permits a /tmp mktemp directory through macOS's /private/tmp resolution", async () => {
    const root = fixture();
    const createAndRemoveTempDirectory = node({
      source:
        "const fs = require('fs'); const directory = fs.mkdtempSync('/tmp/pi-guard-mktemp-'); fs.rmSync(directory, { recursive: true });",
    });

    expect(
      await runThroughPi({ root, command: createAndRemoveTempDirectory }),
    ).toBe(0);
  });

  it("preserves a successful exit code when command output resembles a kernel denial", async () => {
    const root = fixture();
    expect(
      await runThroughPi({
        root,
        command: "printf 'operation not permitted\\n'",
      }),
    ).toBe(0);
  });

  it("creates and overwrites a direct allowed file", async () => {
    const root = fixture();
    expect(
      await runThroughPi({ root, command: "printf first > allowed/created" }),
    ).toBe(0);
    expect(
      await runThroughPi({ root, command: "printf second > allowed/created" }),
    ).toBe(0);
    expect(fs.readFileSync(path.join(root, "allowed", "created"), "utf8")).toBe(
      "second",
    );
  });

  it("creates a nested allowed descendant after changing directory", async () => {
    const root = fixture();
    fs.mkdirSync(path.join(root, "allowed", "nested"));
    expect(
      await runThroughPi({
        root,
        command: "cd allowed/nested && printf allowed > created",
      }),
    ).toBe(0);
    expect(
      fs.readFileSync(path.join(root, "allowed", "nested", "created"), "utf8"),
    ).toBe("allowed");
  });

  it("permits an explicit extra write root", async () => {
    const root = fixture();
    expect(
      await runThroughPi({ root, command: "printf extra > extra/created" }),
    ).toBe(0);
    expect(fs.readFileSync(path.join(root, "extra", "created"), "utf8")).toBe(
      "extra",
    );
  });

  it.each([
    ["a direct relative path", "printf denied > outside/direct", "direct"],
    [
      "an absolute path",
      ({ root }: { root: string }) =>
        `printf denied > ${path.join(root, "outside", "absolute")}`,
      "absolute",
    ],
    [
      "normalized traversal",
      "printf denied > allowed/../outside/normalized",
      "normalized",
    ],
    [
      "multiple cd steps",
      "cd allowed && cd .. && cd outside && printf denied > cd",
      "cd",
    ],
    ["a tee redirect", "printf denied | tee outside/tee", "tee"],
    ["an append redirect", "printf denied >> outside/append", "append"],
    [
      "a here-document redirect",
      "cat <<'EOF' > outside/heredoc\ndenied\nEOF",
      "heredoc",
    ],
  ])("denies an outside write through %s", async (_name, command, filename) => {
    const root = fixture();
    const resolvedCommand =
      typeof command === "function" ? command({ root }) : command;
    expect(await runThroughPi({ root, command: resolvedCommand })).not.toBe(0);
    expect(fs.existsSync(path.join(root, "outside", filename))).toBe(false);
  });

  it("denies an unparsed read of a protected file", async () => {
    const root = fixture();
    expect(
      await runThroughPi({
        root,
        command: node({
          source:
            "process.stdout.write(require('fs').readFileSync('protected/secret'))",
        }),
      }),
    ).not.toBe(0);
  });

  it("denies reads of protected environment files", async () => {
    const root = fixture();
    expect(
      await runThroughPi({
        root,
        command: node({
          source:
            "process.stdout.write(require('fs').readFileSync('allowed/.env'))",
        }),
      }),
    ).not.toBe(0);
  });

  it("gate-denies a direct protected write and sandbox-denies an implicit write", async () => {
    const root = fixture();
    writeProfileConfig({});
    const harness = createExtensionHarness({ contextCwd: root, hasUI: false });
    await harness.start();
    try {
      const gate = await harness.callTool({
        toolName: "bash",
        input: { command: "printf changed > protected/secret", timeout: 10 },
      });
      expect(gate).toMatchObject({ block: true });
      expect(
        fs.readFileSync(path.join(root, "protected", "secret"), "utf8"),
      ).toBe("do-not-disclose");
    } finally {
      await harness.shutdown();
    }

    expect(
      await runThroughPi({
        root,
        command: node({
          source: "require('fs').writeFileSync('protected/secret', 'changed')",
        }),
      }),
    ).not.toBe(0);
    expect(
      fs.readFileSync(path.join(root, "protected", "secret"), "utf8"),
    ).toBe("do-not-disclose");
  });

  it("denies an unparsed write to a protected environment file", async () => {
    const root = fixture();
    expect(
      await runThroughPi({
        root,
        command: node({
          source: "require('fs').writeFileSync('allowed/.env', 'changed')",
        }),
      }),
    ).not.toBe(0);
  });

  it("allows explicitly excepted environment templates", async () => {
    const root = fixture();
    expect(await runThroughPi({ root, command: "cat .env.template" })).toBe(0);
    expect(
      await runThroughPi({ root, command: "cat allowed/.env.template" }),
    ).toBe(0);
  });

  it("denies a protected child within an otherwise allowed root", async () => {
    const root = fixture();
    expect(
      await runThroughPi({
        root,
        command: node({
          source:
            "require('fs').writeFileSync('allowed/locked/created', 'locked')",
        }),
      }),
    ).not.toBe(0);
    expect(fs.existsSync(path.join(root, "allowed", "locked", "created"))).toBe(
      false,
    );
  });

  it("cannot create a new file through a symlink from an allowed root", async () => {
    const root = fixture();
    fs.symlinkSync(
      path.join(root, "outside"),
      path.join(root, "allowed", "escape"),
    );
    expect(
      await runThroughPi({
        root,
        command: "printf escaped > allowed/escape/created",
      }),
    ).not.toBe(0);
    expect(fs.existsSync(path.join(root, "outside", "created"))).toBe(false);
  });

  it("cannot overwrite an existing file through a symlink from an allowed root", async () => {
    const root = fixture();
    fs.writeFileSync(path.join(root, "outside", "existing"), "original");
    fs.symlinkSync(
      path.join(root, "outside"),
      path.join(root, "allowed", "escape"),
    );
    expect(
      await runThroughPi({
        root,
        command: "printf escaped > allowed/escape/existing",
      }),
    ).not.toBe(0);
    expect(
      fs.readFileSync(path.join(root, "outside", "existing"), "utf8"),
    ).toBe("original");
  });

  it("cannot create a hard link outside the allowed root", async () => {
    const root = fixture();
    expect(
      await runThroughPi({
        root,
        command: "ln allowed/ordinary outside/hard-link",
      }),
    ).not.toBe(0);
    expect(fs.existsSync(path.join(root, "outside", "hard-link"))).toBe(false);
  });

  it("cannot rename an allowed file outside the allowed root", async () => {
    const root = fixture();
    expect(
      await runThroughPi({
        root,
        command: "mv allowed/ordinary outside/renamed",
      }),
    ).not.toBe(0);
    expect(fs.existsSync(path.join(root, "outside", "renamed"))).toBe(false);
    expect(fs.existsSync(path.join(root, "allowed", "ordinary"))).toBe(true);
  });

  it("runs Python in the fixture before asserting Python containment", async () => {
    const root = fixture();
    expect(
      await runThroughPi({
        root,
        command: "python3 -c \"open('allowed/python', 'w').write('allowed')\"",
      }),
    ).toBe(0);
    expect(fs.readFileSync(path.join(root, "allowed", "python"), "utf8")).toBe(
      "allowed",
    );
  });

  it.each([
    ["nested shell", "sh -c 'printf escaped > outside/sh'", "sh", true],
    [
      "Node interpreter",
      node({
        source: "require('fs').writeFileSync('outside/node', 'escaped')",
      }),
      "node",
      true,
    ],
    [
      "Python interpreter",
      "python3 -c \"open('outside/python', 'w').write('escaped')\"",
      "python",
      true,
    ],
    [
      "background grandchild",
      'sh -c "(sleep 0.05; printf escaped > outside/grandchild) & wait"',
      "grandchild",
      false,
    ],
  ])(
    "contains an outside write by a %s",
    async (_type, command, filename, childFailurePropagates) => {
      const root = fixture();
      const exitCode = await runThroughPi({ root, command });
      if (childFailurePropagates) {
        expect(exitCode).not.toBe(0);
      } else {
        expect(exitCode).toBe(0);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(fs.existsSync(path.join(root, "outside", filename))).toBe(false);
    },
  );

  it.each(["builtin:committer", "builtin:git-full"])(
    "%s stages and commits in a linked worktree without opening its sibling checkout",
    async (profile) => {
      const { main, worktree } = linkedWorktreeFixture();
      const originalMainHead = runGit(main, ["rev-parse", "HEAD"]);
      const originalTopicHead = runGit(worktree, ["rev-parse", "HEAD"]);
      fs.writeFileSync(path.join(worktree, "change.txt"), "linked change\n");
      fs.writeFileSync(
        path.join(worktree, ".npmrc"),
        "//registry.example.test/:_authToken=secret\n",
      );
      // No user configuration: exercise only the portable shipped policies.
      process.env.PI_GUARD_PROFILE_CONFIG = path.join(worktree, "absent.jsonc");
      delete process.env.PI_SUBAGENT_PROFILE;
      delete process.env.PI_SUBAGENT_PERMISSIBLE_GLOBS;
      const previousCwd = process.cwd();
      const harness = (() => {
        try {
          // Both the gate's immutable startup directory and Bash's cwd must be
          // the linked checkout, not the package directory running Vitest.
          process.chdir(worktree);
          return createExtensionHarness({
            contextCwd: worktree,
            hasUI: false,
            flags: new Map([["guard-profile", profile]]),
          });
        } finally {
          process.chdir(previousCwd);
        }
      })();
      await harness.start();
      try {
        expect(harness.errors).toEqual([]);
        // Metadata access must not change command tiers. Do not execute a push.
        const push = await harness.callTool({
          toolName: "bash",
          input: { command: "git push", timeout: 10 },
        });
        expect(push?.block === true).toBe(profile === "builtin:committer");
        // Retain dependency guards, protected metadata/secrets, and outside-
        // workspace asks (blocked without a UI).
        for (const command of [
          "npm install unexpected-package",
          "git add .npmrc",
          "cat .git",
          `printf blocked > ${JSON.stringify(path.join(main, "outside-marker"))}`,
        ]) {
          expect(
            await harness.callTool({
              toolName: "bash",
              input: { command, timeout: 10 },
            }),
            command,
          ).toMatchObject({ block: true });
        }
        for (const command of [
          "git add change.txt",
          "git commit -m 'linked sandbox commit'",
        ]) {
          const gate = await harness.callTool({
            toolName: "bash",
            input: { command, timeout: 10 },
          });
          expect(gate?.block, gate?.reason).not.toBe(true);
          const result = await harness.executeTool({
            name: "bash",
            params: { command, timeout: 10 },
          });
          expect(exitCodeFrom({ result }), JSON.stringify(result)).toBe(0);
        }
        expect(runGit(worktree, ["rev-parse", "HEAD^"])).toBe(
          originalTopicHead,
        );
        expect(runGit(worktree, ["show", "HEAD:change.txt"])).toBe(
          "linked change",
        );
        expect(
          runGit(worktree, ["status", "--porcelain", "--", "change.txt"]),
        ).toBe("");
        expect(runGit(main, ["rev-parse", "HEAD"])).toBe(originalMainHead);

        // User Bash shares the real sandbox but bypasses the LLM command gate.
        // Probe opaque child-process effects there to prove metadata grants do
        // not open sibling checkout files or waive protected secret reads.
        for (const source of [
          `require('fs').writeFileSync(${JSON.stringify(path.join(main, "outside-marker"))}, 'escaped')`,
          "require('fs').writeFileSync('disclosed', require('fs').readFileSync('.npmrc'))",
        ]) {
          const command = node({ source });
          const userBash = await harness.callUserBash({
            cwd: worktree,
            command,
            excludeFromContext: false,
          });
          if (
            !userBash ||
            !("operations" in userBash) ||
            !userBash.operations
          ) {
            throw new Error(
              "Git mutation profile did not provide sandbox operations",
            );
          }
          expect(
            (
              await userBash.operations.exec(command, worktree, {
                onData: () => undefined,
                timeout: 10,
              })
            ).exitCode,
          ).not.toBe(0);
        }
        expect(fs.existsSync(path.join(main, "outside-marker"))).toBe(false);
        expect(fs.existsSync(path.join(worktree, "disclosed"))).toBe(false);
        expect(harness.errors).toEqual([]);
      } finally {
        await harness.shutdown();
      }
    },
    30_000,
  );

  it("allows a committer rebase from a linked worktree whose shared metadata is elsewhere", async () => {
    const { main, worktree } = linkedWorktreeFixture();
    const mainHead = runGit(main, ["rev-parse", "HEAD"]);

    expect(
      await runThroughPi({
        root: worktree,
        command: "git rebase main",
        profile: "builtin:committer",
      }),
    ).toBe(0);
    expect(runGit(worktree, ["rev-parse", "HEAD^"])).toBe(mainHead);
  });

  it("keeps .git kernel-denied by default and permits an exact explicit waiver", async () => {
    const root = fixture();
    const readGitConfig = node({
      source: "process.stdout.write(require('fs').readFileSync('.git/config'))",
    });
    expect(await runThroughPi({ root, command: readGitConfig })).not.toBe(0);
    expect(
      await runThroughPi({
        root,
        command: readGitConfig,
        sandboxOverrides: {
          kernelUnenforcedProtectedPaths: ["**/.git", "**/.git/**"],
        },
      }),
    ).toBe(0);
  });

  it("uses the same active sandbox operations for user ! commands", async () => {
    const root = fixture();
    writeProfileConfig({});
    const harness = createExtensionHarness({ contextCwd: root, hasUI: false });
    await harness.start();
    try {
      const userBash = await harness.callUserBash({
        cwd: root,
        command: node({
          source:
            "require('fs').writeFileSync('allowed/user-disclosed', require('fs').readFileSync('protected/secret'))",
        }),
        excludeFromContext: false,
      });
      if (!userBash || !("operations" in userBash) || !userBash.operations) {
        throw new Error("Active sandbox did not provide user_bash operations");
      }
      expect(
        (
          await userBash.operations.exec(
            node({
              source:
                "require('fs').writeFileSync('allowed/user-disclosed', require('fs').readFileSync('protected/secret'))",
            }),
            root,
            { onData: () => undefined, timeout: 10 },
          )
        ).exitCode,
      ).not.toBe(0);
      expect(fs.existsSync(path.join(root, "allowed", "user-disclosed"))).toBe(
        false,
      );
    } finally {
      await harness.shutdown();
    }
  });

  describe("sandbox session override matrix", () => {
    const commands = ["sandbox-on", "sandbox-off", "sandbox-on-force"] as const;
    const cases = [true, false].flatMap((profileSandboxEnabled) =>
      commands.flatMap((previousCommand) =>
        commands.map((command) => ({
          profileSandboxEnabled,
          previousCommand,
          command,
        })),
      ),
    );

    it.each(cases)(
      "$command from $previousCommand follows the $profileSandboxEnabled profile sandbox",
      async ({ profileSandboxEnabled, previousCommand, command }) => {
        const root = fixture();
        writeProfileConfig({ sandboxEnabled: profileSandboxEnabled });
        const harness = createExtensionHarness({
          contextCwd: root,
          hasUI: false,
        });
        const toolDisclosure = node({
          source:
            "require('fs').writeFileSync('allowed/tool-disclosed', require('fs').readFileSync('protected/secret'))",
        });
        const userDisclosure = node({
          source:
            "require('fs').writeFileSync('allowed/user-disclosed', require('fs').readFileSync('protected/secret'))",
        });
        const sandboxed =
          command === "sandbox-on-force" ||
          (command === "sandbox-on" && profileSandboxEnabled);

        await harness.start();
        try {
          // Set every possible prior override before applying the command
          // under test, so all state transitions are exercised.
          await harness.runCommand(previousCommand);
          await harness.runCommand(command);

          expect(harness.ui.setStatus).toHaveBeenLastCalledWith(
            "sandbox",
            sandboxed ? "sandbox: macos 🔐" : "sandbox: ❌ off",
          );

          const userBash = await harness.callUserBash({
            cwd: root,
            command: userDisclosure,
            excludeFromContext: false,
          });
          if (sandboxed) {
            if (
              !userBash ||
              !("operations" in userBash) ||
              !userBash.operations
            ) {
              throw new Error(
                "Active sandbox did not provide user_bash operations",
              );
            }
            expect(
              (
                await userBash.operations.exec(userDisclosure, root, {
                  onData: () => undefined,
                  timeout: 10,
                })
              ).exitCode,
            ).not.toBe(0);
            expect(
              fs.existsSync(path.join(root, "allowed", "user-disclosed")),
            ).toBe(false);
          } else {
            expect(userBash).toBeUndefined();
          }

          const toolExitCode = exitCodeFrom({
            result: await harness.executeTool({
              name: "bash",
              params: { command: toolDisclosure, timeout: 10 },
            }),
          });
          expect(toolExitCode === 0).toBe(!sandboxed);
          expect(
            fs.existsSync(path.join(root, "allowed", "tool-disclosed")),
          ).toBe(!sandboxed);
        } finally {
          await harness.shutdown();
        }
      },
    );
  });

  it("returns no user_bash override when the selected profile disables sandboxing", async () => {
    const root = fixture();
    writeProfileConfig({ sandboxEnabled: false });
    const harness = createExtensionHarness({ contextCwd: root, hasUI: false });
    await harness.start();
    try {
      await expect(
        harness.callUserBash({
          cwd: root,
          command: "printf local",
          excludeFromContext: false,
        }),
      ).resolves.toBeUndefined();
    } finally {
      await harness.shutdown();
    }
  });

  describe("subagent sandbox scopes", () => {
    function scopedFixture() {
      const root = fixture();
      fs.mkdirSync(path.join(root, "allowed", "scoped"));
      fs.mkdirSync(path.join(root, "allowed", "sibling"));
      process.env.PI_SUBAGENT_PERMISSIBLE_GLOBS = "allowed/scoped";
      return root;
    }

    it("permits writes within the declared scope", async () => {
      const root = scopedFixture();
      expect(
        await runThroughPi({
          root,
          command: node({
            source:
              "require('fs').writeFileSync('allowed/scoped/created', 'ok')",
          }),
        }),
      ).toBe(0);
      expect(
        fs.readFileSync(
          path.join(root, "allowed", "scoped", "created"),
          "utf8",
        ),
      ).toBe("ok");
    });

    it("permits its private TMPDIR outside a narrow workspace scope", async () => {
      const root = scopedFixture();
      expect(
        await runThroughPi({
          root,
          command: node({
            source:
              "const fs = require('fs'); const path = require('path'); const directory = fs.mkdtempSync(path.join(process.env.TMPDIR, 'pi-guard-subagent-temp-')); fs.writeFileSync(path.join(directory, 'created'), 'ok'); fs.rmSync(directory, { recursive: true });",
          }),
        }),
      ).toBe(0);
    });

    it("permits Go's declared toolchain cache outside a narrow workspace scope", async () => {
      const root = scopedFixture();
      const cacheDirectory = fs.mkdtempSync(
        path.join(
          os.homedir(),
          "go",
          "pkg",
          "mod",
          "cache",
          "download",
          "pi-guard-subagent-scope-",
        ),
      );
      const output = path.join(cacheDirectory, "lock");
      try {
        expect(
          await runThroughPi({
            root,
            command: node({
              source: `require('fs').writeFileSync(${JSON.stringify(output)}, 'ok')`,
            }),
          }),
        ).toBe(0);
        expect(fs.readFileSync(output, "utf8")).toBe("ok");
      } finally {
        fs.rmSync(cacheDirectory, { force: true, recursive: true });
      }
    });

    it.each([
      ["a sibling", "allowed/sibling/created"],
      ["the scope parent", "allowed/parent-created"],
      ["an outside root", "outside/scope-created"],
      ["a configured extra root", "extra/created"],
    ])("denies writes to %s", async (_name, target) => {
      const root = scopedFixture();
      expect(
        await runThroughPi({
          root,
          command: node({
            source: `require('fs').writeFileSync(${JSON.stringify(target)}, 'escaped')`,
          }),
        }),
      ).not.toBe(0);
      expect(fs.existsSync(path.join(root, target))).toBe(false);
    });

    it.each([
      [
        "a shell redirect descendant",
        "require('child_process').execFileSync('sh', ['-c', 'printf escaped > allowed/sibling/redirect'])",
        "allowed/sibling/redirect",
      ],
      [
        "an interpreter descendant",
        `require('child_process').execFileSync(process.execPath, ['-e', "require('fs').writeFileSync('allowed/sibling/node', 'escaped')"])`,
        "allowed/sibling/node",
      ],
    ])("applies the scope to %s", async (_name, source, target) => {
      const root = scopedFixture();
      expect(await runThroughPi({ root, command: node({ source }) })).not.toBe(
        0,
      );
      expect(fs.existsSync(path.join(root, target))).toBe(false);
    });
  });

  it.each([
    ["timeout", undefined, 0.05],
    ["cancellation", 25, 10],
  ])(
    "terminates a delayed descendant tree on %s",
    async (_kind, abortAfter, timeout) => {
      const root = fixture();
      const controller = new AbortController();
      if (abortAfter !== undefined) {
        setTimeout(() => controller.abort(), abortAfter);
      }
      expect(
        await runThroughPi({
          root,
          command:
            'sh -c "(sleep 0.2; printf escaped > allowed/delayed-descendant) & wait"',
          timeout,
          signal: controller.signal,
        }),
      ).not.toBe(0);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(
        fs.existsSync(path.join(root, "allowed", "delayed-descendant")),
      ).toBe(false);
    },
  );

  it("denies a descendant connection to a fixture-local loopback server", async () => {
    const root = fixture();
    const server = createLoopbackServer();
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("Test loopback server did not provide a TCP port");
      }
      expect(
        await runThroughPi({
          root,
          command: node({
            source: `require('net').connect(${address.port}, '127.0.0.1').once('connect', () => process.exit(0)).once('error', () => process.exit(1))`,
          }),
        }),
      ).not.toBe(0);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it.skipIf(process.platform !== "darwin")(
    "permits sandboxed macOS open only with the Apple Events opt-in",
    async () => {
      const root = fixture();
      // -g keeps the browser from taking focus. This deliberately exercises
      // LaunchServices rather than asserting anything about browser networking.
      const command = "open -g https://google.com";

      expect(
        await runThroughPi({
          root,
          command,
          sandboxOverrides: { network: "allow" },
        }),
      ).not.toBe(0);
      expect(
        await runThroughPi({
          root,
          command,
          sandboxOverrides: { network: "allow", allowAppleEvents: true },
        }),
      ).toBe(0);
    },
    30_000,
  );

  it("permits remote HTTPS when the profile explicitly allows network access", async () => {
    const root = fixture();
    expect(
      await runThroughPi({
        root,
        command: node({
          source:
            "require('https').get('https://www.google.com', (response) => process.exit(response.statusCode === 200 ? 0 : 1)).once('error', () => process.exit(1))",
        }),
        sandboxOverrides: { network: "allow" },
      }),
    ).toBe(0);
  }, 30_000);

  it("permits a descendant connection when the profile explicitly allows network access", async () => {
    const root = fixture();
    const server = createLoopbackServer();
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("Test loopback server did not provide a TCP port");
      }
      expect(
        await runThroughPi({
          root,
          command: node({
            source: `require('net').connect(${address.port}, '127.0.0.1').once('connect', () => process.exit(0)).once('error', () => process.exit(1))`,
          }),
          sandboxOverrides: { network: "allow" },
        }),
      ).toBe(0);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
