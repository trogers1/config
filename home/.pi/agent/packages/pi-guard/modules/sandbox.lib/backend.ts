import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { createSandboxedLocalOperations } from "./operations";
import type {
  SandboxBackend,
  SandboxBackendProbe,
  SandboxSpec,
  PreparedSandbox,
} from "./types";

/**
 * The sandbox runtime owns the platform-specific Seatbelt/bubblewrap adapter,
 * including its network proxy lifecycle. Keep it behind this boundary so the
 * policy compiler and extension never depend on runtime-specific types.
 */
// See https://github.com/anthropic-experimental/sandbox-runtime#security-limitations
// before forwarding enableWeakerNetworkIsolation to the runtime.
function toRuntimeConfig(spec: SandboxSpec): SandboxRuntimeConfig {
  const filesystem = {
    denyRead: spec.filesystem.readDenyRoots,
    allowRead: spec.filesystem.readAllowRoots,
    allowWrite: spec.filesystem.writeAllowRoots,
    denyWrite: spec.filesystem.writeDenyRoots,
  };
  if (spec.network === "allow") {
    // sandbox-runtime treats an omitted allowlist as unrestricted networking.
    // Its exported TypeScript type requires allowlist fields even though its
    // runtime API deliberately supports their absence for this posture.
    return {
      filesystem,
      network: {},
      enableWeakerNetworkIsolation: spec.enableWeakerNetworkIsolation,
    } as SandboxRuntimeConfig;
  }
  return {
    filesystem,
    enableWeakerNetworkIsolation: spec.enableWeakerNetworkIsolation,
    network: {
      allowedDomains: [],
      deniedDomains: ["*"],
      strictAllowlist: true,
      allowLocalBinding: spec.allowLocalBinding,
    },
  };
}

async function runtimeProbe(): Promise<SandboxBackendProbe> {
  if (!SandboxManager.isSupportedPlatform()) {
    return {
      supported: false,
      reason: "pi-guard sandbox backend is only available on macOS.",
    };
  }

  const dependencies = await SandboxManager.checkDependenciesAsync();
  if (dependencies.errors.length > 0) {
    return { supported: false, reason: dependencies.errors.join(" ") };
  }

  return { supported: true };
}

// SRT is process-global. Serialize lifecycle and execution so a profile switch
// cannot reset or reconfigure it underneath an in-flight Bash process.
let runtimeQueue: Promise<void> = Promise.resolve();

function withRuntimeLock<T>(operation: () => Promise<T>): Promise<T> {
  const result = runtimeQueue.then(operation, operation);
  runtimeQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

const backend: SandboxBackend = {
  probe(): Promise<SandboxBackendProbe> {
    return runtimeProbe();
  },

  async prepare(spec: SandboxSpec): Promise<PreparedSandbox> {
    const probe = await runtimeProbe();
    if (!probe.supported) {
      throw new Error(probe.reason ?? "Sandbox backend unavailable.");
    }

    await withRuntimeLock(async () => {
      await SandboxManager.initialize(toRuntimeConfig(spec));
    });
    const local = createSandboxedLocalOperations();

    return {
      backend: "macos",
      report: {
        uncoveredRestrictions: [],
        waivedRestrictions: [],
        untranslatedAllows: [],
        noKernelMeaning: [],
      },
      operations: {
        exec(command, cwd, options) {
          return withRuntimeLock(async () => {
            const wrapped = await SandboxManager.wrapWithSandbox(
              command,
              undefined,
              undefined,
              options.signal,
            );
            try {
              return await local.exec(wrapped, cwd, options);
            } finally {
              SandboxManager.cleanupAfterCommand();
            }
          });
        },
      },
      denialSignatures: [/operation not permitted/i, /sandbox/i, /blocked/i],
      dispose: () => withRuntimeLock(() => SandboxManager.reset()),
    };
  },

  dispose(): Promise<void> {
    return withRuntimeLock(() => SandboxManager.reset());
  },
};

export function getSandboxBackend(): SandboxBackend {
  return backend;
}
