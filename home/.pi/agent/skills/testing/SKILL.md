---
name: testing
description: >-
  Reviews and refactors test design toward behavioral, production-like tests.
  Use when auditing a repo's test suite, planning a test rewrite, or deciding
  whether existing tests should be lifted to the public entry point, dropped to
  a lower level, or reshaped to survive implementation changes.
---

# Test Design Review & Refactor

Use this skill when Taylor asks you to review how tests are *designed* (not just whether they pass) or to refactor a test suite toward more production-like coverage. This is about test architecture, shape, and resilience — not bug-hunting.

## Core Philosophy

Taylor's testing preferences, in priority order:

1. **Behavioral over structural.** Tests should assert observable behavior through the real public surface, not poke at internals. If a test would break because you renamed a private function, it's testing the wrong thing.
2. **Production-like.** Drive tests through the actual package/program entry point the way real callers do. Favor fakes, fixtures, and seeded context over mocked internals. The closer a test runs to the real code path, the more likely it is to catch real regressions.
3. **Minimal assumptions, maximum coverage per test.** Each test should exercise an entire flow end-to-end. Avoid stitching dozens of tiny unit tests together to reconstruct one behavior — that fragments intent and hides integration gaps. One well-chosen behavioral test usually beats five mock-heavy micro-tests.
4. **Lower-level only when justified.** Drop to a unit/inner-module test only when the logic is genuinely complex (parsing, state machines, finance, algorithms) and isolating it materially improves signal. Default to the top; descend only with reason.
5. **The guiding star: implementation-independence.** The test suite should help validate a *full rewrite* of the implementation, not entangle itself in the current one. If you could swap the implementation entirely and the tests still meaningfully validate behavior, the design is right. If the tests would fight a rewrite, the design is wrong.

## Drift Protection

Behavioral, entry-point tests only stay valuable if the contract they exercise matches what production actually receives. Keep them honest by validating the runtime context/inputs against an explicit, declared shape:

- Maintain a schema (e.g. TypeBox, Zod, JSON Schema) for any context, config, or payload the entry point accepts.
- Validate at runtime — ideally at the boundary — and throw a clear, user-visible error when the shape drifts from what the code requires.
- This turns "the fake context the tests send in" into a *living contract*: when production drifts, the schema fails loudly instead of silently, and the tests are forced to track reality.

The schema is the mechanism that lets you trust production-like tests long-term. Without it, entry-point tests quietly rot.

## Review Workflow

When asked to review a suite:

1. **Map the suite.** List test files and group them by what layer they target: entry point / public API, internal modules, helpers, or pure functions.
2. **Score each group** against the philosophy above. Note where tests:
   - mock internals that production callers never see,
   - assert on implementation details (private names, call counts, internal state),
   - duplicate logic instead of exercising it,
   - cover only a sliver of a flow and rely on other tests to fill gaps,
   - or would block a clean rewrite.
3. **Find the real entry point(s).** Identify the public boundary callers actually use. Most behavioral tests should go through it.
4. **Check drift exposure.** Is there any schema/contract validating the inputs the entry point receives? If not, flag it as the highest-leverage addition.
5. **Propose a target design**, not a rewrite-all-at-once plan:
   - Which tests lift to the entry point.
   - Which stay low-level and why.
   - Which to delete because they assert the wrong thing or duplicate coverage.
   - What schema/contract to add at the boundary.
6. **Make changes incrementally and verify** with the repo's actual test/typecheck commands. Prefer the narrowest command that exercises the changed area.

## Refactor Heuristics

- Replace `mock(internal).expect(calledOnce)` with a fake collaborator and assert on the observable outcome.
- If a test reconstructs a flow by calling five internal functions in order, replace it with one call through the public entry.
- If multiple tests exist only to cover branches of one private function, ask whether those branches are observable from the entry point; if yes, cover them there; if no, the private function may deserve a focused unit test.
- Keep fixtures minimal and realistic. A fake context that mirrors a real one is more valuable than an exhaustive mock graph.
- When adding the boundary schema, fail loud and early: validate on entry, throw with a message that names the missing/unexpected field and where to look.

## Anti-patterns to Flag

- Tests that import private/internal symbols purely to assert on them.
- Mock setups so elaborate they effectively re-implement the function under test.
- "Coverage" tests that assert a function was called rather than that a result was produced.
- Suite-wide reliance on a single shared mutable fixture that couples tests to execution order.
- Behavioral tests with no contract backing the inputs — they pass today, silently rot tomorrow.

## Output

When Taylor asks for a review, deliver:

- A short layer map of the current suite.
- A list of concrete issues mapped to the philosophy above.
- A proposed target design (entry-point tests + justified low-level tests + boundary schema).
- A minimal, ordered set of changes to get there, with the verification command for each.

When Taylor asks for a refactor, make the changes incrementally, run the narrowest verification after each, and commit atomic steps with clear messages. Do not rewrite the suite in one bulk commit unless explicitly asked.
