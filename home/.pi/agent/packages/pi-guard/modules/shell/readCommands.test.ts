import { describe, expect, it } from "vitest";
import { splitShellCommands } from "./parse";
import {
  parseReadCommand,
  readCommandDenialReasons,
  validateReadCommands,
} from "./readCommands";

function validate({ command }: { command: string }): string | undefined {
  return validateReadCommands({
    command,
    commandSegments: splitShellCommands(command),
  });
}

const quotedCommitCommand = [
  "git commit",
  '-m "Preserve file-level checks"',
  '-m "Ready for review"',
].join(" ");

describe("shell read commands", () => {
  it("collects concrete file operands", () => {
    expect(parseReadCommand({ command: "head -n 20 README.md" })).toEqual({
      status: "safe",
      paths: ["README.md"],
    });
    expect(
      parseReadCommand({ command: "sed -n '1,20p' src/example.ts" }),
    ).toEqual({
      status: "safe",
      paths: ["src/example.ts"],
    });
  });

  it.each(["head", "tail"])(
    "parses %s decimal shorthand without losing operands",
    (reader) => {
      for (const count of ["-0", "-1", "-100", "-00100"]) {
        expect(parseReadCommand({ command: `${reader} ${count}` })).toEqual({
          status: "stdin-only",
        });
        expect(
          parseReadCommand({ command: `${reader} ${count} first second` }),
        ).toEqual({
          status: "safe",
          paths: ["first", "second"],
        });
      }
      expect(parseReadCommand({ command: `${reader} -100 -- -200` })).toEqual({
        status: "safe",
        paths: ["-200"],
      });
      for (const count of ["-100x", "-1.5", "--100", "-100k"]) {
        expect(
          parseReadCommand({ command: `${reader} ${count}` }),
        ).toMatchObject({
          status: "unknown",
        });
      }
    },
  );

  it.each(["head", "tail"])(
    "preserves every %s filename after the first operand",
    (reader) => {
      for (const options of [
        "",
        "-100",
        "-n 2",
        "-c 2",
        "--lines 2",
        "--bytes 2",
        "-n 2 -100",
      ]) {
        for (const filenames of [
          ["ordinary", "-100"],
          ["ordinary", "-n", "2", "--", "-100"],
          ["ordinary", "--unknown", "-100x"],
          ["-", "-100", "--"],
        ]) {
          const command = `${reader} ${options} ${filenames.join(" ")}`;
          expect(parseReadCommand({ command }), command).toEqual({
            status: "safe",
            paths: filenames,
          });
        }
      }
      expect(
        parseReadCommand({ command: `${reader} -n 2 -- -100 -- -n` }),
      ).toEqual({
        status: "safe",
        paths: ["-100", "--", "-n"],
      });
      expect(parseReadCommand({ command: `${reader} -n 2 -100` })).toEqual({
        status: "stdin-only",
      });
    },
  );

  it.each(["cat", "nl", "sort", "wc", "file"])(
    "does not give %s numeric shorthand",
    (reader) => {
      expect(parseReadCommand({ command: `${reader} -100` })).toMatchObject({
        status: "unknown",
      });
    },
  );

  it("leaves quoted commit-message prose inert", () => {
    expect(validate({ command: quotedCommitCommand })).toBeUndefined();
  });

  it("normalizes path-qualified readers and supported wrappers", () => {
    for (const command of [
      "/bin/cat README.md",
      "command -p /usr/bin/head README.md",
      "env LANG=C /bin/tail README.md",
      "exec -a reader /bin/wc README.md",
      "builtin cat README.md",
    ]) {
      expect(parseReadCommand({ command }), command).toMatchObject({
        status: "safe",
        paths: ["README.md"],
      });
      expect(validate({ command }), command).toBeUndefined();
    }
  });

  it("does not mistake time or negation for a pipe", () => {
    expect(validate({ command: "time cat README.md" })).toBeUndefined();
    expect(validate({ command: "! cat README.md" })).toBeUndefined();
  });

  it("rejects readers with unsafe composition", () => {
    const prohibitedCompositions = [
      {
        command: "eval 'cat README.md'",
        reason: readCommandDenialReasons.forwarding,
      },
      {
        command: 'eval "$script"',
        reason: readCommandDenialReasons.forwarding,
      },
      {
        command: "xargs cat",
        reason: readCommandDenialReasons.forwarding,
      },
      {
        command: "xargs sh -c 'cat \"$1\"' placeholder",
        reason: readCommandDenialReasons.forwarding,
      },
      {
        command: 'xargs sh -c "$script"',
        reason: readCommandDenialReasons.forwarding,
      },
      {
        command: 'xargs "$target"',
        reason: readCommandDenialReasons.forwarding,
      },
      {
        command: "bash --norc -c 'cat README.md'",
        reason: readCommandDenialReasons.interpreter,
      },
      {
        command: 'sh -c "$script"',
        reason: readCommandDenialReasons.interpreter,
      },
      {
        command: 'command -p /bin/sh -c "$script"',
        reason: readCommandDenialReasons.interpreter,
      },
      {
        command: "bash -O extglob -c 'cat README.md'",
        reason: readCommandDenialReasons.interpreter,
      },
      {
        command: 'bash -o posix -c "$script"',
        reason: readCommandDenialReasons.interpreter,
      },
      {
        command: "bash --rcfile custom.bashrc -c 'cat README.md'",
        reason: readCommandDenialReasons.interpreter,
      },
      {
        command: "env -S 'cat README.md'",
        reason: readCommandDenialReasons.interpreter,
      },
      {
        command: "env --split-string='cat README.md'",
        reason: readCommandDenialReasons.interpreter,
      },
      {
        command: "/usr/bin/env -Scat README.md",
        reason: readCommandDenialReasons.interpreter,
      },
      {
        command: 'env -S "$splitCommand"',
        reason: readCommandDenialReasons.interpreter,
      },
      {
        command: 'for file in *; do cat "$file"; done',
        reason: readCommandDenialReasons.loop,
      },
      {
        command: "for ((i = 0; i < 1; i++)); do cat README.md; done",
        reason: readCommandDenialReasons.loop,
      },
      {
        command: 'while read -r file; do cat "$file"; done',
        reason: readCommandDenialReasons.loop,
      },
      {
        command: "until false; do cat README.md; done",
        reason: readCommandDenialReasons.loop,
      },
      {
        command: 'select file in README.md; do cat "$file"; done',
        reason: readCommandDenialReasons.loop,
      },
    ] as const;

    for (const { command, reason } of prohibitedCompositions)
      expect(validate({ command }), command).toBe(reason);
  });

  it("does not apply read-composition denials without a reader", () => {
    for (const command of [
      "eval 'printf safe'",
      "xargs",
      "sh -c 'printf safe'",
      "bash -- -c README.md",
    ])
      expect(validate({ command }), command).toBeUndefined();
  });

  it("accepts supported concrete readers", () => {
    expect(
      validate({ command: "cat README.md && tail -n 5 CHANGELOG.md" }),
    ).toBeUndefined();
  });
});
