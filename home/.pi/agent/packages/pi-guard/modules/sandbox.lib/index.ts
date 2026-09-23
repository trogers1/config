import { parseResolvedProfile } from "../policyHelpers";
import { resolveRuntimeRequirementWritePaths } from "../runtimeRequirements";
import { getSandboxBackend } from "./backend";
import { ensureSandboxTemporaryDirectory } from "./temporaryDirectory";
import { translatePolicy } from "./translate";
import type {
  CoverageReport,
  SandboxBackend,
  SandboxResolution,
  SandboxState,
} from "./types";

export { translatePolicy } from "./translate";
export type {
  CoverageItem,
  CoverageReport,
  PreparedSandbox,
  SandboxBackend,
  SandboxBackendProbe,
  SandboxFilesystemSpec,
  SandboxPathRule,
  SandboxResolution,
  SandboxRuleSource,
  SandboxSpec,
  SandboxState,
} from "./types";

const sandboxCache = new Map<string, SandboxResolution>();
let sandboxBackendOverride: SandboxBackend | undefined;
let lifecycleQueue: Promise<void> = Promise.resolve();

function withLifecycleLock<T>(operation: () => Promise<T>): Promise<T> {
  const result = lifecycleQueue.then(operation, operation);
  lifecycleQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export function setSandboxBackendForTesting(
  backend: SandboxBackend | undefined,
): void {
  sandboxBackendOverride = backend;
}

export function resolveSandbox(
  state: SandboxState,
): Promise<SandboxResolution> {
  return withLifecycleLock(() => resolveSandboxLocked(state));
}

async function resolveSandboxLocked(
  state: SandboxState,
): Promise<SandboxResolution> {
  if (state.configurationError) {
    return {
      kind: "unavailable",
      reason: state.configurationError,
      onUnavailable: "block",
    };
  }

  const { policy: resolvedPolicy, runtime } = parseResolvedProfile({
    unverifiedProfile: state.resolvedProfile,
  });
  const sandbox = resolvedPolicy.sandbox;
  if (typeof sandbox !== "object" || sandbox === null) {
    return { kind: "none" };
  }

  // SRT overwrites TMPDIR for filesystem-sandboxed children. Its private
  // directory and selected audited requirements are operational roots, not
  // workspace access, so preserve them when a subagent scope narrows writes.
  const runtimeWritePaths = [
    ...resolveRuntimeRequirementWritePaths({
      requirements: runtime.requirements,
    }),
    ensureSandboxTemporaryDirectory(),
  ];
  const policy = {
    ...resolvedPolicy,
    sandbox: {
      ...sandbox,
      extraWritePaths: [
        ...(sandbox.extraWritePaths ?? []),
        ...runtimeWritePaths,
      ],
    },
  };
  const subagentScopes = state.subagentScopes?.length
    ? [
        ...state.subagentScopes,
        ...runtimeWritePaths.map((pattern) => ({
          pattern,
          decision: "allow" as const,
        })),
      ]
    : [];
  const cacheKey = JSON.stringify({
    profile: state.profile,
    policy,
    startupCwd: state.startupCwd,
    subagentScopes,
  });
  const cached = sandboxCache.get(cacheKey);
  if (cached) return cached;

  const backend = sandboxBackendOverride ?? getSandboxBackend();
  const probe = await safeProbe(backend);
  if (!probe.supported) {
    const translated = translatePolicy(
      policy,
      state.profile,
      state.startupCwd,
      subagentScopes,
    );
    const resolution = unavailableResolution(
      probe.reason ?? "Sandbox backend unavailable.",
      translated.report,
      sandbox,
    );
    sandboxCache.set(cacheKey, resolution);
    return resolution;
  }

  const translated = translatePolicy(
    policy,
    state.profile,
    state.startupCwd,
    subagentScopes,
  );
  if (translated.kind === "unavailable") {
    const resolution: SandboxResolution = {
      kind: "unavailable",
      reason: translated.reason,
      onUnavailable: sandbox.onUnavailable ?? "block",
      report: translated.report,
    };
    sandboxCache.set(cacheKey, resolution);
    return resolution;
  }

  try {
    // SandboxManager is process-global, so only one prepared policy may be
    // resident at a time. Dispose any prior policy before initializing this
    // exact translated spec.
    await disposeCachedPreparations(backend);
    const prepared = await backend.prepare(translated.spec);
    const resolution: SandboxResolution = {
      kind: "active",
      spec: translated.spec,
      report: translated.report,
      prepared,
    };
    sandboxCache.set(cacheKey, resolution);
    return resolution;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const resolution = unavailableResolution(
      reason,
      translated.report,
      sandbox,
    );
    sandboxCache.set(cacheKey, resolution);
    return resolution;
  }
}

function unavailableResolution(
  reason: string,
  report: CoverageReport,
  sandbox: { onUnavailable?: "block" | "warn" },
): SandboxResolution {
  return {
    kind: "unavailable",
    reason,
    onUnavailable: sandbox.onUnavailable ?? "block",
    report,
  };
}

async function safeProbe(
  backend: SandboxBackend,
): Promise<{ supported: boolean; reason?: string }> {
  try {
    return await backend.probe();
  } catch (error) {
    return {
      supported: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export function clearSandboxCaches(): Promise<void> {
  return withLifecycleLock(async () => {
    const backend = sandboxBackendOverride ?? getSandboxBackend();
    await disposeCachedPreparations(backend);
    sandboxCache.clear();
    await backend.dispose();
  });
}

async function disposeCachedPreparations(
  backend: SandboxBackend,
): Promise<void> {
  const prepared = new Set(
    [...sandboxCache.values()]
      .filter(
        (
          resolution,
        ): resolution is Extract<SandboxResolution, { kind: "active" }> =>
          resolution.kind === "active",
      )
      .map((resolution) => resolution.prepared),
  );
  sandboxCache.clear();
  await Promise.all(
    [...prepared].map(async (sandbox) => {
      await sandbox.dispose?.();
    }),
  );
  await backend.dispose();
}
