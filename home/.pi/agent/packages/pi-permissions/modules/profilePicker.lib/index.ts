import type { Theme } from "@earendil-works/pi-coding-agent";
import { formatProfileColor } from "../profileColors";
import type { ProfileColor } from "../policyHelpers";
import {
  Input,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type Focusable,
} from "@earendil-works/pi-tui";

export type ProfilePickerItem = {
  name: string;
  description: string;
  emoji?: string;
  color?: ProfileColor;
};

export function formatProfileName(item: ProfilePickerItem): string {
  const name = `${item.emoji ? `${item.emoji} ` : ""}${item.name}`;
  return item.color ? formatProfileColor(item.color, name) : name;
}

type ScoredItem = { item: ProfilePickerItem; score: number };

/** Case-insensitive ordered-character match, biased toward early and contiguous matches. */
export function fuzzyScore(query: string, value: string): number | undefined {
  const needle = query.toLocaleLowerCase();
  const haystack = value.toLocaleLowerCase();
  if (!needle) return 0;

  let score = 0;
  let previous = -2;
  for (const character of needle) {
    const index = haystack.indexOf(character, previous + 1);
    if (index === -1) return undefined;
    score += index === previous + 1 ? 8 : 1;
    score += Math.max(0, 12 - index);
    previous = index;
  }
  return score;
}

/** Return profiles matching a query, ranked so close name matches win over descriptions. */
export function filterProfiles(
  items: readonly ProfilePickerItem[],
  query: string,
): ProfilePickerItem[] {
  return items
    .map((item): ScoredItem | undefined => {
      const nameScore = fuzzyScore(query, item.name);
      const descriptionScore = fuzzyScore(query, item.description);
      const score = Math.max(
        nameScore ?? Number.NEGATIVE_INFINITY,
        descriptionScore ?? Number.NEGATIVE_INFINITY,
      );
      return score === Number.NEGATIVE_INFINITY ? undefined : { item, score };
    })
    .filter((result): result is ScoredItem => result !== undefined)
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.item.name.localeCompare(right.item.name),
    )
    .map((result) => result.item);
}

/** Focusable fuzzy-search picker used by the /profile command and shortcut. */
export class ProfilePicker implements Component, Focusable {
  private _focused = false;
  private readonly input = new Input();
  private selectedIndex = 0;

  constructor(
    private readonly items: readonly ProfilePickerItem[],
    private readonly theme: Theme,
    private readonly onSelect: (profile: string) => void,
    private readonly onCancel: () => void,
  ) {
    this.input.onSubmit = () => this.selectCurrent();
    this.input.onEscape = onCancel;
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.input.focused = value;
  }

  private matches(): ProfilePickerItem[] {
    return filterProfiles(this.items, this.input.getValue());
  }

  private selectCurrent(): void {
    const item = this.matches()[this.selectedIndex];
    if (item) this.onSelect(item.name);
  }

  handleInput(data: string): void {
    const matches = this.matches();
    if (matchesKey(data, Key.up)) {
      this.selectedIndex = matches.length
        ? (this.selectedIndex - 1 + matches.length) % matches.length
        : 0;
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.selectedIndex = matches.length
        ? (this.selectedIndex + 1) % matches.length
        : 0;
      return;
    }
    if (matchesKey(data, Key.enter)) {
      this.selectCurrent();
      return;
    }
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.onCancel();
      return;
    }

    this.input.handleInput(data);
    this.selectedIndex = 0;
  }

  render(width: number): string[] {
    const matches = this.matches();
    this.selectedIndex = Math.min(
      this.selectedIndex,
      Math.max(0, matches.length - 1),
    );
    const lines = [
      this.theme.fg("accent", this.theme.bold("Select permissions profile")),
      ...this.input.render(width),
    ];

    if (matches.length === 0) {
      lines.push(this.theme.fg("warning", "  No matching profiles"));
    } else {
      const maxVisible = 10;
      const start = Math.max(
        0,
        Math.min(
          this.selectedIndex - Math.floor(maxVisible / 2),
          matches.length - maxVisible,
        ),
      );
      for (const [index, item] of matches
        .slice(start, start + maxVisible)
        .entries()) {
        const itemIndex = start + index;
        const prefix = itemIndex === this.selectedIndex ? "→ " : "  ";
        const name = formatProfileName(item);
        const descriptionWidth = Math.max(
          0,
          width - visibleWidth(prefix) - visibleWidth(name) - 2,
        );
        const description = descriptionWidth
          ? `  ${truncateToWidth(item.description, descriptionWidth, "")}`
          : "";
        const text = truncateToWidth(
          `${prefix}${name}${this.theme.fg("muted", description)}`,
          width,
        );
        lines.push(
          itemIndex === this.selectedIndex
            ? this.theme.bg("selectedBg", text)
            : text,
        );
      }
      if (matches.length > maxVisible) {
        lines.push(
          this.theme.fg(
            "dim",
            `  (${this.selectedIndex + 1}/${matches.length})`,
          ),
        );
      }
    }

    lines.push(
      this.theme.fg(
        "dim",
        "type to fuzzy search names and descriptions • ↑↓ navigate • enter select • esc cancel",
      ),
    );
    return lines.map((line) => truncateToWidth(line, width));
  }

  invalidate(): void {
    this.input.invalidate();
  }
}
