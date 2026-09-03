/**
 * User-visible choices shared by the profile-update permission flow and its
 * behavioral test driver. Keep these values production-owned so tests cannot
 * silently drift from the UI contract.
 */
export const askPermissionChoices = [
  "No (default)",
  "Allow once",
  "Save rule(s) to profile…",
] as const;
