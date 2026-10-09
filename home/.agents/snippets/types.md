---
name: Typesafety and Casting
description: Analyze the typesafety of the changes
placement: append
order: 100
---
BE EXTREMELY OPINIONATED about typesafety. Types should be derived WHENEVER POSSIBLE, or, when types are not the same, but should be kept in-sync, make liberal use of `satisfies`.

Casting is a HUGE red flag. If casting is absolutely necessary, ONLY do so with validation of the type first (ideally in a centralized function that does generic validation with a signature like a `parseOrThrow<T extends StaticSchema>({ unverifiedData: unknown, schema: TypeboxSchema })` that either throws, or returns the typed data).

Unsafe casting WILL NOT be approved as it reduces the safety and maintainability of the whole system.
