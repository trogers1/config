# Recognize Vitest test-name patterns as non-path arguments

## Problem

Scoped subagents can run a focused Vitest command only when the test-name filter
is short enough to avoid the generic Bash path classifier. A command such as:

```sh
vitest run src/example.test.ts --testNamePattern 'a long literal test title'
```

incorrectly treats the option value as a possible filesystem operand. The path
policy then rejects it when it is outside `PI_SUBAGENT_PERMISSIBLE_GLOBS`.
This is a command-grammar classification bug, not a sandbox/write-root issue.

## Plan

1. Add a small Vitest-specific adapter in `modules/shell/classify.ts`, invoked
   for the `vitest` executable (and only the recognized executable form).
2. Mark test-name filter values as `pattern`/non-path tokens for all supported
   forms:
   - `-t <pattern>`;
   - `--testNamePattern <pattern>`;
   - `--testNamePattern=<pattern>`.
3. Leave all other operands unchanged and conservatively path-checked. In
   particular, test-file arguments and explicit output/cache/path options must
   remain filesystem references or ambiguous operands as appropriate.
4. Add focused unit coverage in `modules/shell/classify.test.ts` for long,
   quoted title patterns and each supported option spelling; assert that an
   ordinary test-file argument is still gated.
5. Add an integration-level scoped-subagent/path-policy regression test proving
   a long `--testNamePattern` value is not denied while an out-of-scope test-file
   path remains denied.

## Acceptance criteria

- A scoped worker can execute focused Vitest commands with long literal or
  regex test-name filters.
- The change does not grant write access, relax sandbox roots, or weaken path
  enforcement for real filesystem operands.
- Type, lint, static checks, and the pi-guard test suite pass.
