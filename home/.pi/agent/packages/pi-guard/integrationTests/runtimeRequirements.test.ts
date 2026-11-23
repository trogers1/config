import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  emptyResolvedRuntime,
  finalizeResolvedProfile,
} from "../modules/policyHelpers";
import { policyConfig } from "../modules/policy";
import { decideBash } from "../extensions/guard";
import { runtimeRequirementDefinition } from "../modules/runtimeRequirements";
import {
  clearSandboxCaches,
  resolveSandbox,
  setSandboxBackendForTesting,
  type SandboxBackend,
  type SandboxSpec,
} from "../modules/sandbox.lib";
import { createExtensionHarness } from "./support/extensionHarness";

const temporaryDirectories: string[] = [];

function recordingBackend({
  specifications,
}: {
  readonly specifications: SandboxSpec[];
}): SandboxBackend {
  return {
    probe: () => Promise.resolve({ supported: true }),
    prepare: (specification) => {
      specifications.push(specification);
      return Promise.resolve({
        backend: "fake",
        report: {
          uncoveredRestrictions: [],
          waivedRestrictions: [],
          untranslatedAllows: [],
          noKernelMeaning: [],
        },
        denialSignatures: [],
        operations: { exec: () => Promise.resolve({ exitCode: 0 }) },
      });
    },
    dispose: () => Promise.resolve(),
  };
}

function onlyPreparedSpecification({
  specifications,
}: {
  readonly specifications: readonly SandboxSpec[];
}): SandboxSpec {
  expect(specifications).toHaveLength(1);
  const specification = specifications[0];
  if (!specification) {
    throw new Error("Expected exactly one prepared sandbox specification");
  }
  return specification;
}

function writeProfileConfig({
  extendsProfiles,
}: {
  readonly extendsProfiles: readonly string[];
}): void {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-guard-runtime-"));
  temporaryDirectories.push(directory);
  const configPath = path.join(directory, "profiles.jsonc");
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      defaultProfile: "runtime-test",
      profiles: {
        "runtime-test": {
          description: "Runtime requirement extension-boundary test profile.",
          extends: extendsProfiles,
        },
      },
    }),
  );
  process.env.PI_GUARD_PROFILE_CONFIG = configPath;
}

async function invokeBashThroughExtension({
  startupCwd,
  command,
}: {
  readonly startupCwd: string;
  readonly command: string;
}): Promise<void> {
  const harness = createExtensionHarness({ contextCwd: startupCwd });
  try {
    await harness.start();
    await expect(
      harness.callTool({
        toolName: "bash",
        input: { command, timeout: 5 },
      }),
    ).resolves.not.toMatchObject({ block: true });
  } finally {
    await harness.shutdown();
  }
}

