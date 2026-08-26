import { describe, expect, it } from "vitest";
import { classifyShell } from "./classify";

describe("unbash shell classification", () => {
  it("separates Git repository objects from filesystem options", () => {
    const result = classifyShell(
      "git -C ../repo show HEAD~3:src/example.ts ./working-tree-file.ts",
    );

    expect(result.errors).toEqual([]);
    expect(result.tokens).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "filesystem-reference",
          value: "../repo",
          command: "git",
        }),
        expect.objectContaining({
          kind: "repository-object",
          value: "HEAD~3:src/example.ts",
          command: "git",
        }),
        expect.objectContaining({
          kind: "ambiguous",
          value: "./working-tree-file.ts",
          command: "git",
        }),
      ]),
    );
  });

  it.each([
    ["git config --get user.name", ["user.name"]],
    ["git config --get user.email", ["user.email"]],
    ["git config --get user.name Taylor", ["user.name", "Taylor"]],
    ["git config --get-regexp '^user\\.'", ["^user\\."]],
  ])(
    "classifies safe Git config operands semantically: %s",
    (gitCmd, expectedArguments) => {
      const config = classifyShell(gitCmd);
      expect(config.errors).toEqual([]);
      for (const value of expectedArguments) {
        expect(config.tokens, value).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: "proven-non-path", value }),
          ]),
        );
      }
    },
  );

  it.each([
    ["git merge-tree HEAD HEAD HEAD", ["HEAD"]],
    ["git merge-tree --trivial-merge HEAD~1 HEAD HEAD", ["HEAD~1", "HEAD"]],
    ["git diff-tree HEAD", ["HEAD"]],
    ["git diff-tree HEAD~2", ["HEAD~2"]],
    ["git diff-tree refs/heads/main", ["refs/heads/main"]],
  ])(
    "classifies safe Git tree-inspection operands semantically: %s",
    (gitCmd, expectedObjects) => {
      const result = classifyShell(gitCmd);
      expect(result.errors).toEqual([]);
      for (const value of expectedObjects) {
        expect(result.tokens, value).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: "repository-object", value }),
          ]),
        );
        expect(
          result.tokens.some(
            (token) => token.value === value && token.kind === "ambiguous",
          ),
          value,
        ).toBe(false);
      }
    },
  );

  it.each([
    "git config --file ../config --get user.name",
    "git config --file=../config --get user.name",
  ])("keeps Git config files gated: %s", (gitCmd) => {
    const config = classifyShell(gitCmd);
    expect(config.tokens).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "filesystem-reference",
          value: "../config",
        }),
        expect.objectContaining({
          kind: "proven-non-path",
          value: "user.name",
        }),
      ]),
    );
  });

  it.each([
    "git merge-tree HEAD HEAD",
    "git merge-tree --write-tree HEAD HEAD",
  ])("keeps write-capable merge-tree forms gated: %s", (gitCmd) => {
    const mergeTree = classifyShell(gitCmd);
    expect(mergeTree.tokens).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "ambiguous", value: "HEAD" }),
      ]),
    );
  });

  it("keeps diff-tree paths after -- gated as filesystem references", () => {
    const result = classifyShell("git diff-tree HEAD -- src/example.ts");
    expect(result.tokens).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "repository-object", value: "HEAD" }),
        expect.objectContaining({
          kind: "filesystem-reference",
          value: "src/example.ts",
        }),
      ]),
    );
  });

  it("distinguishes ripgrep patterns, paths, and redirections", () => {
    const result = classifyShell(
      "rg --glob 'src/**' needle ./source 2>/tmp/errors > /tmp/results",
    );

    expect(result.errors).toEqual([]);
    expect(result.tokens).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "pattern", value: "src/**" }),
        expect.objectContaining({ kind: "ambiguous", value: "./source" }),
        expect.objectContaining({
          kind: "redirection-target",
          value: "/tmp/errors",
        }),
        expect.objectContaining({
          kind: "redirection-target",
          value: "/tmp/results",
        }),
      ]),
    );
  });

  it("finds commands nested in command and process substitutions", () => {
    const result = classifyShell(
      "printf '%s' \"$(cat ../command-input)\" <(diff ./left ../right)",
    );

    expect(result.errors).toEqual([]);
    expect(result.tokens).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "filesystem-reference",
          value: "../command-input",
          command: "cat",
        }),
        expect.objectContaining({
          kind: "ambiguous",
          value: "./left",
          command: "diff",
        }),
        expect.objectContaining({
          kind: "ambiguous",
          value: "../right",
          command: "diff",
        }),
      ]),
    );
  });

  it("marks unresolved expansions as dynamic", () => {
    const result = classifyShell('cat "$TARGET" "${ROOT}/file" > "$OUTPUT"');

    expect(result.tokens).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "dynamic", value: '"$TARGET"' }),
        expect.objectContaining({
          kind: "dynamic",
          value: '"${ROOT}/file"',
          dynamicRole: "filesystem-reference",
        }),
        expect.objectContaining({
          kind: "dynamic",
          value: "$OUTPUT",
          dynamicRole: "redirection-target",
        }),
      ]),
    );
  });

  it("classifies Git no-index operands as filesystem references", () => {
    const result = classifyShell(
      'git diff --no-index ./allowed ../blocked:name "$LEFT"',
    );

    expect(result.tokens).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "filesystem-reference",
          value: "./allowed",
        }),
        expect.objectContaining({
          kind: "filesystem-reference",
          value: "../blocked:name",
        }),
        expect.objectContaining({
          kind: "dynamic",
          dynamicRole: "filesystem-reference",
          value: '"$LEFT"',
        }),
      ]),
    );
  });

  it("classifies find output paths without treating fprintf formats as paths", () => {
    const result = classifyShell("find modules -fprintf ../blocked '%p\\n'");

    expect(result.tokens).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "filesystem-reference",
          value: "../blocked",
        }),
        expect.objectContaining({
          kind: "proven-non-path",
          value: "%p\\n",
        }),
      ]),
    );
  });

  it("classifies input files but not here-string content", () => {
    const result = classifyShell(
      "cat < ./input <<< '/not/a/filesystem/operand'",
    );

    expect(result.errors).toEqual([]);
    expect(result.tokens).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "redirection-target",
          value: "./input",
        }),
      ]),
    );
    expect(result.tokens).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: "/not/a/filesystem/operand" }),
      ]),
    );
  });

  it("does not classify here-document content or descriptor duplication as files", () => {
    const result = classifyShell("cat <<'EOF' 2>&1\n/path/in/content\nEOF");

    expect(result.errors).toEqual([]);
    expect(result.tokens).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "redirection-target" }),
      ]),
    );
  });

  it("treats flag clusters as flags but keeps path-shaped option values ambiguous", () => {
    const result = classifyShell(
      "ls -la --format=%H -I/usr/include --output=~/x --output=.env ./src",
    );

    expect(result.errors).toEqual([]);
    expect(result.tokens).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "proven-non-path", value: "-la" }),
        expect.objectContaining({
          kind: "proven-non-path",
          value: "--format=%H",
        }),
        expect.objectContaining({ kind: "ambiguous", value: "-I/usr/include" }),
        expect.objectContaining({ kind: "ambiguous", value: "--output=~/x" }),
        expect.objectContaining({ kind: "ambiguous", value: "--output=.env" }),
        expect.objectContaining({ kind: "ambiguous", value: "./src" }),
      ]),
    );
  });

  it("proves package manager script names are not filesystem operands", () => {
    for (const command of [
      "npm run check:types",
      "npm run-script build",
      "pnpm run test:watch",
      "npm test",
    ]) {
      const result = classifyShell(command);

      expect(result.errors).toEqual([]);
      expect(
        result.tokens.every((token) => token.kind === "proven-non-path"),
        command,
      ).toBe(true);
    }
  });

  it("keeps package manager install specifiers gated as possible paths", () => {
    const result = classifyShell("npm install ../local-dependency");

    expect(result.tokens).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "proven-non-path", value: "install" }),
        expect.objectContaining({
          kind: "ambiguous",
          value: "../local-dependency",
        }),
      ]),
    );
  });

  it("classifies package manager directory options as filesystem references", () => {
    const cases: Array<[command: string, scriptWord: string]> = [
      ["npm --prefix ../pkg test", "test"],
      ["npm --prefix=../pkg test", "test"],
      ["pnpm --dir ../pkg run build", "build"],
      ["pnpm -C ../pkg test", "test"],
      ["yarn --cwd ../pkg test", "test"],
    ];
    for (const [command, scriptWord] of cases) {
      const result = classifyShell(command);

      expect(result.errors).toEqual([]);
      expect(result.tokens, command).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "filesystem-reference",
            value: "../pkg",
          }),
        ]),
      );
      expect(
        result.tokens.find((token) => token.value === scriptWord)?.kind,
        command,
      ).toBe("proven-non-path");
    }
  });

  it("keeps script arguments after package manager shortcuts gated as possible paths", () => {
    // `npm test -- <path>` forwards the argument to the test script; unlike a
    // run/run-script script name, it may be a filesystem operand.
    const result = classifyShell("npm test -- tests/example.test.ts");

    expect(result.tokens).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "proven-non-path", value: "test" }),
        expect.objectContaining({
          kind: "ambiguous",
          value: "tests/example.test.ts",
        }),
      ]),
    );
  });

  const policySubcommandCases: ReadonlyArray<[string, string[]]> = [
    ["cargo build --release", ["build"]],
    ["cargo test", ["test"]],
    ["cargo check", ["check"]],
    ["cargo clippy", ["clippy"]],
    ["go build", ["build"]],
    ["go test", ["test"]],
  ];

  it.each(policySubcommandCases)(
    "derives literal subcommands from the active command policy: %s",
    (command, subcommands) => {
      const result = classifyShell(command, { subcommands });

      expect(result.errors).toEqual([]);
      for (const value of subcommands) {
        expect(result.tokens, value).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: "proven-non-path", value }),
          ]),
        );
      }
    },
  );

  it("leaves operands after a policy-derived subcommand conservatively ambiguous", () => {
    const result = classifyShell("cargo test --package demo", {
      subcommands: ["test"],
    });

    expect(result.tokens).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "proven-non-path", value: "test" }),
        expect.objectContaining({ kind: "ambiguous", value: "demo" }),
      ]),
    );
  });

  it("reports malformed shell rather than relying on a recovered AST", () => {
    const result = classifyShell("cat 'unterminated");

    expect(result.errors.length).toBeGreaterThan(0);
  });
});
