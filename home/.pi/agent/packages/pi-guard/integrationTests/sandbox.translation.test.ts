import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { policyConfig } from "../modules/policy";
import {
  translatePolicy,
  type CoverageItem,
  type CoverageReport,
  type SandboxFilesystemSpec,
  type SandboxPathRule,
  type SandboxRuleSource,
  type SandboxSpec,
} from "../modules/sandbox.lib";

describe("sandbox policy translation", () => {
  it("fails closed instead of claiming Linux sandbox support", () => {
    const platform = vi
      .spyOn(process, "platform", "get")
      .mockReturnValue("linux");
    try {
      const result = translatePolicy(
        {
          ...policyConfig.profiles["builtin:default"],
          protectedPathRules: [{ pattern: "**/.git/**", decision: "deny" }],
          sandbox: { network: "deny" },
        },
        "sandboxed",
        process.cwd(),
      );

      expect(result).toMatchObject({ kind: "unavailable" });
    } finally {
      platform.mockRestore();
    }
  });

  it("fails closed when a protected deny is nested inside an allow exception", () => {
    const result = translatePolicy(
      {
        ...policyConfig.profiles["builtin:default"],
        protectedPathRules: [
          { pattern: "**/.env*", decision: "deny" },
          { pattern: "**/.env.template", decision: "allow" },
          { pattern: "private/.env.template", decision: "deny" },
        ],
        sandbox: { network: "deny" },
      },
      "sandboxed",
      process.cwd(),
    );

    expect(result).toMatchObject({ kind: "unavailable" });
  });

  it("preserves whitespace in literal sandbox paths", () => {
    const result = translatePolicy(
      {
        ...policyConfig.profiles["builtin:default"],
        protectedPathRules: [],
        sandbox: { network: "deny", extraDenyReadPaths: [" secret "] },
      },
      "sandboxed",
      process.cwd(),
    );

    expect(result).toMatchObject({
      kind: "active",
      spec: {
        filesystem: {
          readDenyRoots: [path.resolve(process.cwd(), " secret ")],
        },
      },
    });
  });

  it("carries sandbox network opt-ins into the sandbox specification", () => {
    const result = translatePolicy(
      {
        ...policyConfig.profiles["builtin:default"],
        protectedPathRules: [],
        sandbox: {
          network: "deny",
          enableWeakerNetworkIsolation: true,
          allowLocalBinding: true,
          allowAppleEvents: true,
        },
      },
      "sandboxed",
      process.cwd(),
    );

    expect(result.kind).toBe("active");
    if (result.kind !== "active") return;
    expect(result.spec.enableWeakerNetworkIsolation).toBe(true);
    expect(result.spec.allowLocalBinding).toBe(true);
    expect(result.spec.allowAppleEvents).toBe(true);
  });

  it("defaults local binding and Apple Events to denied", () => {
    const result = translatePolicy(
      {
        ...policyConfig.profiles["builtin:default"],
        protectedPathRules: [],
        sandbox: { network: "deny" },
      },
      "sandboxed",
      process.cwd(),
    );

    expect(result.kind).toBe("active");
    if (result.kind !== "active") return;
    expect(result.spec.allowLocalBinding).toBe(false);
    expect(result.spec.allowAppleEvents).toBe(false);
  });

  it("enables local binding for the built-in default profile", () => {
    const result = translatePolicy(
      policyConfig.profiles["builtin:default"],
      "builtin:default",
      process.cwd(),
    );

    expect(result.kind).toBe("active");
    if (result.kind !== "active") return;
    expect(result.spec.allowLocalBinding).toBe(true);
  });

  it.skipIf(process.platform !== "darwin")(
    "preserves protected-rule provenance while narrowing writable subagent roots",
    () => {
      const result = translatePolicy(
        {
          ...policyConfig.profiles["builtin:default"],
          protectedPathRules: [{ pattern: "**/.git/**", decision: "deny" }],
          writePaths: [{ pattern: "allowed/**", decision: "allow" }],
          sandbox: { network: "deny" },
        },
        "sandboxed",
        process.cwd(),
        [{ pattern: "allowed/scoped/**", decision: "allow" }],
      );

      expect(result.kind).toBe("active");
      if (result.kind !== "active") return;
      const spec: SandboxSpec = result.spec;
      const filesystem: SandboxFilesystemSpec = spec.filesystem;
      const rule: SandboxPathRule = spec.readRules[0];
      const source: SandboxRuleSource = rule.source;
      const report: CoverageReport = result.report;
      const coverage: CoverageItem = {
        pattern: rule.pattern,
        source,
      };

      expect(filesystem.writeAllowRoots).toEqual([
        path.resolve(process.cwd(), "allowed/scoped"),
      ]);
      expect(coverage).toEqual({
        pattern: "**/.git/**",
        source: "protected",
      });
      expect(report.uncoveredRestrictions).toEqual([]);
    },
  );
});