afterEach(async () => {
  await clearSandboxCaches();
  setSandboxBackendForTesting(undefined);
  delete process.env.PI_GUARD_PROFILE_CONFIG;
  delete process.env.PI_SUBAGENT_PERMISSIBLE_GLOBS;
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("runtime requirement sandbox resolution", () => {
  it.each([
    { profile: "builtin:default", scoped: false },
    { profile: "builtin:default", scoped: true },
    { profile: "builtin:deps-mutator", scoped: false },
    { profile: "builtin:deps-mutator", scoped: true },
  ] as const)(
    "keeps Rust runtime grants narrow for $profile with source scope=$scoped",
    async ({ profile, scoped }) => {
      const specifications: SandboxSpec[] = [];
      setSandboxBackendForTesting(recordingBackend({ specifications }));
      writeProfileConfig({
        extendsProfiles: [profile],
      });
      if (scoped) process.env.PI_SUBAGENT_PERMISSIBLE_GLOBS = "src/**";
      const startupCwd = process.cwd();
      await invokeBashThroughExtension({ startupCwd, command: "cargo check" });
      const specification = onlyPreparedSpecification({ specifications });
      const roots = specification.filesystem.writeAllowRoots;
      for (const configured of policyConfig.profiles[
        profile
      ].runtime.requirements.flatMap(
        (name) => runtimeRequirementDefinition({ name }).sandboxWritePaths,
      )) {
        const resolved = path.join(
          os.homedir(),
          configured.slice(2).replace(/\/\*\*$/, ""),
        );
        expect(roots).toContain(resolved);
      }
      // Negative paths must not be covered by any ancestor grant.
      for (const relative of [
        ...(profile === "builtin:default" ? [".cargo/bin", ".rustup"] : []),
        ".cargo/config",
        ".cargo/config.toml",
        ".cargo/credentials",
        ".cargo/credentials.toml",
        ".cargo/.global-cache-journal",
      ]) {
        const candidate = path.join(os.homedir(), relative);
        expect(
          roots.some(
            (root) =>
              candidate === root || candidate.startsWith(root + path.sep),
          ),
          candidate,
        ).toBe(false);
      }
      if (scoped)
        expect(roots).not.toContain(path.resolve(startupCwd, "target"));
    },
  );

  it("limits Rust dependency/toolchain mutations to the dependency profile", () => {
    for (const command of [
      "cargo install ripgrep",
      "cargo uninstall ripgrep",
      "rustup update --no-self-update",
      "rustup update --no-self-update stable",
      "rustup toolchain install --no-self-update stable",
      "rustup toolchain uninstall nightly",
      "rustup component add clippy",
      "rustup component remove clippy",
      "rustup target add wasm32-unknown-unknown",
      "rustup target remove wasm32-unknown-unknown",
    ]) {
      expect(
        decideBash(
          command,
          policyConfig.profiles["builtin:deps-mutator"].policy,
        ),
        command,
      ).toBe("allow");
      expect(
        decideBash(command, policyConfig.profiles["builtin:default"].policy),
        command,
      ).not.toBe("allow");
    }
    for (const command of [
      "cargo publish",
      "cargo login token",
      "rustup self update",
      "rustup self uninstall",
      "rustup update",
      "rustup update stable",
      "rustup toolchain install",
      "rustup toolchain install stable",
    ]) {
      expect(
        decideBash(
          command,
          policyConfig.profiles["builtin:deps-mutator"].policy,
        ),
        command,
      ).not.toBe("allow");
    }
  });

  it("carries ruleset:vitest through the full extension path and narrowed scope", async () => {
    const specifications: SandboxSpec[] = [];
    setSandboxBackendForTesting(recordingBackend({ specifications }));
    writeProfileConfig({
      extendsProfiles: ["builtin:read-only", "ruleset:vitest"],
    });
    process.env.PI_SUBAGENT_PERMISSIBLE_GLOBS = "src/**";
    const startupCwd = process.cwd();

    await invokeBashThroughExtension({ startupCwd, command: "npm test" });

    const roots = onlyPreparedSpecification({ specifications }).filesystem
      .writeAllowRoots;
    expect(roots).toContain(
      path.resolve(startupCwd, "node_modules/.vite-temp"),
    );
    expect(roots.some((root) => /(?:^|\/)pi-guard-/.test(root))).toBe(true);
    expect(roots).not.toContain(path.resolve(startupCwd, "node_modules"));
    expect(roots).not.toContain(
      path.resolve(startupCwd, "node_modules/.vite-temp-sibling"),
    );
  });

  it("does not materialize an unselected Vitest root through the extension", async () => {
    const specifications: SandboxSpec[] = [];
    setSandboxBackendForTesting(recordingBackend({ specifications }));
    writeProfileConfig({ extendsProfiles: ["builtin:read-only"] });
    const startupCwd = process.cwd();

    await invokeBashThroughExtension({ startupCwd, command: "git status" });

    expect(
      onlyPreparedSpecification({ specifications }).filesystem.writeAllowRoots,
    ).not.toContain(path.resolve(startupCwd, "node_modules/.vite-temp"));
  });

  it("treats an explicitly empty subagent scope as unscoped", async () => {
    const specifications: SandboxSpec[] = [];
    setSandboxBackendForTesting(recordingBackend({ specifications }));
    const startupCwd = process.cwd();
    const resolvedProfile = finalizeResolvedProfile({
      policy: {
        ...policyConfig.profiles["builtin:read-only"].policy,
        writePaths: [{ pattern: "configured/**", decision: "allow" }],
      },
      runtime: emptyResolvedRuntime,
    });

    const resolution = await resolveSandbox({
      profile: "empty-scope",
      resolvedProfile,
      startupCwd,
      subagentScopes: [],
    });

    expect(resolution.kind).toBe("active");
    expect(
      onlyPreparedSpecification({ specifications }).filesystem.writeAllowRoots,
    ).toContain(path.resolve(startupCwd, "configured"));
  });
});
