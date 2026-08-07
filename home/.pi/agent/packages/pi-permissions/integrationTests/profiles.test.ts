import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createExtensionHarness,
  lastCallArgument,
} from "./support/extensionHarness";
import { defaultProtectedPathRules } from "../modules/protectedPaths";

const defaultProtectedDenyPatterns = defaultProtectedPathRules
  .filter((rule) => rule.decision === "deny")
  .map((rule) => rule.pattern);
const defaultProtectedSearchGlob = `!{${defaultProtectedDenyPatterns.join(",")}}`;
const defaultProtectedRipgrepArguments = defaultProtectedDenyPatterns
  .map((pattern) => `--glob '!${pattern}'`)
  .join(" ");

const missingProfileConfigPath = path.resolve(
  "integrationTests/fixtures/does-not-exist.jsonc",
);
const customProfileConfigPath = path.resolve(
  "integrationTests/fixtures/custom-profiles.jsonc",
);

// Per-test profile fixtures keep the exported global policyConfig immutable:
// every harness loads its own config instead of sharing mutated state.
const temporaryDirectories: string[] = [];

function writeTempConfig(contents: string): string {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-permissions-fixture-"),
  );
  temporaryDirectories.push(directory);
  const configPath = path.join(directory, "profiles.jsonc");
  fs.writeFileSync(configPath, contents);
  return configPath;
}

