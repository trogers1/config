import { describe, expect, it } from "vitest";
import {
  injectGrepEnvExclusion,
  injectRipgrepEnvExclusions,
  validateRipgrepGlobOverrides,
} from "./searchPolicy";

describe("shell search policy", () => {
  it("injects env exclusions into ripgrep commands", () => {
    expect(injectRipgrepEnvExclusions("rg DATABASE_URL .")).toBe(
      "rg --glob '!**/.env*' --glob '**/.env.template' DATABASE_URL .",
    );
  });

  it("rejects ripgrep globs that can match protected files", () => {
    expect(
      validateRipgrepGlobOverrides("rg --glob '**/*' DATABASE_URL ."),
    ).toContain("protected .env exclusion");
    expect(
      validateRipgrepGlobOverrides("rg --glob '**/*.ts' DATABASE_URL ."),
    ).toBeUndefined();
  });

  it("adds an exclusion for built-in grep without a caller glob", () => {
    const input: { path: string; glob?: string } = { path: "." };

    expect(injectGrepEnvExclusion(input)).toBeUndefined();
    expect(input.glob).toBe("!**/.env*");
  });
});
