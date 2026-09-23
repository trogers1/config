import { describe, expect, it } from "vitest";
import { defaultProtectedPathRules } from "./protectedPaths";
import {
  resolveRuntimeRequirementWritePaths,
  runtimeRequirementDefinition,
  vitestViteTemporaryWritePaths,
} from "./runtimeRequirements";

describe("runtime requirements", () => {
  it("uses the Go requirement definition for sandbox and direct-access protection", () => {
    const definition = runtimeRequirementDefinition({
      name: "go-toolchain-cache",
    });

    expect(
      resolveRuntimeRequirementWritePaths({
        requirements: ["go-toolchain-cache"],
      }),
    ).toEqual(definition.sandboxWritePaths);
    expect(
      defaultProtectedPathRules
        .filter((rule) =>
          definition.protectedPathPatterns.some(
            (pattern) => pattern === rule.pattern,
          ),
        )
        .map((rule) => rule.pattern),
    ).toEqual(definition.protectedPathPatterns);
  });

  it("resolves only the exact Vitest/Vite workspace temporary directory", () => {
    expect(
      resolveRuntimeRequirementWritePaths({
        requirements: ["vitest-vite-temp"],
      }),
    ).toEqual([...vitestViteTemporaryWritePaths]);
  });

  it("does not grant explicitly unselected requirements", () => {
    expect(resolveRuntimeRequirementWritePaths({ requirements: [] })).toEqual(
      [],
    );
  });
});