describe("permissions extension", () => {
  beforeEach(() => {
    vi.stubEnv("PI_PERMISSIONS_PROFILE_CONFIG", missingProfileConfigPath);
    delete process.env.PI_SUBAGENT_PROFILE;
    delete process.env.PI_SUBAGENT_PERMISSIBLE_GLOBS;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const directory of temporaryDirectories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("selects the subagent profile from the environment", async () => {
    vi.stubEnv("PI_SUBAGENT_PROFILE", "builtin:read-only");
    const harness = createExtensionHarness();

    await harness.start();

    expect(lastCallArgument(harness.ui.setStatus, 1)).toContain(
      "builtin:read-only",
    );
    await expect(
      harness.callTool({
        toolName: "write",
        input: { path: "notes.md", content: "blocked" },
      }),
    ).resolves.toMatchObject({ block: true });
  });

  it("applies matching policy and guidance to a custom tool", async () => {
    vi.stubEnv(
      "PI_PERMISSIONS_PROFILE_CONFIG",
      writeTempConfig(
        JSON.stringify({
          defaultProfile: "deploy-check",
          profiles: {
            "deploy-check": {
              extends: ["builtin:default"],
              tools: {
                deploy: [
                  { decision: "ask" },
                  {
                    decision: "deny",
                    match: { environment: "production" },
                    guidance: "Use the staging deployment first.",
                    alternatives: ["Deploy with environment=staging"],
                  },
                  { decision: "allow", match: { environment: "staging" } },
                ],
              },
            },
          },
        }),
      ),
    );
    const harness = createExtensionHarness();
    await harness.start();

    const denied = await harness.callTool({
      toolName: "deploy",
      input: { environment: "production" },
    });
    expect(denied).toMatchObject({ block: true });
    expect(denied?.reason).toMatch(
      /Use the staging deployment first.*environment=staging/s,
    );
    await expect(
      harness.callToolWithoutPrompt({
        toolName: "deploy",
        input: { environment: "staging" },
      }),
    ).resolves.toBeUndefined();
  });

  it("preserves inherited Bash behavior when an override appends an empty rule list", async () => {
    vi.stubEnv(
      "PI_PERMISSIONS_PROFILE_CONFIG",
      writeTempConfig(
        JSON.stringify({
          defaultProfile: "quiet-bash",
          profiles: {
            "quiet-bash": { extends: ["builtin:default"], tools: { bash: [] } },
          },
        }),
      ),
    );

    const interactive = createExtensionHarness({ confirm: false });
    await interactive.start();
    await expect(
      interactive.callToolWithoutPrompt({
        toolName: "bash",
        input: { command: "git status --short" },
      }),
    ).resolves.toBeUndefined();

    const nonInteractive = createExtensionHarness({ hasUI: false });
    await nonInteractive.start();
    await expect(
      nonInteractive.callTool({
        toolName: "bash",
        input: { command: "git status --short" },
      }),
    ).resolves.toBeUndefined();
    expect(nonInteractive.ui.confirm).not.toHaveBeenCalled();
  });

  it("applies protected Bash rules before matching command rules", async () => {
    vi.stubEnv(
      "PI_PERMISSIONS_PROFILE_CONFIG",
      writeTempConfig(
        JSON.stringify({
          defaultProfile: "layer-order",
          profiles: {
            "layer-order": {
              tools: {
                bash: [{ pattern: "rm -rf *", decision: "deny" }],
              },
              readPaths: [{ pattern: "**", decision: "allow" }],
              writePaths: [{ pattern: "**", decision: "allow" }],
              protectedPathRules: [{ pattern: "**/.env*", decision: "deny" }],
            },
          },
        }),
      ),
    );
    const harness = createExtensionHarness();
    await harness.start();

    const result = await harness.callTool({
      toolName: "bash",
      input: { command: "rm -rf .env" },
    });

    expect(result).toMatchObject({ block: true });
    expect(result?.reason).toContain("protected-path policy");
    expect(result?.reason).not.toContain("Command denied by explicit rule");

    await harness.runCommand("permissions", "explain bash rm -rf .env");
    const explanation = lastCallArgument(harness.ui.notify, 0);
    expect(explanation).toContain("Protected-layer override: deny (**/.env*)");
    expect(explanation).not.toContain("Winner: [deny] rm -rf *");

    harness.ui.confirm.mockClear();
    const afterDynamicOperand = await harness.callTool({
      toolName: "bash",
      input: { command: 'cp "$SRC" .env' },
    });
    expect(afterDynamicOperand).toMatchObject({ block: true });
    expect(afterDynamicOperand?.reason).toContain("protected-path policy");
    expect(harness.ui.confirm).not.toHaveBeenCalled();

    await harness.runCommand("permissions", 'explain bash cp "$SRC" .env');
    const dynamicExplanation = lastCallArgument(harness.ui.notify, 0);
    expect(dynamicExplanation).toContain(
      "Protected-layer override: deny (**/.env*)",
    );

    for (const command of [
      'cd "$DIR"; cat /tmp/.env',
      'cd "$DIR" | cat /tmp/.env',
    ]) {
      harness.ui.confirm.mockClear();
      const compoundResult = await harness.callTool({
        toolName: "bash",
        input: { command },
      });
      expect(compoundResult, command).toMatchObject({ block: true });
      expect(compoundResult?.reason, command).toContain(
        "protected-path policy",
      );
      expect(harness.ui.confirm, command).not.toHaveBeenCalled();
    }

    await harness.runCommand(
      "permissions",
      'explain bash cd "$DIR" | cat /tmp/.env',
    );
    expect(lastCallArgument(harness.ui.notify, 0)).toContain(
      "Protected-layer override: deny (**/.env*)",
    );
  });

  it.each([
    ["[[ -r README.md ]]", "Bash [[ ... ]] expression"],
    ["[ -r README.md ]", "Bash [ ... ] expression"],
    ["test -r README.md", "Bash test expression"],
    ["if [ -z configured ]; then true; fi", "Bash [ ... ] expression"],
    ["while test -e marker; do break; done", "Bash test expression"],
    ["(( count += 1 ))", "Bash (( ... )) arithmetic expression"],
    ['let "count += 1"', "Bash let arithmetic expression"],
    [
      'for ((i = 0; i < 3; i++)); do echo "$i"; done',
      "Bash arithmetic for expression",
    ],
  ])(
    "asks before evaluating opaque Bash expression: %s",
    async (command, expression) => {
      vi.stubEnv(
        "PI_PERMISSIONS_PROFILE_CONFIG",
        writeTempConfig(
          JSON.stringify({
            defaultProfile: "test-expression",
            profiles: {
              "test-expression": {
                tools: {
                  bash: [{ pattern: "*", decision: "allow" }],
                },
                readPaths: [{ pattern: "**", decision: "allow" }],
                writePaths: [{ pattern: "**", decision: "allow" }],
              },
            },
          }),
        ),
      );
      const harness = createExtensionHarness({ confirm: false });
      await harness.start();

      const result = await harness.callTool({
        toolName: "bash",
        input: { command },
      });

      expect(result).toMatchObject({ block: true });
      expect(result?.reason).toContain(expression);
      expect(harness.ui.confirm).toHaveBeenCalledWith(
        "Bash command references a gated path?",
        expect.stringContaining(expression),
      );
    },
  );

  it("finds a later Bash path deny before prompting for an earlier ask", async () => {
    vi.stubEnv(
      "PI_PERMISSIONS_PROFILE_CONFIG",
      writeTempConfig(
        JSON.stringify({
          defaultProfile: "path-stage-order",
          profiles: {
            "path-stage-order": {
              tools: {
                bash: [{ pattern: "*", decision: "allow" }],
              },
              readPaths: [{ pattern: "**", decision: "allow" }],
              writePaths: [
                { pattern: "**", decision: "allow" },
                {
                  pattern: "ask.txt",
                  decision: "ask",
                  contexts: ["bash"],
                },
                {
                  pattern: "deny.txt",
                  decision: "deny",
                  contexts: ["bash"],
                },
              ],
            },
          },
        }),
      ),
    );
    const harness = createExtensionHarness({ confirm: true });
    await harness.start();

    const result = await harness.callTool({
      toolName: "bash",
      input: { command: "cp ask.txt deny.txt" },
    });

    expect(result).toMatchObject({ block: true });
    expect(result?.reason).toContain("Bash path reference denied by policy");
    expect(result?.reason).toContain("deny.txt");
    expect(harness.ui.confirm).not.toHaveBeenCalled();
  });

  it("denies a relative protected path after a dynamic pipeline CWD without prompting", async () => {
    vi.stubEnv(
      "PI_PERMISSIONS_PROFILE_CONFIG",
      writeTempConfig(
        JSON.stringify({
          defaultProfile: "protected-pipeline",
          profiles: {
            "protected-pipeline": {
              tools: {
                bash: [{ pattern: "*", decision: "allow" }],
              },
              readPaths: [{ pattern: "**", decision: "allow" }],
              writePaths: [{ pattern: "**", decision: "allow" }],
              protectedPathRules: [{ pattern: "**/.env*", decision: "deny" }],
            },
          },
        }),
      ),
    );
    const harness = createExtensionHarness({ confirm: true });
    await harness.start();

    const result = await harness.callTool({
      toolName: "bash",
      input: { command: 'cd "$DIR" | cat .env' },
    });

    expect(result).toMatchObject({ block: true });
    expect(result?.reason).toContain("protected-path policy");
    expect(result?.reason).toContain(".env");
    expect(harness.ui.confirm).not.toHaveBeenCalled();
  });

  it("checks protected paths inside assignment-prefix command substitutions", async () => {
    vi.stubEnv(
      "PI_PERMISSIONS_PROFILE_CONFIG",
      writeTempConfig(
        JSON.stringify({
          defaultProfile: "protected-assignment",
          profiles: {
            "protected-assignment": {
              tools: {
                bash: [{ pattern: "*", decision: "allow" }],
              },
              readPaths: [{ pattern: "**", decision: "allow" }],
              writePaths: [{ pattern: "**", decision: "allow" }],
              protectedPathRules: [{ pattern: "**/.env*", decision: "deny" }],
            },
          },
        }),
      ),
    );
    const harness = createExtensionHarness({ confirm: true });
    await harness.start();

    const result = await harness.callTool({
      toolName: "bash",
      input: { command: "SECRET=$(base64 .env) env" },
    });

    expect(result).toMatchObject({ block: true });
    expect(result?.reason).toContain("protected-path policy");
    expect(result?.reason).toContain(".env");
    expect(harness.ui.confirm).not.toHaveBeenCalled();
  });

  it("applies ordinary Bash path rules before matching command rules", async () => {
    vi.stubEnv(
      "PI_PERMISSIONS_PROFILE_CONFIG",
      writeTempConfig(
        JSON.stringify({
          defaultProfile: "layer-order",
          profiles: {
            "layer-order": {
              tools: {
                bash: [{ pattern: "cp * *", decision: "deny" }],
              },
              readPaths: [{ pattern: "**", decision: "allow" }],
              writePaths: [
                { pattern: "**", decision: "allow" },
                {
                  pattern: "src/**",
                  decision: "deny",
                  contexts: ["bash"],
                },
              ],
            },
          },
        }),
      ),
    );
    const harness = createExtensionHarness();
    await harness.start();

    const result = await harness.callTool({
      toolName: "bash",
      input: { command: "cp a.txt src/b.txt" },
    });

    expect(result).toMatchObject({ block: true });
    expect(result?.reason).toContain("Bash path reference denied by policy");
    expect(result?.reason).not.toContain("Command denied by explicit rule");

    await harness.runCommand("permissions", "explain bash cp a.txt src/b.txt");
    const explanation = lastCallArgument(harness.ui.notify, 0);
    expect(explanation).toContain("Bash path-reference rule: [deny] src/**");
    expect(explanation).not.toContain("Winner: [deny] cp * *");
  });

  it("uses the shipped base profile when no custom profile module exists", async () => {
    vi.stubEnv("PI_PERMISSIONS_PROFILE_CONFIG", missingProfileConfigPath);
    const harness = createExtensionHarness();
    await harness.start();

    expect(lastCallArgument(harness.ui.setStatus, 1)).toContain(
      "builtin:default",
    );
    const completions = await harness
      .command("profile")
      .getArgumentCompletions?.("");
    expect(completions?.map((completion) => completion.value)).toEqual(
      expect.arrayContaining([
        "builtin:default",
        "builtin:worker",
        "builtin:read-only",
      ]),
    );
    expect(completions?.map((completion) => completion.value)).not.toContain(
      "socrates",
    );
  });

  it("explains the exact built-in composition chain through the registered command", async () => {
    const harness = createExtensionHarness();
    await harness.start();

    await harness.runCommand("permissions", "explain bash git status");

    expect(lastCallArgument(harness.ui.notify, 0)).toContain(
      "Composition: ruleset:shell → ruleset:git → ruleset:packageManagers → ruleset:deps-mutations-guard → ruleset:shell-guards → ruleset:path-guards → builtin:default",
    );
  });

  it("explains a denial from PI_SUBAGENT_PERMISSIBLE_GLOBS through the registered command", async () => {
    vi.stubEnv("PI_SUBAGENT_PERMISSIBLE_GLOBS", "src/**");
    const harness = createExtensionHarness();
    await harness.start();

    const enforced = await harness.callTool({
      toolName: "edit",
      input: { path: "README.md", edits: [] },
    });
    expect(enforced).toMatchObject({ block: true });
    expect(enforced?.reason).toContain("PI_SUBAGENT_PERMISSIBLE_GLOBS");

    await harness.runCommand("permissions", "explain edit README.md");
    const explanation = lastCallArgument(harness.ui.notify, 0);
    expect(explanation).toContain("Decision: deny");
    expect(explanation).toContain("PI_SUBAGENT_PERMISSIBLE_GLOBS");
  });

  it("explains the decision enforced after protected ripgrep arguments are injected", async () => {
    vi.stubEnv(
      "PI_PERMISSIONS_PROFILE_CONFIG",
      writeTempConfig(
        JSON.stringify({
          defaultProfile: "search-explain-parity",
          profiles: {
            "search-explain-parity": {
              tools: {
                bash: [
                  { pattern: "*", decision: "deny" },
                  { pattern: "rg needle .", decision: "allow" },
                ],
              },
              readPaths: [{ pattern: "**", decision: "allow" }],
              writePaths: [{ pattern: "**", decision: "allow" }],
              protectedPathRules: [{ pattern: "**/.env*", decision: "deny" }],
            },
          },
        }),
      ),
    );
    const harness = createExtensionHarness();
    await harness.start();

    const enforced = await harness.callTool({
      toolName: "bash",
      input: { command: "rg needle ." },
    });
    expect(enforced).toMatchObject({ block: true });
    expect(enforced?.reason).toContain("Command denied by explicit rule");

    await harness.runCommand("permissions", "explain bash rg needle .");
    const explanation = lastCallArgument(harness.ui.notify, 0);
    expect(explanation).toContain("Decision: deny");
    expect(explanation).toContain("**/.env*");
  });

  it("ranks protected and ordinary path rules for Bash through the registered command", async () => {
    vi.stubEnv(
      "PI_PERMISSIONS_PROFILE_CONFIG",
      writeTempConfig(
        JSON.stringify({
          defaultProfile: "bash-path-explanation",
          profiles: {
            "bash-path-explanation": {
              tools: {
                bash: [
                  { pattern: "*", decision: "deny" },
                  { pattern: "cat *", decision: "allow" },
                ],
              },
              readPaths: [{ pattern: "**", decision: "allow" }],
              writePaths: [
                {
                  pattern: "**",
                  decision: "ask",
                  contexts: ["bash"],
                },
                {
                  pattern: ".env.template",
                  decision: "allow",
                  contexts: ["bash"],
                },
              ],
              protectedPathRules: [
                { pattern: "**/.env*", decision: "deny" },
                { pattern: ".env.template", decision: "allow" },
              ],
            },
          },
        }),
      ),
    );
    const harness = createExtensionHarness();
    await harness.start();

    await expect(
      harness.callToolWithoutPrompt({
        toolName: "bash",
        input: { command: "cat .env.template" },
      }),
    ).resolves.toBeUndefined();

    await harness.runCommand("permissions", "explain bash cat .env.template");
    const explanation = lastCallArgument(harness.ui.notify, 0);
    expect(explanation).toContain(
      "Protected-layer winner: allow (.env.template)",
    );
    expect(explanation).toContain("Protected matches:");
    expect(explanation).toContain("[deny] **/.env*");
    expect(explanation).toContain("Path-layer winner: [allow] .env.template");
    expect(explanation).toContain("Path matches:");
    expect(explanation).toContain("[ask] **");
  });

  it.each([
    [
      "builtin:read-only",
      "ruleset:read-only-path → ruleset:read-only-shell → builtin:read-only",
    ],
    [
      "builtin:reviewer",
      "ruleset:read-only-path → ruleset:read-only-shell → builtin:read-only → ruleset:test-run → builtin:reviewer",
    ],
    [
      "builtin:tests-hidden",
      "ruleset:shell → ruleset:git → ruleset:packageManagers → ruleset:deps-mutations-guard → ruleset:shell-guards → ruleset:path-guards → builtin:default → ruleset:test-write-protection → builtin:tests-hidden",
    ],
  ])(
    "explains the exact non-default composition chain for %s through the registered command",
    async (profileName, expectedChain) => {
      vi.stubEnv("PI_SUBAGENT_PROFILE", profileName);
      const harness = createExtensionHarness();
      await harness.start();

      await harness.runCommand("permissions", "explain bash git status");

      expect(lastCallArgument(harness.ui.notify, 0)).toContain(
        `Composition: ${expectedChain}`,
      );
    },
  );

  it("recursively explains custom parents, rule sets, and transforms through the registered command", async () => {
    vi.stubEnv(
      "PI_PERMISSIONS_PROFILE_CONFIG",
      writeTempConfig(
        JSON.stringify({
          defaultProfile: "child",
          profiles: {
            parent: {
              extends: ["builtin:committer", "ruleset:test-run"],
            },
            child: {
              extends: ["parent"],
              transforms: ["transform:deny-asks"],
            },
          },
        }),
      ),
    );
    const harness = createExtensionHarness();
    await harness.start();

    await harness.runCommand("permissions", "explain bash git status");

    expect(lastCallArgument(harness.ui.notify, 0)).toContain(
      "Composition: ruleset:shell → ruleset:git → ruleset:packageManagers → ruleset:deps-mutations-guard → ruleset:shell-guards → ruleset:path-guards → builtin:default → ruleset:git-commit → builtin:committer → ruleset:test-run → custom profile: parent → transform:deny-asks → custom profile: child",
    );
  });

  it("uses a custom profile that extends a shipped profile", async () => {
    // The fixture defines a uniquely-named profile extending the shipped
    // read-only profile; a command only that custom profile allows proves the
    // extension and selection took effect.
    vi.stubEnv("PI_PERMISSIONS_PROFILE_CONFIG", customProfileConfigPath);
    vi.stubEnv("PI_SUBAGENT_PROFILE", "fixture-read-only");
    const harness = createExtensionHarness({ hasUI: false });
    await harness.start();

    await expect(
      harness.callToolWithoutPrompt({
        toolName: "bash",
        input: { command: "fixture-only verify-profile-override" },
      }),
    ).resolves.toBeUndefined();
  });

  it("keeps protected exceptions subject to ordinary policy and reports denial alternatives", async () => {
    vi.stubEnv("PI_PERMISSIONS_PROFILE_CONFIG", customProfileConfigPath);
    vi.stubEnv("PI_SUBAGENT_PROFILE", "protected-matrix");
    const harness = createExtensionHarness({ confirm: false });
    await harness.start();

    const exceptionResult = await harness.callTool({
      toolName: "read",
      input: { path: "private/.env.template" },
    });
    expect(exceptionResult).toMatchObject({ block: true });
    expect(harness.ui.confirm).toHaveBeenCalledWith(
      "Allow read?",
      expect.stringContaining("private/.env.template"),
    );

    harness.ui.confirm.mockClear();
    const protectedResult = await harness.callTool({
      toolName: "read",
      input: { path: "private/.env.secret" },
    });
    expect(protectedResult).toMatchObject({ block: true });
    expect(protectedResult?.reason).toContain(
      "Use an explicitly approved file instead",
    );
    expect(protectedResult?.reason).toContain(
      "Ask the user for a redacted or safe-to-share value",
    );
    expect(harness.ui.confirm).not.toHaveBeenCalled();
  });

  it("keeps each extension instance isolated from later profile loads", async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "pi-permissions-isolation-"),
    );
    const firstConfigPath = path.join(directory, "first.jsonc");
    const secondConfigPath = path.join(directory, "second.jsonc");
    fs.writeFileSync(
      firstConfigPath,
      JSON.stringify({
        defaultProfile: "isolated",
        profiles: {
          isolated: {
            extends: ["builtin:default"],
            tools: { deploy: [{ decision: "allow" }] },
          },
        },
      }),
    );
    fs.writeFileSync(
      secondConfigPath,
      JSON.stringify({
        defaultProfile: "isolated",
        profiles: {
          isolated: {
            extends: ["builtin:default"],
            tools: { deploy: [{ decision: "deny" }] },
          },
        },
      }),
    );

    try {
      vi.stubEnv("PI_PERMISSIONS_PROFILE_CONFIG", firstConfigPath);
      const firstHarness = createExtensionHarness({ hasUI: false });
      vi.stubEnv("PI_PERMISSIONS_PROFILE_CONFIG", secondConfigPath);
      createExtensionHarness({ hasUI: false });

      await firstHarness.start();
      await expect(
        firstHarness.callToolWithoutPrompt({
          toolName: "deploy",
          input: { environment: "staging" },
        }),
      ).resolves.toBeUndefined();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("leaves a completely unconfigured custom tool outside this extension's policy", async () => {
    const harness = createExtensionHarness();
    await harness.start();

    await expect(
      harness.callToolWithoutPrompt({
        toolName: "tool-with-no-policy",
        input: { action: "inspect" },
      }),
    ).resolves.toBeUndefined();
  });

  it("does not require directories for a profile to be selected", async () => {
    const harness = createExtensionHarness();
    await harness.start();

    expect(lastCallArgument(harness.ui.setStatus, 1)).toContain(
      "builtin:default",
    );
  });

  it("selects the most-specific profile directory for a startup inside a descendant", async () => {
    vi.stubEnv(
      "PI_PERMISSIONS_PROFILE_CONFIG",
      writeTempConfig(
        JSON.stringify({
          profiles: {
            "outer-review": {
              extends: ["builtin:default"],
              directories: ["/workspace"],
            },
            "inner-review": {
              extends: ["builtin:default"],
              directories: ["/workspace/coaching"],
            },
          },
        }),
      ),
    );

    const harness = createExtensionHarness({
      contextCwd: "/workspace/coaching/example",
    });
    await harness.start();

    expect(lastCallArgument(harness.ui.setStatus, 1)).toContain("inner-review");
  });

  it("selects profiles bound with ~ directories", async () => {
    vi.stubEnv(
      "PI_PERMISSIONS_PROFILE_CONFIG",
      writeTempConfig(
        JSON.stringify({
          profiles: {
            "home-bound": {
              extends: ["builtin:default"],
              directories: ["~/pi-permissions-home-binding-test"],
            },
          },
        }),
      ),
    );

    const harness = createExtensionHarness({
      contextCwd: path.join(
        process.env.HOME ?? os.homedir(),
        "pi-permissions-home-binding-test",
        "nested",
      ),
    });
    await harness.start();

    expect(lastCallArgument(harness.ui.setStatus, 1)).toContain("home-bound");
  });

  it("selects profiles bound with startup-relative directories", async () => {
    vi.stubEnv(
      "PI_PERMISSIONS_PROFILE_CONFIG",
      writeTempConfig(
        JSON.stringify({
          profiles: {
            "relative-bound": {
              extends: ["builtin:default"],
              directories: ["integrationTests"],
            },
          },
        }),
      ),
    );

    const harness = createExtensionHarness({
      contextCwd: path.join(process.cwd(), "integrationTests", "fixtures"),
    });
    await harness.start();

    expect(lastCallArgument(harness.ui.setStatus, 1)).toContain(
      "relative-bound",
    );
  });

  it("lets a configured profile directory override a persisted profile on resume", async () => {
    vi.stubEnv(
      "PI_PERMISSIONS_PROFILE_CONFIG",
      writeTempConfig(
        JSON.stringify({
          profiles: {
            "workspace-bound": {
              extends: ["builtin:default"],
              directories: ["/workspace"],
            },
          },
        }),
      ),
    );

    const harness = createExtensionHarness({
      contextCwd: "/workspace/project",
      entries: [
        {
          type: "custom",
          customType: "pi-permissions-profile",
          data: { profile: "builtin:default" },
        },
      ],
    });
    await harness.start("resume");

    expect(lastCallArgument(harness.ui.setStatus, 1)).toContain(
      "workspace-bound",
    );
  });

  it("uses a later-declared profile to break equal directory matches", async () => {
    // The checked-in fixture binds both review-tools and address-comments
    // to /workspace, with address-comments declared later.
    vi.stubEnv("PI_PERMISSIONS_PROFILE_CONFIG", customProfileConfigPath);

    const harness = createExtensionHarness({ contextCwd: "/workspace" });
    await harness.start();

    expect(lastCallArgument(harness.ui.setStatus, 1)).toContain(
      "address-comments",
    );
  });

  it("lets PI_SUBAGENT_PROFILE override a persisted profile on resume", async () => {
    vi.stubEnv("PI_SUBAGENT_PROFILE", "builtin:worker");
    const harness = createExtensionHarness({
      hasUI: false,
      entries: [
        {
          type: "custom",
          customType: "pi-permissions-profile",
          data: { profile: "builtin:read-only" },
        },
      ],
    });
    await harness.start("resume");

    expect(lastCallArgument(harness.ui.setStatus, 1)).toContain(
      "builtin:worker",
    );
    // The worker policy is active rather than the persisted read-only policy.
    await expect(
      harness.callToolWithoutPrompt({
        toolName: "write",
        input: { path: "notes.md", content: "worker may write" },
      }),
    ).resolves.toBeUndefined();
  });

  it("lets PI_SUBAGENT_PROFILE override a configured profile directory", async () => {
    // The checked-in fixture binds review-tools to /workspace.
    vi.stubEnv("PI_PERMISSIONS_PROFILE_CONFIG", customProfileConfigPath);
    vi.stubEnv("PI_SUBAGENT_PROFILE", "builtin:worker");

    const harness = createExtensionHarness({
      contextCwd: "/workspace/project",
      hasUI: false,
    });
    await harness.start();

    expect(lastCallArgument(harness.ui.setStatus, 1)).toContain(
      "builtin:worker",
    );
    await expect(
      harness.callToolWithoutPrompt({
        toolName: "bash",
        input: { command: "npm test" },
      }),
    ).resolves.toBeUndefined();
  });

  it("treats a plain PI_SUBAGENT_PERMISSIBLE_GLOBS path as including its descendants", async () => {
    vi.stubEnv("PI_SUBAGENT_PROFILE", "builtin:worker");
    vi.stubEnv("PI_SUBAGENT_PERMISSIBLE_GLOBS", "modules");
    const harness = createExtensionHarness({ hasUI: false });
    await harness.start();

    await expect(
      harness.callToolWithoutPrompt({
        toolName: "write",
        input: { path: "modules/nested/allowed.ts", content: "allowed" },
      }),
    ).resolves.toBeUndefined();
    await expect(
      harness.callToolWithoutPrompt({
        toolName: "bash",
        input: { command: "cat modules/nested/allowed.ts" },
      }),
    ).resolves.toBeUndefined();

    const outside = await harness.callTool({
      toolName: "write",
      input: { path: "other/outside.ts", content: "blocked" },
    });
    expect(outside).toMatchObject({ block: true });
    expect(outside?.reason).toContain("PI_SUBAGENT_PERMISSIBLE_GLOBS");
  });

  it("leaves dedicated read tools at the profile's normal read access under PI_SUBAGENT_PERMISSIBLE_GLOBS", async () => {
    vi.stubEnv("PI_SUBAGENT_PROFILE", "builtin:worker");
    vi.stubEnv("PI_SUBAGENT_PERMISSIBLE_GLOBS", "modules/**");
    const harness = createExtensionHarness({ hasUI: false });
    await harness.start();

    // The scope layer narrows edit/write and Bash only; dedicated read tools
    // keep the selected profile's normal read access, even for paths outside
    // the declared scope.
    await expect(
      harness.callToolWithoutPrompt({
        toolName: "read",
        input: { path: "README.md" },
      }),
    ).resolves.toBeUndefined();

    // The profile's own read boundaries still apply: the worker profile
    // converts the outside-path confirmation into a denial with guidance.
    const outside = await harness.callTool({
      toolName: "read",
      input: { path: path.resolve(process.cwd(), "../outside.txt") },
    });
    expect(outside).toMatchObject({ block: true });
  });

  it("does not let a permissive subagent write glob widen the selected profile", async () => {
    vi.stubEnv("PI_SUBAGENT_PROFILE", "builtin:read-only");
    vi.stubEnv("PI_SUBAGENT_PERMISSIBLE_GLOBS", "**");
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
    vi.stubEnv("PI_SUBAGENT_PROFILE", "builtin:worker");
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

  it("enforces subagent permissible scopes for tools and Bash paths", async () => {
    vi.stubEnv("PI_SUBAGENT_PROFILE", "builtin:worker");
    vi.stubEnv(
      "PI_SUBAGENT_PERMISSIBLE_GLOBS",
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
    await expect(
      harness.callToolWithoutPrompt({
        toolName: "bash",
        input: { command: "git log --oneline > modules/allowed.ts" },
      }),
    ).resolves.toBeUndefined();
    await expect(
      harness.callToolWithoutPrompt({
        toolName: "bash",
        input: { command: "rg needle modules/allowed.ts" },
      }),
    ).resolves.toBeUndefined();

    for (const event of [
      {
        toolName: "bash",
        input: { command: "rg needle package.json" },
      },
      {
        toolName: "bash",
        input: { command: "cat credentials.txt" },
      },
      {
        toolName: "bash",
        input: { command: 'git diff --no-index "$LEFT" "$RIGHT"' },
      },
      {
        toolName: "bash",
        input: { command: 'git log > "$OUTPUT"' },
      },
      {
        toolName: "write",
        input: { path: "modules/outside.ts", content: "blocked" },
      },
      {
        toolName: "bash",
        input: { command: "npm test -- tests/integration/example.test.ts" },
      },
      {
        toolName: "bash",
        input: { command: "git log --oneline > modules/outside.ts" },
      },
    ]) {
      const denied = await harness.callTool(event);
      expect(denied, JSON.stringify(event)).toMatchObject({ block: true });
      expect(denied?.reason).toContain("PI_SUBAGENT_PERMISSIBLE_GLOBS");
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

  it("enforces basename, redirection, and --no-index operands under PI_SUBAGENT_PERMISSIBLE_GLOBS=modules/**", async () => {
    vi.stubEnv("PI_SUBAGENT_PROFILE", "builtin:worker");
    vi.stubEnv("PI_SUBAGENT_PERMISSIBLE_GLOBS", "modules/**");
    const harness = createExtensionHarness({ hasUI: false });
    await harness.start();

    await expect(
      harness.callToolWithoutPrompt({
        toolName: "bash",
        input: { command: "rg needle modules/allowed.ts" },
      }),
    ).resolves.toBeUndefined();

    for (const command of [
      "rg needle package.json",
      "cat credentials.txt",
      'git log > "$OUTPUT"',
      'git diff --no-index "$LEFT" "$RIGHT"',
    ]) {
      const denied = await harness.callTool({
        toolName: "bash",
        input: { command },
      });
      expect(denied, command).toMatchObject({ block: true });
      expect(denied?.reason).toContain("PI_SUBAGENT_PERMISSIBLE_GLOBS");
    }
  });

  it("blocks dynamic Git diff operands under PI_SUBAGENT_PERMISSIBLE_GLOBS", async () => {
    vi.stubEnv("PI_SUBAGENT_PROFILE", "builtin:worker");
    vi.stubEnv("PI_SUBAGENT_PERMISSIBLE_GLOBS", "modules/**");
    const harness = createExtensionHarness({ hasUI: false });
    await harness.start();

    const denied = await harness.callTool({
      toolName: "bash",
      input: { command: 'git diff "$LEFT" "$RIGHT"' },
    });
    expect(denied).toMatchObject({ block: true });
    expect(denied?.reason).toContain("PI_SUBAGENT_PERMISSIBLE_GLOBS");
  });

  it("allows a basename after entering a directory inside the subagent scope", async () => {
    vi.stubEnv("PI_SUBAGENT_PROFILE", "builtin:worker");
    vi.stubEnv("PI_SUBAGENT_PERMISSIBLE_GLOBS", "modules/**");
    const harness = createExtensionHarness({ hasUI: false });
    await harness.start();

    await expect(
      harness.callToolWithoutPrompt({
        toolName: "bash",
        input: { command: "cd modules; rg needle package.json" },
      }),
    ).resolves.toBeUndefined();
  });

  it("fails startup for an unknown subagent profile", async () => {
    vi.stubEnv("PI_SUBAGENT_PROFILE", "missing");
    const harness = createExtensionHarness();

    await expect(harness.start()).resolves.toBeUndefined();
    expect(harness.errors).toHaveLength(0);
    expect(harness.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Invalid PI_SUBAGENT_PROFILE 'missing'"),
      "error",
    );

    const blocked = await harness.callToolWithoutPrompt({
      toolName: "bash",
      input: { command: "git status --short" },
    });
    expect(blocked).toMatchObject({ block: true });
    expect(blocked?.reason).toContain("Invalid PI_SUBAGENT_PROFILE 'missing'");
    expect(blocked?.reason).toContain("The permissions gate remains loaded");
  });

  it("keeps blocking an invalid profile config when a session persists a profile", async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "pi-permissions-invalid-resume-"),
    );
    const configPath = path.join(directory, "profiles.jsonc");
    fs.writeFileSync(configPath, '{ "profiles": ');

    try {
      vi.stubEnv("PI_PERMISSIONS_PROFILE_CONFIG", configPath);
      const harness = createExtensionHarness({
        entries: [
          {
            type: "custom",
            customType: "pi-permissions-profile",
            data: { profile: "builtin:read-only" },
          },
        ],
      });
      await harness.start("resume");

      // Profile restoration must not clear the configuration error: the gate
      // stays in its loud fail-closed state until the file is fixed.
      expect(lastCallArgument(harness.ui.setStatus, 1)).toBe(
        "invalid-permissions",
      );
      expect(harness.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining(configPath),
        "error",
      );

      const blocked = await harness.callTool({
        toolName: "bash",
        input: { command: "git status --short" },
      });
      expect(blocked).toMatchObject({ block: true });
      expect(blocked?.reason).toContain(configPath);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps blocking an invalid profile config when PI_SUBAGENT_PROFILE is valid", async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "pi-permissions-invalid-subagent-"),
    );
    const configPath = path.join(directory, "profiles.jsonc");
    fs.writeFileSync(configPath, '{ "profiles": ');

    try {
      vi.stubEnv("PI_PERMISSIONS_PROFILE_CONFIG", configPath);
      vi.stubEnv("PI_SUBAGENT_PROFILE", "builtin:worker");
      const harness = createExtensionHarness({ hasUI: false });
      await harness.start();

      expect(lastCallArgument(harness.ui.setStatus, 1)).toBe(
        "invalid-permissions",
      );

      const blocked = await harness.callTool({
        toolName: "bash",
        input: { command: "git status --short" },
      });
      expect(blocked).toMatchObject({ block: true });
      expect(blocked?.reason).toContain(configPath);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
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
    expect(lastCallArgument(harness.ui.setStatus, 1)).toContain(
      "builtin:default",
    );

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
      expect.stringContaining("Active profile: builtin:default"),
      "info",
    );

    await harness.runCommand("profile", "missing");
    expect(harness.ui.notify).toHaveBeenLastCalledWith(
      expect.stringContaining("Unknown profile 'missing'"),
      "error",
    );

    await harness.runCommand("profile", "builtin:read-only");
    expect(harness.entries.at(-1)).toMatchObject({
      customType: "pi-permissions-profile",
      data: { profile: "builtin:read-only" },
    });
    const completions = await harness
      .command("profile")
      .getArgumentCompletions?.("builtin:read");
    expect(completions?.map((completion) => completion.value)).toEqual([
      "builtin:read-only",
    ]);
    expect(lastCallArgument(harness.ui.setStatus, 1)).toContain("🔎");
    expect(lastCallArgument(harness.ui.setStatus, 1)).toContain(
      "builtin:read-only",
    );
  });

  it("restores the persisted read-only profile and its tool policy", async () => {
    const firstSession = createExtensionHarness();
    await firstSession.start();
    await firstSession.runCommand("read-only");

    const resumedSession = createExtensionHarness({
      entries: firstSession.entries,
    });
    await resumedSession.start("resume");

    expect(lastCallArgument(resumedSession.ui.setStatus, 1)).toContain(
      "builtin:read-only",
    );

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

  it("applies default write paths to Bash output redirection", async () => {
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
        input: { command: "sed -n '1,20p' /tmp/pi-history.txt" },
      }),
    ).resolves.toBeUndefined();

    await expect(
      harness.callToolWithoutPrompt({
        toolName: "bash",
        input: { command: "git log --oneline > history.txt" },
      }),
    ).resolves.toBeUndefined();

    await expect(
      harness.callToolWithoutPrompt({
        toolName: "bash",
        input: {
          command: "git log --oneline > /tmp/pi-history.txt > history.txt",
        },
      }),
    ).resolves.toBeUndefined();
  });

  it("applies the same Bash path policy to input redirections", async () => {
    const harness = createExtensionHarness({ confirm: false });
    await harness.start();

    await expect(
      harness.callToolWithoutPrompt({
        toolName: "bash",
        input: { command: "cat < /tmp/pi-input.txt" },
      }),
    ).resolves.toBeUndefined();

    const outside = await harness.callTool({
      toolName: "bash",
      input: { command: "cat < ../outside.txt" },
    });
    expect(outside).toMatchObject({ block: true });
    expect(harness.ui.confirm).toHaveBeenCalledOnce();
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

  it("blocks accidental cloud and SSH credential exposure", async () => {
    const harness = createExtensionHarness();
    await harness.start();

    for (const secretPath of [
      ".aws/credentials",
      ".azure/accessTokens.json",
      ".ssh/id_ed25519",
    ]) {
      for (const event of [
        { toolName: "read", input: { path: secretPath } },
        { toolName: "bash", input: { command: `cat ${secretPath}` } },
      ] as const) {
        const denied = await harness.callTool(event);
        expect(denied, JSON.stringify(event)).toMatchObject({ block: true });
        expect(denied?.reason).toContain(
          "protected from disclosure and mutation",
        );
      }
    }

    expect(harness.ui.confirm).not.toHaveBeenCalled();
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
      "find . -type f -print0 | xargs -0 cat",
      "bash -c 'cat .env'",
      "eval 'tail .env'",
      'for f in .env*; do cat "$f"; done',
    ]) {
      const denied = await harness.callTool({
        toolName: "bash",
        input: { command },
      });
      expect(denied, command).toMatchObject({ block: true });
      expect(harness.ui.confirm).not.toHaveBeenCalled();
    }

    harness.ui.confirm.mockClear();
    for (const command of [
      'f=.env; cat "$f"',
      "name=.env; sed -n '1,20p' \"$name\"",
      'output=history.txt; git log > "$output"',
    ]) {
      const denied = await harness.callTool({
        toolName: "bash",
        input: { command },
      });
      expect(denied).toMatchObject({ block: true });
      expect(harness.ui.confirm).toHaveBeenCalled();
      harness.ui.confirm.mockClear();
    }

    for (const profile of ["builtin:read-only", "socrates"] as const) {
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
    await harness.runCommand("profile", "builtin:default");
    for (const command of [
      "cat README.md",
      "sed -n '1,20p' README.md",
      "sed -n '1,20p' src/example.ts",
      "sed -n '1,20p' src/example.ts",
      "nl src/example.ts",
      "sort fixtures/names.txt",
      "wc -l README.md",
      "file README.md",
      "cat .env.template",
      "sed -n '1,20p' nested/.env.template",
    ]) {
      await expect(
        harness.callToolWithoutPrompt({ toolName: "bash", input: { command } }),
      ).resolves.toBeUndefined();
    }
  });

  it("changes protected read and edit access when switching profiles", async () => {
    vi.stubEnv(
      "PI_PERMISSIONS_PROFILE_CONFIG",
      writeTempConfig(
        JSON.stringify({
          profiles: {
            "read-secrets": {
              extends: ["builtin:default"],
              protectedPathRules: [{ pattern: ".env", decision: "allow" }],
            },
            "scratch-review": {
              tools: { bash: [{ pattern: "*", decision: "ask" }] },
              readPaths: [{ pattern: "*", decision: "allow" }],
              writePaths: [{ pattern: "*", decision: "allow" }],
            },
          },
        }),
      ),
    );

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

    await harness.runCommand("profile", "read-secrets");
    await expect(
      harness.callToolWithoutPrompt({ toolName: "read", input: readInput }),
    ).resolves.toBeUndefined();
    await expect(
      harness.callToolWithoutPrompt({ toolName: "edit", input: editInput }),
    ).resolves.toBeUndefined();

    await harness.runCommand("profile", "scratch-review");
    await expect(
      harness.callToolWithoutPrompt({ toolName: "read", input: readInput }),
    ).resolves.toBeUndefined();
    await expect(
      harness.callToolWithoutPrompt({ toolName: "edit", input: editInput }),
    ).resolves.toBeUndefined();
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
    expect(builtInGrepInput.glob).toBe(defaultProtectedSearchGlob);

    const safeGlobInput = {
      path: ".",
      pattern: "DATABASE_URL",
      glob: "**/*.ts",
    };
    const safeGlobResult = await harness.callTool({
      toolName: "grep",
      input: safeGlobInput,
    });
    expect(safeGlobResult).toMatchObject({ block: true });
    expect(safeGlobResult?.reason).toContain(
      "Pi's built-in grep forwards only one --glob to ripgrep",
    );
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
      `rg DATABASE_URL . ${defaultProtectedRipgrepArguments}`,
    );

    for (const command of ["grep -R DATABASE_URL .", "git grep DATABASE_URL"]) {
      await expect(
        harness.callTool({
          toolName: "bash",
          input: { command },
        }),
      ).resolves.toMatchObject({ block: true });
    }

    for (const command of [
      "rg --glob '**/*' DATABASE_URL .",
      "rg --glob 'secrets/*' DATABASE_URL .",
    ]) {
      await expect(
        harness.callTool({
          toolName: "bash",
          input: { command },
        }),
      ).resolves.toBeUndefined();
    }
  });

  it("applies profile-specific production overrides", async () => {
    vi.stubEnv("PI_PERMISSIONS_PROFILE_CONFIG", customProfileConfigPath);
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

    await harness.runCommand("profile", "review-tools");
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
      data: { profile: "builtin:read-only" },
    });
    expect(lastCallArgument(harness.ui.setStatus, 1)).toContain("🔎");
    expect(lastCallArgument(harness.ui.setStatus, 1)).toContain(
      "builtin:read-only",
    );

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
      expect(denied?.reason).toContain("Bash path reference");
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

  it("gates ambiguous Bash reader operands as writes under read-only while dedicated reads use readPaths", async () => {
    const harness = createExtensionHarness({ hasUI: false });
    await harness.start();
    await harness.runCommand("read-only");

    // Dedicated read tools evaluate readPaths and keep their normal access.
    await expect(
      harness.callToolWithoutPrompt({
        toolName: "read",
        input: { path: "README.md" },
      }),
    ).resolves.toBeUndefined();

    // Every Bash filesystem operand is write-gated, so an ambiguous basename
    // operand is denied even though the same file is readable through `read`.
    const operand = await harness.callTool({
      toolName: "bash",
      input: { command: "cat README.md" },
    });
    expect(operand).toMatchObject({ block: true });
    expect(operand?.reason).toContain("Bash path reference");

    // Proven Git revision objects are not filesystem operands and stay usable.
    await expect(
      harness.callToolWithoutPrompt({
        toolName: "bash",
        input: { command: "git show HEAD~3:src/example.ts" },
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

  it("returns configured steering from custom deny rules", async () => {
    vi.stubEnv(
      "PI_PERMISSIONS_PROFILE_CONFIG",
      writeTempConfig(
        JSON.stringify({
          defaultProfile: "script-steering",
          profiles: {
            "script-steering": {
              extends: ["builtin:default"],
              tools: {
                bash: [
                  {
                    pattern: "npx vitest *",
                    decision: "deny",
                    guidance: "Use the configured test script instead.",
                    alternatives: ["npm test -- <requested test filters>"],
                  },
                ],
              },
            },
          },
        }),
      ),
    );
    const harness = createExtensionHarness();
    await harness.start();

    const denied = await harness.callTool({
      toolName: "bash",
      input: { command: "npx vitest src/example.test.ts" },
    });

    expect(denied?.reason).toContain("Policy guidance:");
    expect(denied?.reason).toContain("npm test -- <requested test filters>");
  });

  describe("required read-only tools", () => {
    it("activates the built-in read tools on session start", async () => {
      const harness = createExtensionHarness();
      await harness.start();

      expect(harness.errors).toHaveLength(0);
      // Policy guidance references the read, grep, find, and ls tools; they
      // must be active even though pi only activates read/bash/edit/write.
      expect(harness.getActiveTools()).toEqual(
        expect.arrayContaining(["read", "grep", "find", "ls"]),
      );
      // Activation is additive: the default coding tools stay enabled.
      expect(harness.getActiveTools()).toEqual(
        expect.arrayContaining(["bash", "edit", "write"]),
      );
    });

    it("leaves the active set untouched when the read tools are already active", async () => {
      const harness = createExtensionHarness({
        registeredTools: [
          "read",
          "bash",
          "edit",
          "write",
          "grep",
          "find",
          "ls",
          "webfetch",
        ],
        activeTools: [
          "read",
          "bash",
          "edit",
          "write",
          "grep",
          "find",
          "ls",
          "webfetch",
        ],
      });
      await harness.start();

      expect(harness.errors).toHaveLength(0);
      expect(harness.setActiveToolsMock).not.toHaveBeenCalled();
      expect(harness.getActiveTools()).toContain("webfetch");
    });

    it("re-activates a missing read tool on profile switch", async () => {
      const harness = createExtensionHarness();
      await harness.start();

      harness.deactivateTool("grep");
      await harness.runCommand("profile", "builtin:read-only");

      expect(harness.getActiveTools()).toContain("grep");
    });

    it("fails loudly when a required read tool is not registered", async () => {
      const harness = createExtensionHarness({
        registeredTools: ["read", "bash", "edit", "write", "find", "ls"],
      });
      await harness.start();

      expect(harness.errors).toHaveLength(1);
      expect(harness.errors[0]?.event).toBe("session_start");
      expect(String(harness.errors[0]?.error)).toContain("grep");
      // The startup sequence aborts before presenting a normal profile status.
      expect(harness.ui.setStatus).not.toHaveBeenCalledWith(
        "permissions",
        expect.stringContaining("default"),
      );
    });
  });
});
