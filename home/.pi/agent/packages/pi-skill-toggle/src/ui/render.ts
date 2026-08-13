import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export function fit({ text, width }: { text: string; width: number }): string {
  const truncated = truncateToWidth(text, Math.max(0, width));
  const padding = Math.max(0, width - visibleWidth(truncated));
  return `${truncated}${" ".repeat(padding)}`;
}

export function frameLine({
  theme,
  content,
  innerWidth,
}: {
  theme: Theme;
  content: string;
  innerWidth: number;
}): string {
  return `${theme.fg("borderAccent", "│")}${fit({ text: content, width: innerWidth })}${theme.fg("borderAccent", "│")}`;
}

export function divider({
  theme,
  innerWidth,
}: {
  theme: Theme;
  innerWidth: number;
}): string {
  return theme.fg("borderMuted", `├${"─".repeat(innerWidth)}┤`);
}

export function topBorder({
  theme,
  innerWidth,
}: {
  theme: Theme;
  innerWidth: number;
}): string {
  return theme.fg("borderAccent", `┌${"─".repeat(innerWidth)}┐`);
}

export function bottomBorder({
  theme,
  innerWidth,
}: {
  theme: Theme;
  innerWidth: number;
}): string {
  return theme.fg("borderAccent", `└${"─".repeat(innerWidth)}┘`);
}

export function combineColumns({
  left,
  right,
  leftWidth,
  rightWidth,
  sep,
}: {
  left: string[];
  right: string[];
  leftWidth: number;
  rightWidth: number;
  sep: string;
}): string[] {
  const rows = Math.max(left.length, right.length);
  const lines: string[] = [];
  for (let i = 0; i < rows; i += 1) {
    lines.push(
      `${fit({ text: left[i] ?? "", width: leftWidth })}${sep}${fit({ text: right[i] ?? "", width: rightWidth })}`,
    );
  }
  return lines;
}
