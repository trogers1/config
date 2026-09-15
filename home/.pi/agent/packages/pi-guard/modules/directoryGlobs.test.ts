import { describe, expect, it } from "vitest";
import {
  directoryGlobSchema,
  matchDirectoryGlobs,
  validateDirectoryGlob,
  validateDirectoryGlobs,
  type DirectoryGlobDeclaration,
} from "./directoryGlobs";
import { extendProfile, type ProfilePolicyFragment } from "./policyHelpers";
import { Value } from "typebox/value";

describe("directory glob declarations", () => {
  it("strips declaration-only metadata while composing runtime policy", () => {
    const base: ProfilePolicyFragment = {
      tools: {},
      readPaths: [],
      writePaths: [],
      directoryGlobs: ["/base/declaration"],
    };
    const resolved = extendProfile(base, {
      directoryGlobs: ["/work/app"],
      tools: {},
    });
    expect(resolved).not.toHaveProperty("directoryGlobs");
  });

  it("enforces collection bounds, uniqueness, and collection-shaped success", () => {
    expect(validateDirectoryGlobs([])).toMatchObject({
      valid: false,
      code: "empty-collection",
    });
    expect(
      validateDirectoryGlobs(
        Array.from({ length: 129 }, (_, index) => `/work/${index}`),
      ),
    ).toMatchObject({ valid: false, code: "too-many-globs" });
    expect(
      validateDirectoryGlobs(
        Array.from({ length: 128 }, (_, index) => `/work/${index}`),
      ),
    ).toMatchObject({ valid: true });
    expect(validateDirectoryGlobs(["/work/*", "/work/*"])).toMatchObject({
      valid: false,
      code: "duplicate",
    });
    const result = validateDirectoryGlobs(["/work/*"]);
    expect(result).toEqual({ valid: true, value: ["/work/*"] });
  });

  it("keeps the schema aligned with canonical grammar boundaries", () => {
    for (const value of [
      "/tmp//app",
      "/tmp/app/",
      "/tmp/../app",
      "/tmp/[ab]",
      "/tmp/***",
      "~/",
    ]) {
      expect(Value.Check(directoryGlobSchema, value)).toBe(false);
    }
  });

  it.each([
    ["relative", "projects/app"],
    ["user home prefix", "~other/app"],
    ["backslash", "/tmp\\app"],
    ["repeated separator", "/tmp//app"],
    ["trailing separator", "/tmp/app/"],
    ["dot segment", "/tmp/./app"],
    ["unsupported syntax", "/tmp/[ab]"],
    ["triple star", "/tmp/***"],
  ])("rejects %s", (_name, value) => {
    expect(validateDirectoryGlob(value).valid).toBe(false);
  });

  it.each([
    "/",
    "~",
    "/tmp",
    "/tmp/project",
    "~/Code/*",
    "/tmp/**/frontend",
    "/tmp/a?",
  ])("accepts canonical %s", (value) =>
    expect(validateDirectoryGlob(value)).toMatchObject({ valid: true }),
  );

  it("matches the root and lexical descendants, but not a near prefix", () => {
    const declarations: DirectoryGlobDeclaration[] = [
      ["project", ["/work/app"]],
    ];
    expect(matchDirectoryGlobs("/work/app", declarations)?.profile).toBe(
      "project",
    );
    expect(
      matchDirectoryGlobs("/work/app/src/../src", declarations),
    ).toBeUndefined();
    expect(
      matchDirectoryGlobs("/work/application", declarations),
    ).toBeUndefined();
  });

  it("supports *, **, ?, and home expansion without filesystem access", () => {
    const declarations: DirectoryGlobDeclaration[] = [
      ["star", ["/work/app/*"]],
      ["deep", ["/work/**/frontend"]],
      ["question", ["/work/app/v?"]],
      ["home", ["~/Code/client"]],
      ["home-root", ["~"]],
    ];
    expect(
      matchDirectoryGlobs("/work/app/one", declarations, {
        home: "/Users/test",
      })?.profile,
    ).toBe("star");
    expect(
      matchDirectoryGlobs("/work/a/b/frontend/src", declarations)?.profile,
    ).toBe("deep");
    expect(matchDirectoryGlobs("/work/frontend", declarations)?.profile).toBe(
      "deep",
    );
    expect(
      matchDirectoryGlobs("/work/a/b/c/frontend", declarations)?.profile,
    ).toBe("deep");
    expect(matchDirectoryGlobs("/work/app/v2", declarations)?.profile).toBe(
      "question",
    );
    // `/work/app/*` selects a one-segment project root, then that root's
    // descendants remain in scope.
    expect(matchDirectoryGlobs("/work/app/v/a", declarations)?.profile).toBe(
      "star",
    );
    expect(
      matchDirectoryGlobs("/Users/test/Code/client/src", declarations, {
        home: "/Users/test",
      })?.profile,
    ).toBe("home");
    expect(
      matchDirectoryGlobs("/Users/test/Documents", declarations, {
        home: "/Users/test",
      })?.profile,
    ).toBe("home-root");
  });

  it("rejects non-canonical CWDs and homes without resolving paths", () => {
    expect(
      matchDirectoryGlobs("work/app", [["relative", ["/work/**"]]]),
    ).toBeUndefined();
    expect(
      matchDirectoryGlobs("/Users/test/Code/app", [["home", ["~/Code/app"]]], {
        home: "/Users/test/",
      }),
    ).toBeUndefined();
    expect(
      matchDirectoryGlobs("/work/app", [["bad-home", ["~/app"]]], {
        home: "relative",
      }),
    ).toBeUndefined();
  });

  it("ranks expanded literal prefix before matched ancestor depth", () => {
    expect(
      matchDirectoryGlobs("/work/client/src", [
        ["broad", ["/work/**"]],
        ["exact", ["/work/client"]],
      ])?.profile,
    ).toBe("exact");
  });

  it("treats expanded home and absolute patterns as equally specific", () => {
    const match = matchDirectoryGlobs(
      "/Users/test/Code/app/src",
      [
        ["absolute", ["/Users/test/Code/app"]],
        ["home", ["~/Code/app"]],
      ],
      { home: "/Users/test" },
    );
    expect(match?.profile).toBe("home");
    expect(match?.literalPrefixCharacters).toBe("/Users/test/Code/app".length);
  });

  it("ranks literal prefix, then matched root depth, then declaration order", () => {
    const declarations: DirectoryGlobDeclaration[] = [
      ["broad", ["/work/*"]],
      ["prefix", ["/work/client-*"]],
      ["deep", ["/work/client-app"]],
      ["latest", ["/work/client-app"]],
    ];
    const match = matchDirectoryGlobs("/work/client-app/src", declarations);
    expect(match?.profile).toBe("latest");
    expect(match?.declarationIndex).toBe(3);
  });

  it("matches the root declaration and uses lexical ancestor roots", () => {
    expect(
      matchDirectoryGlobs("/any/project", [["root", ["/"]]])?.profile,
    ).toBe("root");
    expect(
      matchDirectoryGlobs("/work/app/src", [["project", ["/work/app"]]])?.glob,
    ).toBe("/work/app");
  });

  it("skips malformed declarations and bounds oversized matcher input", () => {
    const declarations: DirectoryGlobDeclaration[] = [
      ["bad", ["relative"]],
      ["good", ["/work/app"]],
    ];
    expect(matchDirectoryGlobs("/work/app", declarations)?.profile).toBe(
      "good",
    );
    expect(
      matchDirectoryGlobs(`/work/${"x".repeat(5000)}`, [
        ["huge", ["/work/**"]],
      ]),
    ).toBeUndefined();
  });
});
