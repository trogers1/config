/**
 * Characters a terminal can act on or render misleadingly: C0 controls
 * (including ESC and newlines), DEL and C1 controls (including CSI), bidi
 * marks and overrides, zero-width and invisible format characters, and
 * line/paragraph separators.
 */
const unsafeTerminalCharacters =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\u2028\u2029\ufeff]/gu;

/**
 * Escape every unsafe character as `\uXXXX`, so request or authored text is
 * shown on one line exactly as data. Each escaped character is one UTF-16
 * code unit, so a prefix escapes to a prefix of the escaped whole.
 */
export function terminalSafeText({ text }: { readonly text: string }): string {
  return text.replace(
    unsafeTerminalCharacters,
    (character) =>
      `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}
