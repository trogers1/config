import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { Type } from "typebox";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { CLAUDE_BRIDGE_PROVIDER } from "../../pi-guard-subagents/extensions/interactive/provider-extensions.ts";
import { parseJson } from "../extensions/validation.ts";
import { ManifestSchema } from "./contract.ts";
import { createFakeClaudeCli } from "./fixtures/claude-cli.ts";
import { CLAUDE_EXECUTABLE_ENV } from "../extensions/cli.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
test("installed Pi discovers the relative local package and lists models without invoking Claude", async () => {
  const temp = mkdtempSync(join(tmpdir(), "pi-claude-discovery-"));
  try {
    const agent = join(temp, "agent");
    const cwd = join(temp, "workspace");
    mkdirSync(join(agent, "packages"), { recursive: true });
    mkdirSync(cwd);
    symlinkSync(root, join(agent, "packages/pi-claude"), "dir");
    symlinkSync(
      resolve(root, "../pi-guard-subagents"),
      join(agent, "packages/pi-guard-subagents"),
      "dir",
    );
    writeFileSync(
      join(agent, "settings.json"),
      JSON.stringify({
        packages: ["./packages/pi-claude"],
        retry: { enabled: false },
        compaction: { enabled: false },
        enableInstallTelemetry: false,
      }),
    );
    const cli = createFakeClaudeCli({ directory: join(temp, "cli") });
    const env = {
      PATH: process.env.PATH,
      HOME: temp,
      USERPROFILE: temp,
      PI_CODING_AGENT_DIR: agent,
      CLAUDE_CONFIG_DIR: join(temp, "claude"),
      [CLAUDE_EXECUTABLE_ENV]: cli.executable,
      PI_OFFLINE: "1",
    } satisfies NodeJS.ProcessEnv;
    const agentPackage = process.env.PI_TEST_AGENT_PACKAGE;
    if (!agentPackage) throw new Error("Select the installed Pi using PI_TEST_AGENT_PACKAGE");
    const pi = process.env.PI_TEST_BIN ?? process.execPath;
    const prefix = process.env.PI_TEST_BIN ? [] : [join(agentPackage, "dist/cli.js")];
    const version = spawnSync(pi, [...prefix, "--version"], {
      cwd,
      env,
      encoding: "utf8",
      timeout: 15_000,
    });
    assert.ifError(version.error);
    expect(version.status, version.stderr).toBe(0);
    const manifest = parseJson({
      text: readFileSync(join(root, "package.json"), "utf8"),
      schema: ManifestSchema,
      source: "provider manifest",
    });
    const host = parseJson({
      text: readFileSync(join(agentPackage, "package.json"), "utf8"),
      schema: Type.Object({
        version: ManifestSchema.properties.piCompatibility.properties.minimumVersion,
      }),
      source: "selected Pi host manifest",
    });
    expect(version.stdout.trim()).toBe(host.version);
    const minimum = manifest.piCompatibility.minimumVersion.split(".").map(Number);
    const difference =
      host.version
        .split(".")
        .map((part, index) => {
          const floor = minimum[index];
          if (floor === undefined) throw new Error("Pi version components do not match");
          return Number(part) - floor;
        })
        .find((part) => part !== 0) ?? 0;
    expect(difference).toBeGreaterThanOrEqual(0);
    // Metadata-only CLI mode suppresses extension-load diagnostics. Exercise
    // its real disk/package loader first so failures report the actual cause.
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: agent,
      settingsManager: SettingsManager.create(cwd, agent),
      noSkills: true,
      noContextFiles: true,
      noPromptTemplates: true,
      noThemes: true,
    });
    const previousEnv = { ...process.env };
    try {
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, env);
      await loader.reload({ resolveProjectTrust: async () => true });
      expect(loader.getExtensions().errors).toEqual([]);
    } finally {
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, previousEnv);
    }
    const listed = spawnSync(
      pi,
      [
        ...prefix,
        "--offline",
        "--approve",
        "--no-session",
        "--no-skills",
        "--no-context-files",
        "--no-prompt-templates",
        "--no-themes",
        "--list-models",
        CLAUDE_BRIDGE_PROVIDER,
      ],
      { cwd, env, encoding: "utf8", timeout: 20_000 },
    );
    assert.ifError(listed.error);
    expect(listed.status, listed.stderr).toBe(0);
    expect(`${listed.stdout}\n${listed.stderr}`).not.toMatch(
      /Failed to load extension|Cannot find module|Error loading extension/,
    );
    expect(listed.stdout, `${listed.stdout}\n${listed.stderr}`).toContain(CLAUDE_BRIDGE_PROVIDER);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
