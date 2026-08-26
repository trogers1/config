import type { ProfileColor } from "./policyHelpers";

const profileColorFormatters: Record<ProfileColor, (value: string) => string> =
  {
    black: (value) => `\x1b[30m${value}\x1b[0m`,
    red: (value) => `\x1b[31m${value}\x1b[0m`,
    green: (value) => `\x1b[32m${value}\x1b[0m`,
    yellow: (value) => `\x1b[33m${value}\x1b[0m`,
    orange: (value) => `\x1b[33m${value}\x1b[0m`,
    blue: (value) => `\x1b[34m${value}\x1b[0m`,
    magenta: (value) => `\x1b[35m${value}\x1b[0m`,
    cyan: (value) => `\x1b[36m${value}\x1b[0m`,
    white: (value) => `\x1b[37m${value}\x1b[0m`,
  };

/** Apply the configured profile color using portable ANSI SGR sequences. */
export function formatProfileColor(color: ProfileColor, value: string): string {
  return profileColorFormatters[color](value);
}
