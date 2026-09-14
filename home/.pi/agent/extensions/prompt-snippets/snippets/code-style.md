---
name: Code Style
description: Single-object args, hard-coding etc.
placement: append
order: 109
---

# Code Style

Code will not be accepted that does not stick to the following guide.

## Single-Object Arguments

Prefer single-object arguments for functions. Avoid positional args as they are less maintainable and less explicit. Instead of

```ts
function divide(arg1: number, arg2: number) { 
  // ...
}

divide(1,3)
```

Prefer function signatures and usage more similar to:

```ts
function divide({ numerator, denominator }: {numerator: number, denominator: number}) { 
  // ...
}
divide({ numerator: 1, denominator: 3 })
```

We want readable, maintainable, and explicit code, and this second example is much more readable and explicit in it's usage.

Make sure that ALL functions that we own (INCLUDING those with only one arg) use single-object args with explicit, named properties.

## Hard-Coded Values

ALWAYS avoid hard-coding values, even in tests. If you find hard-coded strings repeated, ALWAYS convert them to derived values or to constants that can be re-used.


For example:

```ts
// module.ts
function doSomething(){

  if (something){
    return 'This expected string'
  }

  if (another || something){
    return 'this expected string'
  }

  return 'Another expected string'
}

// module.test.ts
it('does something', () => {
  // ...
  expect(result).toEqual('This expected string')
})
it('does something else', () => {
  // ...
  expect(result).toEqual('Another expected string')
})
```

ALWAYS convert hard-coded values to derived values:

```ts
// module.ts
import { errors } from './errors.ts'

export RESULTS = { 
  successMessage: 'This expected string',
} as const;

function doSomething(){

  if (something){
    return RESULTS.successMessage;
  }

  if (another || something){
    return RESULTS.successMessage;
  }

  return errors.somethingElse
}

// module.test.ts
import { RESULTS } from './module'
import { errors } from './errors'
it('does something', () => {
  // ...
  expect(result).toEqual(RESULTS.successMessage)
})
it('does something else', () => {
  // ...
  expect(result).toEqual(errors.somethingElse)
})
```

## Re-use And Derive

Do not write custom code when other code can simply be re-used or slightly modified. Keep logic centralized and shared when possible.
