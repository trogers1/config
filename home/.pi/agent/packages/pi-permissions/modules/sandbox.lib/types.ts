import type { BashOperations } from "@earendil-works/pi-coding-agent";
import type { PathContext, ProfilePolicy, Rule } from "../policyHelpers";

export type SandboxRuleSource =
  "profile" | "protected" | "subagent" | "sandbox";

export type SandboxPathRule = {
  pattern: string;
  decision: "allow" | "deny";
  context: PathContext | "any";
  source: SandboxRuleSource;
  guidance?: string;
};

export type SandboxFilesystemSpec = {
  startupCwd: string;
  readAllowRoots: string[];
  readDenyRoots: string[];
  writeAllowRoots: string[];
  writeDenyRoots: string[];
  scopeRoots: string[];
};

export type SandboxSpec = {
  profile: string;
  network: "allow" | "deny";
  /** Opt in to sandbox-runtime's macOS trustd IPC relaxation. */
  enableWeakerNetworkIsolation: boolean;
  /** Permit local Unix-domain and loopback listeners without external network access. */
  allowLocalBinding: boolean;
  filesystem: SandboxFilesystemSpec;
  readRules: SandboxPathRule[];
  writeRules: SandboxPathRule[];
};

export type CoverageItem = {
  pattern: string;
  source: string;
  reason?: string;
};

export type CoverageReport = {
  uncoveredRestrictions: CoverageItem[];
  waivedRestrictions: CoverageItem[];
  untranslatedAllows: CoverageItem[];
  noKernelMeaning: CoverageItem[];
};

export type SandboxState = {
  profile: string;
  policy: ProfilePolicy;
  startupCwd: string;
  subagentScopes?: Rule[];
  configurationError?: string;
};

export type PreparedSandbox = {
  backend: "macos" | "linux" | "fake";
  report: CoverageReport;
  operations: BashOperations;
  denialSignatures: RegExp[];
  dispose?: () => Promise<void> | void;
};

export type SandboxResolution =
  | { kind: "none" }
  | {
      kind: "unavailable";
      reason: string;
      onUnavailable: "block" | "warn";
      report?: CoverageReport;
    }
  | {
      kind: "active";
      spec: SandboxSpec;
      report: CoverageReport;
      prepared: PreparedSandbox;
    };

export type SandboxBackendProbe = {
  supported: boolean;
  reason?: string;
};

export interface SandboxBackend {
  probe(): Promise<SandboxBackendProbe>;
  prepare(spec: SandboxSpec): Promise<PreparedSandbox>;
  dispose(): Promise<void>;
}
