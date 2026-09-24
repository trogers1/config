import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect } from "vitest";
import { setGuardOperationObserverForTesting } from "../../extensions/guard";
import type { Decision, ProfileConfigFile } from "../../modules/policyHelpers";
import {
  clearSandboxCaches,
  setSandboxBackendForTesting,
} from "../../modules/sandbox.lib";
import type { SandboxBackend, SandboxSpec } from "../../modules/sandbox.lib";
import { askPermissionChoices } from "../../modules/profileUpdate";
import type { ProfileAuthoringOverviewSelection } from "../../modules/profileAuthoringOverview";
import type { createExtensionHarness } from "./extensionHarness";

export const submitOverviewSelection = {
  kind: "action",
  id: "submit",
} as const satisfies ProfileAuthoringOverviewSelection;

export function overviewSectionSelection({
  id,
}: {
  readonly id: Extract<
    ProfileAuthoringOverviewSelection,
    { readonly kind: "section" }
  >["id"];
}): ProfileAuthoringOverviewSelection {
  return { kind: "section", id };
}

const originalConfigPath = process.env.PI_GUARD_PROFILE_CONFIG;
const originalSubagentProfile = process.env.PI_SUBAGENT_PROFILE;
const originalActiveProfile = process.env.PI_GUARD_ACTIVE_PROFILE;
const originalHome = process.env.HOME;
export const [denyChoice, allowOnceChoice, saveRulesChoice] =
  askPermissionChoices;
const temporaryDirectories: string[] = [];

export function trackTemporaryDirectory({
  directory,
}: {
  readonly directory: string;
}): void {
  temporaryDirectories.push(directory);
}

export function writeConfig({
  config,
}: {
  readonly config: ProfileConfigFile;
}): string {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-guard-profile-update-"),
  );
  trackTemporaryDirectory({ directory });
  const configPath = path.join(directory, "profiles.jsonc");
  fs.writeFileSync(
    configPath,
    `// Behavioral profile-update fixture\n${JSON.stringify(config, null, 2)}\n`,
  );
  return configPath;
}

export function replaceConfig({
  configPath,
  config,
}: {
  readonly configPath: string;
  readonly config: ProfileConfigFile;
}): void {
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

export function profileWithBashRule({
  profile = "current",
  command,
  decision,
  description = "Cross-instance profile",
}: {
  readonly profile?: string;
  readonly command: string;
  readonly decision: Decision;
  readonly description?: string;
}): ProfileConfigFile {
  return {
    defaultProfile: profile,
    profiles: {
      [profile]: {
        description,
        extends: ["builtin:default"],
        tools: { bash: [{ pattern: command, decision }] },
      },
    },
  } satisfies ProfileConfigFile;
}

export const durableDecisions = [
  "allow",
  "deny",
] as const satisfies readonly Decision[];
export type DurableDecision = (typeof durableDecisions)[number];
type RunningHarness = ReturnType<typeof createExtensionHarness>;

export type OrdinaryPathScenario = {
  readonly toolName: "read";
  readonly input: { readonly path: string };
  readonly path: string;
};
type CustomToolScenario = {
  readonly toolName: "deploy";
  readonly input: { readonly environment: "staging" };
};

export function ordinaryPathScenario({
  path: requestedPath,
}: {
  readonly path: string;
}): OrdinaryPathScenario {
  return {
    toolName: "read",
    input: { path: requestedPath },
    path: requestedPath,
  };
}

export function customToolScenario({}: Record<
  never,
  never
> = {}): CustomToolScenario {
  return { toolName: "deploy", input: { environment: "staging" } };
}

export function profileWithOrdinaryPathRule({
  path: requestedPath,
  decision,
}: {
  readonly path: string;
  readonly decision: Decision;
}): ProfileConfigFile {
  return {
    defaultProfile: "current",
    profiles: {
      current: {
        description: "Shared ordinary-path profile",
        extends: ["builtin:default"],
        readPaths: [{ pattern: requestedPath, decision, contexts: ["read"] }],
      },
    },
  } satisfies ProfileConfigFile;
}

export function profileWithCustomToolRule({
  decision,
}: {
  readonly decision: Decision;
}): ProfileConfigFile {
  return {
    defaultProfile: "current",
    profiles: {
      current: {
        description: "Shared custom-tool profile",
        extends: ["builtin:default"],
        tools: { deploy: [{ decision, match: { environment: "staging" } }] },
      },
    },
  } satisfies ProfileConfigFile;
}

export async function saveBashDecision({
  harness,
  command,
  decision,
}: {
  readonly harness: RunningHarness;
  readonly command: string;
  readonly decision: DurableDecision;
}): Promise<void> {
  const pending = harness.callTool({ toolName: "bash", input: { command } });
  (await harness.ui.waitForPermissionChoice()).choose(saveRulesChoice);
  const editor = await harness.ui.waitForRuleForm();
  if (decision === "deny") editor.press("Tab");
  editor.press("Enter");
  await pending;
}

export async function saveOrdinaryPathDecision({
  harness,
  scenario,
  decision,
}: {
  readonly harness: RunningHarness;
  readonly scenario: OrdinaryPathScenario;
  readonly decision: DurableDecision;
}): Promise<void> {
  const pending = harness.callTool(scenario);
  (await harness.ui.waitForPermissionChoice()).choose(saveRulesChoice);
  const editor = await harness.ui.waitForRuleForm();
  if (decision === "deny") editor.press("Tab");
  editor.press("Enter");
  await pending;
}

export function expectDecision({
  result,
  decision,
}: {
  readonly result: { readonly block?: boolean } | undefined;
  readonly decision: DurableDecision;
}): void {
  expect(result?.block ?? false).toBe(decision === "deny");
}

function restoreEnvironment(): void {
  if (originalConfigPath === undefined)
    delete process.env.PI_GUARD_PROFILE_CONFIG;
  else process.env.PI_GUARD_PROFILE_CONFIG = originalConfigPath;
  if (originalSubagentProfile === undefined)
    delete process.env.PI_SUBAGENT_PROFILE;
  else process.env.PI_SUBAGENT_PROFILE = originalSubagentProfile;
  if (originalActiveProfile === undefined)
    delete process.env.PI_GUARD_ACTIVE_PROFILE;
  else process.env.PI_GUARD_ACTIVE_PROFILE = originalActiveProfile;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
}

export function recordingSandboxBackend({
  prepared,
}: {
  readonly prepared: SandboxSpec[];
}): SandboxBackend {
  return {
    probe: () => Promise.resolve({ supported: true }),
    prepare: (spec) => {
      prepared.push(spec);
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
        dispose: () => Promise.resolve(),
      });
    },
    dispose: () => Promise.resolve(),
  };
}

export function installProfileUpdateFixture({}: Record<
  never,
  never
> = {}): void {
  beforeEach(() => {
    // Profile-update behavior does not require the process-global OS sandbox.
    // Keep lifecycle/cache semantics while avoiding real runtime setup per harness.
    setSandboxBackendForTesting(recordingSandboxBackend({ prepared: [] }));
  });

  afterEach(async () => {
    setGuardOperationObserverForTesting({ observer: undefined });
    restoreEnvironment();
    await clearSandboxCaches();
    setSandboxBackendForTesting(undefined);
    for (const directory of temporaryDirectories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
}
