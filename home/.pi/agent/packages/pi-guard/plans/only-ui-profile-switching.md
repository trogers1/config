I'm worried that agents can circumvent our permissions and guardrails by changing their own profile or by creating subagents with elevated priveleges.

Here are thoughts on how to do this:

- profiles should only be change-able via the ui mid-session
- automated profile selection should only be on session start
- we could limit the types of profiles that can be selected by env var?
- Maybe the glob env var should completely overwrite the profile's read/write paths?
- subagents can never have more permissions than their parent somehow?

Also, if we can find a way to switch profiles easily mid-message, that would be great (if pi gives a surface/api for that). It's very annoying to be mid-prompt and realize you want a specific profile, need to delete your whole prompt, set it, then paste it back.

Additionally, for ergonomics, it would be nice if we fuzzy-searched the available profiles instead of exact matching.
