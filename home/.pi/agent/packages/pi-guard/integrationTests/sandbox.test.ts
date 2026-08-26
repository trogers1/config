import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createExtensionHarness } from "./support/extensionHarness";

const tempDirectories: string[] = [];

// These are OS-acceptance tests, so they must be able to initialize a real
// Seatbelt boundary. macOS rejects nested sandbox-exec invocations.
beforeAll(() => {
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

function writeProfileConfig({
  sandboxOverrides = {},
  sandboxEnabled = true,
}: {
  sandboxOverrides?: Record<string, unknown>;
  sandboxEnabled?: boolean;
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
          extends: ["builtin:default"],
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
          sandbox: { network: "deny" },
        },
        inherited: {
          description: "Inherited profile selecting the base sandbox posture",
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
}: {
  root: string;
  command: string;
  sandboxOverrides?: Record<string, unknown>;
  sandboxEnabled?: boolean;
  timeout?: number;
  signal?: AbortSignal;
}): Promise<number> {
  writeProfileConfig({ sandboxOverrides, sandboxEnabled });
  const harness = createExtensionHarness({ contextCwd: root, hasUI: false });
  await harness.start();
  try {
    const gate = await harness.callTool({
      toolName: "bash",
      input: { command, timeout },
    });
    expect(gate?.block).not.toBe(true);
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

        await harness.runCommand({ name: "profile", args: "replacement" });
        expect(
          exitCodeFrom({
            result: await harness.executeTool({
              name: "bash",
              params: { command, timeout: 10 },
            }),
          }),
        ).toBe(0);

        await harness.runCommand({ name: "profile", args: "disabled" });
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
