# Taylor's defaults

Always-on preferences for every repository. Project instructions take
precedence. Detailed guidance lives in the `code` and `types` snippets and the
`testing` and `flow-review` skills.

## Implementation

- Keep code simple, obvious, and derived from the config, schemas, and
  definitions that already exist. Never redefine a value or type that exists
  elsewhere, including in tests; import or derive it.
- Be strict about type safety. Derive types; use `satisfies` to keep related
  shapes in sync. Cast only inside a validation function that checks the data
  first and throws on mismatch.
- Fail loudly. Throw a specific error instead of returning `undefined` or an
  empty value, `continue`-ing past unexpected data, or silently recovering.
- In TypeScript, JavaScript, and Python, give functions we own a single object
  argument with named properties (keyword-only arguments in Python).
- Reuse and centralize existing logic rather than writing a parallel version.

## Testing

- Test behavior through the real public entry point, as production-like as
  possible: real wiring, realistic config and data, fakes rather than mocked
  internals.
- Tests should survive a rewrite of the implementation. Drop to unit tests only
  for genuinely complex logic or edge cases the boundary cannot reach.
- Validate boundary inputs against a schema so test fixtures cannot drift from
  what production receives.
