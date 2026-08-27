# Guided Profile Creation

Users should be guided through custom profile creation by using something like /profile-add in pi

- Should use the same search/profile pick UI (will need generalized/shared), but instead you are picking profiles and rulesets to compose/append (which should all have the be same emoji and color for all rulesets—we probably need to add required descriptions to rulesets as well for help picking/fuzzy search).
- Then ask if they want a transform (default to no).
- Then ask to enter protected paths.
- Then ask if they want it sandboxed.
- Then a name, description, and emoji (with a default custom emoji)

We should then use the same profile creation function/system for “add to profile” on ask response:

- when asking about a command we should have options like `yes — add to profile`; `no — add to profile`
  - then let them optionally add guidance/steering
- when there is no active custom profile, and just extend the current one as a new custom one.
- Otherwise, just add the rule to the current custom profile
