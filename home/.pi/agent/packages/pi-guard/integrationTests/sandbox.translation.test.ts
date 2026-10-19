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
  it.each([
    { ask: "../**", extra: "..", allow: ".", waived: true },
    { ask: "../target/**", extra: "..", allow: ".", waived: true },
    { ask: "../**", extra: "../target", allow: "../..", waived: false },
    { ask: "../other/**", extra: "../target", allow: "..", waived: false },
    { ask: "../*/**", extra: "..", allow: "..", waived: false },
    { ask: "../target", extra: "../*", allow: "..", waived: false },
  ])(
    "extra-root precedence covers only proven whole ask regions: $ask / $extra",
    ({ ask, extra, allow, waived }) => {
      const cwd = path.resolve(process.cwd(), "translation/workspace");
      const result = translatePolicy(
        {
          ...policyConfig.profiles["builtin:default"].policy,
          protectedPathRules: [],
          writePaths: [
            { pattern: allow, decision: "allow" },
            { pattern: ask, decision: "ask" },
          ],
          sandbox: { network: "deny", extraWritePaths: [extra] },
        },
        "extra-root",
        cwd,
      );
      if (result.kind !== "active") {
        // Linux cannot compile glob restrictions, and must fail closed.
        expect(process.platform).toBe("linux");
        expect(ask).toContain("*");
        return;
      }
      expect(result.report.waivedRestrictions).toEqual(
        waived
          ? [expect.objectContaining({ pattern: ask, source: "profile" })]
          : [],
      );
      expect(result.spec.writeRules).toContainEqual({
        pattern: extra,
        decision: "allow",
        context: "any",
        source: "sandbox",
      });
      expect(
        result.spec.writeRules.some(
          (rule) => rule.pattern === ask && rule.decision === "deny",
        ),
      ).toBe(!waived);
      expect(result.spec.filesystem.writeDenyRoots.length > 0).toBe(!waived);
    },
  );

  it.each(["..", "../target"])(
    "extra-root precedence retains explicit ancestor denies for %s",
    (extra) => {
      const cwd = path.resolve(process.cwd(), "translation/workspace");
      const denied = path.resolve(cwd, "..");
      const result = translatePolicy(
        {
          ...policyConfig.profiles["builtin:default"].policy,
          protectedPathRules: [],
          writePaths: [
            { pattern: ".", decision: "allow" },
            { pattern: "../**", decision: "ask" },
            { pattern: denied, decision: "deny" },
          ],
          sandbox: { network: "deny", extraWritePaths: [extra] },
        },
        "extra-root",
        cwd,
      );
      expect(result.kind).toBe("active");
      if (result.kind !== "active") throw new Error(result.reason);
      expect(result.spec.filesystem.writeDenyRoots).toContain(denied);
      expect(
        result.report.untranslatedAllows.some(({ reason }) =>
          reason?.includes(denied),
        ),
      ).toBe(true);
    },
  );

  it("extra-root precedence preserves default parent asks without closing the workspace", () => {
    const cwd = process.cwd();
    const result = translatePolicy(
      policyConfig.profiles["builtin:default"].policy,
      "builtin:default",
      cwd,
    );
    expect(result.kind).toBe("active");
    if (result.kind !== "active") throw new Error(result.reason);
    expect(result.spec.filesystem.writeAllowRoots).toContain(cwd);
    expect(result.spec.filesystem.writeDenyRoots).not.toContain(
      path.dirname(cwd),
    );
  });

  it("extra-root precedence keeps worker startup writes inside transformed parent boundaries", () => {
    const cwd = process.cwd();
    const result = translatePolicy(
      policyConfig.profiles["builtin:worker"].policy,
      "builtin:worker",
      cwd,
    );
    expect(result.kind).toBe("active");
    if (result.kind !== "active") throw new Error(result.reason);
    expect(result.spec.filesystem.writeAllowRoots).toContain(cwd);
    expect(result.spec.filesystem.writeDenyRoots).not.toContain(
      path.dirname(cwd),
    );
    expect(result.spec.filesystem.writeDenyRoots).not.toContain(cwd);
  });

  it.each([
    { extra: "../sibling", broad: false },
    { extra: "..", broad: true },
  ])(
    "extra-root precedence cannot reopen transformed parent denies: $extra",
    ({ extra, broad }) => {
      const cwd = path.resolve(process.cwd(), "translation/workspace");
      const worker = policyConfig.profiles["builtin:worker"].policy;
      const granted = path.resolve(cwd, extra);
      const result = translatePolicy(
        {
          ...worker,
          sandbox: { network: "deny", extraWritePaths: [granted] },
        },
        "worker-with-extra-root",
        cwd,
      );
      expect(result.kind).toBe("active");
      if (result.kind !== "active") throw new Error(result.reason);
      expect(result.spec.filesystem.writeDenyRoots).toContain(granted);
      expect(result.report.untranslatedAllows).toContainEqual(
        expect.objectContaining({ pattern: granted }),
      );
      expect(
        result.spec.filesystem.writeDenyRoots.includes(path.dirname(cwd)),
      ).toBe(broad);
    },
  );

  it("fails closed instead of claiming Linux sandbox support", () => {
    const platform = vi
      .spyOn(process, "platform", "get")
      .mockReturnValue("linux");
    try {
      const result = translatePolicy(
        {
          ...policyConfig.profiles["builtin:default"].policy,
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
        ...policyConfig.profiles["builtin:default"].policy,
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
        ...policyConfig.profiles["builtin:default"].policy,
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

  it("enables macOS trustd access when networking is allowed", () => {
    const result = translatePolicy(
      {
        ...policyConfig.profiles["builtin:default"].policy,
        protectedPathRules: [],
        sandbox: {
          network: "allow",
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

  it("keeps trustd unavailable with denied networking", () => {
    const result = translatePolicy(
      {
        ...policyConfig.profiles["builtin:default"].policy,
        protectedPathRules: [],
        sandbox: { network: "deny" },
      },
      "sandboxed",
      process.cwd(),
    );

    expect(result.kind).toBe("active");
    if (result.kind !== "active") return;
    expect(result.spec.enableWeakerNetworkIsolation).toBe(false);
    expect(result.spec.allowLocalBinding).toBe(false);
    expect(result.spec.allowAppleEvents).toBe(false);
  });

  it("enables local binding for the built-in default profile", () => {
    const result = translatePolicy(
      policyConfig.profiles["builtin:default"].policy,
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
          ...policyConfig.profiles["builtin:default"].policy,
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
