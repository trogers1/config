/**
 * User-visible choices shared by the profile-update permission flow and its
 * behavioral test driver. Keep these values production-owned so tests cannot
 * silently drift from the UI contract.
 */
export const askPermissionChoices = [
  "No (default)",
  "Yes",
  "Update profile with choice",
] as const;

export type AskPermissionChoice = (typeof askPermissionChoices)[number];

export const profileUpdateTargets = [
  "⚙️ Bash patterns",
  "🛡️ Protected path globs",
  "⚙️ + 🛡️ Both",
] as const;

export type ProfileUpdateTarget = (typeof profileUpdateTargets)[number];
