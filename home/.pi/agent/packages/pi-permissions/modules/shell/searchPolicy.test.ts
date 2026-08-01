import { describe, expect, it } from "vitest";
import {
  injectGrepProtectedPathGlob,
  injectRipgrepProtectedPathGlobs,
} from "./searchPolicy";

const rules = [
  { pattern: "**/.env*", decision: "deny" as const },
  { pattern: "**/.git/**", decision: "deny" as const },
  { pattern: "**/.env.template", decision: "allow" as const },
];

const allowOnlyRules = [
  { pattern: "**/.env.template", decision: "allow" as const },
];

const allowedDirectoryWithDeniedDescendantRules = [
  { pattern: "safe/**", decision: "allow" as const },
  { pattern: "safe/.env.secret", decision: "deny" as const },
];

describe("shell search policy", () => {
  it("appends protected ripgrep globs after caller overrides", () => {
    // Exceptions must not be injected as positive globs: ripgrep treats the
    // presence of any positive --glob as a whitelist for implicit searches,
    // which would hide every non-exception file from `rg pattern` searches.
    // Exception files remain reachable because ripgrep searches explicitly
    // named paths regardless of globs.
    expect(
      injectRipgrepProtectedPathGlobs(
        "rg --glob '**/*.ts' DATABASE_URL .",
        rules,
      ),
    ).toBe(
      "rg --glob '**/*.ts' DATABASE_URL . --glob '!**/.env*' --glob '!**/.git/**'",
    );
  });

  it("mutates the common TypeScript glob search safely", () => {
    expect(
      injectRipgrepProtectedPathGlobs("rg --glob '**/*.ts' PATTERN .", rules),
    ).toBe(
      "rg --glob '**/*.ts' PATTERN . --glob '!**/.env*' --glob '!**/.git/**'",
    );
  });

  it("derives search globs from non-env profile patterns", () => {
    expect(
      injectRipgrepProtectedPathGlobs("rg TOKEN .", [
        { pattern: "**/.db", decision: "deny" },
        { pattern: "**/credentials.json", decision: "deny" },
      ]),
    ).toBe("rg TOKEN . --glob '!**/.db' --glob '!**/credentials.json'");
    const input: { path: string; glob?: string } = { path: "." };
    injectGrepProtectedPathGlob(input, [
      { pattern: "**/.db", decision: "deny" },
      { pattern: "**/credentials.json", decision: "deny" },
    ]);
    expect(input.glob).toBe("!{**/.db,**/credentials.json}");
  });

  it("does not inject globs when the profile has no protected paths", () => {
    expect(injectRipgrepProtectedPathGlobs("rg TOKEN .", [])).toBe(
      "rg TOKEN .",
    );
    const input: { path: string; glob?: string } = { path: "." };
    expect(injectGrepProtectedPathGlob(input, [])).toBeUndefined();
    expect(input.glob).toBeUndefined();
  });

  it("does not inject search globs for allow-only protected rules", () => {
    expect(injectRipgrepProtectedPathGlobs("rg TOKEN .", allowOnlyRules)).toBe(
      "rg TOKEN .",
    );
    const input: { path: string; glob?: string } = { path: "." };
    expect(injectGrepProtectedPathGlob(input, allowOnlyRules)).toBeUndefined();
    expect(input.glob).toBeUndefined();
  });

  it("still injects deny globs for an allowed directory with a denied descendant", () => {
    const input: { path: string; glob?: string } = { path: "safe" };
    expect(
      injectGrepProtectedPathGlob(
        input,
        allowedDirectoryWithDeniedDescendantRules,
      ),
    ).toBeUndefined();
    expect(input.glob).toBe("!safe/.env.secret");
  });

  it("builds the built-in grep exclusion from every configured pattern", () => {
    const input: { path: string; glob?: string } = { path: "." };

    expect(injectGrepProtectedPathGlob(input, rules)).toBeUndefined();
    expect(input.glob).toBe("!{**/.env*,**/.git/**}");
  });

  it("explains the built-in grep single-glob limit when denying unsafe globs", () => {
    const input: { path: string; glob?: string } = {
      path: ".",
      glob: "**/*",
    };

    expect(injectGrepProtectedPathGlob(input, rules)).toContain(
      "Pi's built-in grep forwards only one --glob to ripgrep",
    );
    expect(injectGrepProtectedPathGlob(input, rules)).toContain(
      "rg --glob '**/*.ts' 'PATTERN' .",
    );
    expect(input.glob).toBe("**/*");
  });

  it("still injects deny globs for direct searches of configured exceptions", () => {
    const input: { path: string; glob?: string } = {
      path: "nested/.env.template",
    };
    expect(injectGrepProtectedPathGlob(input, rules)).toBeUndefined();
    expect(input.glob).toBe("!{**/.env*,**/.git/**}");
  });
});
