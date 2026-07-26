import { describe, expect, it } from "vitest";
import {
  injectGrepProtectedPathGlob,
  injectRipgrepProtectedPathGlobs,
  validateRipgrepGlobOverrides,
} from "./searchPolicy";

const patterns = ["**/.env*", "**/.git/**"];
const exceptions = ["**/.env.template"];

describe("shell search policy", () => {
  it("injects only profile-derived exclusions into ripgrep", () => {
    // Exceptions must not be injected as positive globs: ripgrep treats the
    // presence of any positive --glob as a whitelist for implicit searches,
    // which would hide every non-exception file from `rg pattern` searches.
    // Exception files remain reachable because ripgrep searches explicitly
    // named paths regardless of globs.
    expect(injectRipgrepProtectedPathGlobs("rg DATABASE_URL .", patterns)).toBe(
      "rg --glob '!**/.env*' --glob '!**/.git/**' DATABASE_URL .",
    );
  });

  it("rejects short -g globs that can match configured protected paths", () => {
    // rg applies globs last-match-wins, so any caller glob form that reaches
    // the command line could re-include files excluded by the injected
    // negations. The validator must cover -g as well as --glob.
    for (const command of [
      "rg -g '**/*' DATABASE_URL .",
      "rg -g '**/.env*' DATABASE_URL .",
      "rg -g**/* DATABASE_URL .",
      "rg -ig '**/*' DATABASE_URL .",
    ]) {
      expect(
        validateRipgrepGlobOverrides(command, patterns, exceptions),
        command,
      ).toContain("protected by the active profile");
    }
    expect(
      validateRipgrepGlobOverrides(
        "rg -g '**/*.ts' DATABASE_URL .",
        patterns,
        exceptions,
      ),
    ).toBeUndefined();
  });

  it("permits caller globs that exactly name a configured exception", () => {
    expect(
      validateRipgrepGlobOverrides(
        "rg --glob '**/.env.template' DATABASE_URL .",
        patterns,
        exceptions,
      ),
    ).toBeUndefined();
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
