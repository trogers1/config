import { describe, expect, it } from "vitest";
import {
  injectGrepProtectedPathGlob,
  injectRipgrepProtectedPathGlobs,
  validateRipgrepGlobOverrides,
} from "./searchPolicy";

const patterns = ["**/.env*", "**/.git/**"];
const exceptions = ["**/.env.template"];

describe("shell search policy", () => {
  it("injects profile-derived exclusions and exceptions into ripgrep", () => {
    expect(
      injectRipgrepProtectedPathGlobs(
        "rg DATABASE_URL .",
        patterns,
        exceptions,
      ),
    ).toBe(
      "rg --glob '!**/.env*' --glob '!**/.git/**' --glob '**/.env.template' DATABASE_URL .",
    );
  });

  it("derives search globs from non-env profile patterns", () => {
    expect(
      injectRipgrepProtectedPathGlobs("rg TOKEN .", [
        "**/.db",
        "**/credentials.json",
      ]),
    ).toBe("rg --glob '!**/.db' --glob '!**/credentials.json' TOKEN .");
    const input: { path: string; glob?: string } = { path: "." };
    injectGrepProtectedPathGlob(input, ["**/.db", "**/credentials.json"]);
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

  it("rejects ripgrep globs that can match configured protected paths", () => {
    expect(
      validateRipgrepGlobOverrides(
        "rg --glob '**/*' DATABASE_URL .",
        patterns,
        exceptions,
      ),
    ).toContain("protected by the active profile");
    expect(
      validateRipgrepGlobOverrides(
        "rg --glob '**/*.ts' DATABASE_URL .",
        patterns,
        exceptions,
      ),
    ).toBeUndefined();
  });

  it("builds the built-in grep exclusion from every configured pattern", () => {
    const input: { path: string; glob?: string } = { path: "." };

    expect(
      injectGrepProtectedPathGlob(input, patterns, exceptions),
    ).toBeUndefined();
    expect(input.glob).toBe("!{**/.env*,**/.git/**}");
  });

  it("permits direct searches of configured exceptions", () => {
    const input: { path: string; glob?: string } = {
      path: "nested/.env.template",
    };
    expect(
      injectGrepProtectedPathGlob(input, patterns, exceptions),
    ).toBeUndefined();
    expect(input.glob).toBeUndefined();
  });
});
