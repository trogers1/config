import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { dependencyCacheKernelWaiver } from "./dependencyCaches";
import type { ProtectedPathRule } from "./policyHelpers";
import { runtimeRequirementDefinition } from "./runtimeRequirements";

const goRuntimeProtectedPaths = runtimeRequirementDefinition({
  name: "go-toolchain-cache",
}).protectedPathPatterns;

// Resolve existing ancestors too: auth.json may be created after policy startup.
function canonicalCredentialPath({ filePath }: { filePath: string }): string {
  if (fs.lstatSync(filePath, { throwIfNoEntry: false }) !== undefined) {
    return fs.realpathSync(filePath);
  }
  return path.join(
    canonicalCredentialPath({ filePath: path.dirname(filePath) }),
    path.basename(filePath),
  );
}

const credentialPaths = [
  path.join(homedir(), ".pi", "agent", "auth.json"),
  path.resolve(getAgentDir(), "auth.json"),
];
const credentialProtectedRules = [
  ...new Set(
    credentialPaths.flatMap((filePath) => [
      filePath,
      canonicalCredentialPath({ filePath }),
    ]),
  ),
].map((pattern) => ({
  pattern,
  decision: "deny" as const,
  guidance:
    "Pi credentials are protected even when other Pi configuration is readable.",
}));

/** Default secret and repository-metadata paths configured by standard profiles. */
export const defaultProtectedPathRules: ProtectedPathRule[] = [
  ...credentialProtectedRules,
  {
    pattern: "**/.pi/agent/auth.json",
    decision: "deny",
    guidance:
      "Pi credentials are protected even when other Pi configuration is readable.",
  },
  {
    pattern: "**/.env*",
    decision: "deny",
    guidance:
      "This path is protected from disclosure and mutation by the active profile.",
  },
  {
    pattern: "**/.env*/**",
    decision: "deny",
    guidance:
      "This path is protected from disclosure and mutation by the active profile.",
  },
  {
    pattern: "**/.git",
    decision: "deny",
    guidance:
      "This path is protected from disclosure and mutation by the active profile.",
  },
  {
    pattern: "**/.git/**",
    decision: "deny",
    guidance:
      "This path is protected from disclosure and mutation by the active profile.",
  },
  {
    pattern: "**/.aws/**",
    decision: "deny",
    guidance:
      "This path is protected from disclosure and mutation by the active profile.",
  },
  {
    pattern: "**/.azure/**",
    decision: "deny",
    guidance:
      "This path is protected from disclosure and mutation by the active profile.",
  },
  {
    pattern: "**/.config/gcloud/**",
    decision: "deny",
    guidance:
      "This path is protected from disclosure and mutation by the active profile.",
  },
  {
    pattern: "**/.config/gh/**",
    decision: "deny",
    guidance:
      "This path is protected from disclosure and mutation by the active profile.",
  },
  {
    pattern: "**/.config/glab-cli/**",
    decision: "deny",
    guidance:
      "This path is protected from disclosure and mutation by the active profile.",
  },
  {
    pattern: "**/.oci/**",
    decision: "deny",
    guidance:
      "This path is protected from disclosure and mutation by the active profile.",
  },
  {
    pattern: "**/.docker/config.json",
    decision: "deny",
    guidance:
      "This path is protected from disclosure and mutation by the active profile.",
  },
  ...dependencyCacheKernelWaiver.map((pattern) => ({
    pattern,
    decision: "deny" as const,
    guidance:
      "Package-manager cache paths are protected from direct disclosure and mutation by the active profile.",
  })),
  ...goRuntimeProtectedPaths.map((pattern) => ({
    pattern,
    decision: "deny" as const,
    guidance:
      "Go toolchain cache paths are protected from direct disclosure and mutation by the active profile.",
  })),
  {
    pattern: "**/.npmrc",
    decision: "deny",
    guidance:
      "This path is protected from disclosure and mutation by the active profile.",
  },
  {
    pattern: "**/.pypirc",
    decision: "deny",
    guidance:
      "This path is protected from disclosure and mutation by the active profile.",
  },
  {
    pattern: "**/.netrc",
    decision: "deny",
    guidance:
      "This path is protected from disclosure and mutation by the active profile.",
  },
  {
    pattern: "**/.git-credentials",
    decision: "deny",
    guidance:
      "This path is protected from disclosure and mutation by the active profile.",
  },
  {
    pattern: "**/.ssh/**",
    decision: "deny",
    guidance:
      "This path is protected from disclosure and mutation by the active profile.",
  },
  {
    pattern: "**/.gnupg/**",
    decision: "deny",
    guidance:
      "This path is protected from disclosure and mutation by the active profile.",
  },
  {
    pattern: "**/.kube/**",
    decision: "deny",
    guidance:
      "This path is protected from disclosure and mutation by the active profile.",
  },
  {
    pattern: "**/.vault-token",
    decision: "deny",
    guidance:
      "This path is protected from disclosure and mutation by the active profile.",
  },
  {
    pattern: "**/.password-store/**",
    decision: "deny",
    guidance:
      "This path is protected from disclosure and mutation by the active profile.",
  },
  {
    pattern: "**/.config/sops/age/keys.txt",
    decision: "deny",
    guidance:
      "This path is protected from disclosure and mutation by the active profile.",
  },
  {
    pattern: "**/.age/**",
    decision: "deny",
    guidance:
      "This path is protected from disclosure and mutation by the active profile.",
  },
  {
    pattern: "**/*.tfvars",
    decision: "deny",
    guidance:
      "This path is protected from disclosure and mutation by the active profile.",
  },
  {
    pattern: "**/*.tfstate",
    decision: "deny",
    guidance:
      "This path is protected from disclosure and mutation by the active profile.",
  },
  {
    pattern: "**/*.tfstate.*",
    decision: "deny",
    guidance:
      "This path is protected from disclosure and mutation by the active profile.",
  },
  {
    pattern: "**/.pulumi/**",
    decision: "deny",
    guidance:
      "This path is protected from disclosure and mutation by the active profile.",
  },
  {
    pattern: "**/*.key",
    decision: "deny",
    guidance:
      "This path is protected from disclosure and mutation by the active profile.",
  },
  {
    pattern: "**/*.p12",
    decision: "deny",
    guidance:
      "This path is protected from disclosure and mutation by the active profile.",
  },
  {
    pattern: "**/*.pfx",
    decision: "deny",
    guidance:
      "This path is protected from disclosure and mutation by the active profile.",
  },
  {
    pattern: "**/*.jks",
    decision: "deny",
    guidance:
      "This path is protected from disclosure and mutation by the active profile.",
  },
  {
    pattern: "**/*.keystore",
    decision: "deny",
    guidance:
      "This path is protected from disclosure and mutation by the active profile.",
  },
  { pattern: "**/.env.template", decision: "allow" },
  { pattern: "**/.env.example", decision: "allow" },
  { pattern: "**/.env.sample", decision: "allow" },
];
