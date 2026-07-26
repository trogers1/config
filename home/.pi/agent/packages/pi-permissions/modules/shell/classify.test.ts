import { describe, expect, it } from "vitest";
import { classifyShell } from "./classify";

describe("unbash shell classification spike", () => {
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

  it("reports malformed shell rather than relying on a recovered AST", () => {
    const result = classifyShell("cat 'unterminated");

    expect(result.errors.length).toBeGreaterThan(0);
  });
});
