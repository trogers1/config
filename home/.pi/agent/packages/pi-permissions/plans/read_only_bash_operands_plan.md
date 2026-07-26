# Read-only Bash operand gating (deferred Tier 3 proposal)

## Status

Proposed, not started. Written after the tests-only ergonomics work (context-split
denial guidance, `/tmp` re-allowance, `cd` gating via `readPaths`, package
manager operand classification, ripgrep exception-glob fix). Adopting this
plan supersedes one line of the characterization posture in
`refactor_remediation_plan.md` Phase 8: "Read-only Bash operands use
restrictive `writePaths`, while dedicated read tools use `readPaths`."

## Problem

Every Bash filesystem operand is gated against `writePaths` with the `bash`
context. This is deliberate (README: "Bash is deliberately treated as
write-capable even for apparently read-only commands") and conservative, but
for profiles with restrictive `writePaths` it makes Bash discovery unusable:

| Command under `tests-only` / `read-only` | Result today                         | Desired                       |
| ---------------------------------------- | ------------------------------------ | ----------------------------- |
| `ls src` / `find modules -name '*.ts'`   | denied (writePaths `**` deny)        | allowed (readPaths `*` allow) |
| `cat src/example.ts`                     | denied, guidance routes to read tool | allowed                       |
| `rg --files src`                         | denied                               | allowed                       |
| `git diff src/a.ts`                      | denied                               | allowed                       |
| `echo x > src/a.ts`                      | denied                               | denied (redirection = write)  |
| `sed -i s/a/b/ src/a.ts`                 | denied                               | denied (write-capable flag)   |
| `cp src/a.ts /tmp`                       | denied                               | denied (unproven command)     |

The dedicated `read`/`grep`/`find`/`ls` tools already provide the desired
access, and the tests-only prompt + denial guidance now route agents to them.
This plan is only worth adopting if Bash-native discovery is considered
important enough to justify the adapter-proof burden below.

## Proposal

Split Bash operand gating by proven command semantics:

1. **Redirection targets** (`>`, `>>`, `<`, `<>`) and operands of
   unknown/unproven commands stay on `writePaths` with the `bash` context.
   No change.
2. **Operands of adapter-proven read-only invocations** are gated against
   `readPaths` with a new `"bash"` read context added to
   `readPathContextSchema` (regenerate `schemas/profiles.schema.json`).

An invocation is read-proven only when the adapter establishes both:

- the command cannot write with the given flags, and
- every operand's role is understood (existing `classifyCommandTokens`
  adapters plus the write-flag proof below).

Anything else — including known readers with unrecognized options — falls
back to `writePaths`, preserving today's posture.

### Per-adapter write-flag proof required

| Command                                   | Write-capable forms the proof must reject                  | Existing coverage                                                                           |
| ----------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `cat`, `head`, `tail`, `wc`, `file`, `nl` | none known; still reject unrecognized options              | `readCommands.ts` parsers                                                                   |
| `sed`                                     | `-i`/`--in-place`, `w`/`r` commands in the program         | `parseSed` rejects `-i`; program `w` command **not** covered                                |
| `sort`                                    | `-o`/`--output`, `--files0-from`                           | `parseSort` rejects both                                                                    |
| `ls`                                      | none                                                       | no adapter yet                                                                              |
| `find`                                    | `-delete`, `-exec`, `-execdir`, `-fprint*`, `-files0-from` | command policy denies delete/exec; `classifyFindArguments` marks `-fprint*` values as paths |
| `rg`                                      | none (no file-writing flags)                               | `classifyRipgrepPatterns`                                                                   |
| `git` (read subcommands)                  | `--output`, `--lost-found`, ref-mutating flags             | command policy denies `--output`; needs per-subcommand allowlist                            |

The gap today: `readCommands.ts` proves write-flag absence for its small
reader set but only feeds `validateReadCommands` (composition blocking),
while `classify.ts` marks operand kinds without proving write-flag absence.
This plan requires fusing them: classification must consult the
`parseReadCommand`-style verdict before upgrading an operand to
read-proven.

### `cd` precedent

The `cd` change already shipped a narrower version of this idea: `cd`
targets gate against `readPaths` (`ls` context) because `cd` mutates
nothing and only repositions operand-less readers. This plan generalizes
that reasoning from one builtin to proven read-only invocations.

## Invariants that must survive

- Restrictive `writePaths` and `PI_SUBAGENT_PERMISSIBLE_GLOBS` still cannot
  be bypassed by basename-only, dynamic, Git-colon, redirection, nested, or
  CWD-dependent operands **of any invocation that is not read-proven**.
- A read-proven command must be unable to write at all; proof failure
  defaults to the current writePaths behavior, never to a silent exemption.
- Protected-path patterns apply identically in both contexts (they already
  layer over `evaluatePathByPattern` regardless of the rule array used).
- `tests-disallowed` must keep test files unreadable: its `readPaths` deny
  rules apply to the new `bash` read context unless explicitly scoped
  otherwise. Verify the profile still blocks `cat src/example.test.ts`.
- Subagent scope continues to replace both `readPaths` and `writePaths` for
  Bash analysis (shipped with the `cd` change), so scoped agents gain
  nothing new.

## Test plan (write first, watch fail)

1. Under a `writePaths`-deny-`**` + `readPaths`-allow-`*` policy:
   `cat src/example.ts`, `ls src`, `rg --files src`,
   `git diff src/a.ts` are allowed without prompting.
2. Same policy: `sed -i s/a/b/ src/example.ts`, `sort -o out src/a.ts`,
   `find src -fprint out`, `cp src/a.ts /tmp`,
   `echo x > src/a.ts` remain blocked.
3. `tests-only`: Bash readers reach implementation files; `tests-disallowed`:
   Bash readers still cannot reach test files.
4. Read-only profile: Bash readers work inside the startup directory;
   `../**` stays denied.
5. Schema: `readPaths` rules accept `contexts: ["bash"]`; generated schema
   matches runtime validation.
6. README and Phase 8 characterization tests updated to the new posture.

## Documentation to update when adopted

- README policy-model bullets ("every Bash filesystem operand" posture).
- README "Protected shell reads" section.
- `refactor_remediation_plan.md` Phase 8 posture line.
- `prompts/tests-only.md` tooling constraints (Bash readers become usable
  for inspection again; keep the dedicated-tools preference).

## Open questions

- Is the adapter-proof maintenance burden (every new reader flag is a
  potential silent hole) acceptable, given dedicated tools already cover
  inspection? This is the main reason the current posture exists.
- Should read-proven gating use a distinct `bash` read context (profile
  authors can differentiate) or reuse `ls`-style contexts (less schema
  churn)? Leaning: distinct context, matching the `writePaths` precedent.
- Do we want an escape-hatch profile rule to force Bash readers back onto
  `writePaths` (i.e., opt out of the relaxation per profile)?
