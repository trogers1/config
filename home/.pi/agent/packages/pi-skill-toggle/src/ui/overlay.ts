import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, type TUI } from "@earendil-works/pi-tui";
import type {
  SkillInvocationMode,
  SkillRecord,
  SkillToggleUiResult,
} from "../types.ts";
import { formatSourceKind } from "../inventory/classifier.ts";
import {
  bottomBorder,
  combineColumns,
  divider,
  fit,
  frameLine,
  topBorder,
} from "./render.ts";
import { filterSkills, modeLabel, toggleMode } from "./view-model.ts";

export async function showSkillToggleUi({
  ctx,
  skills,
}: {
  ctx: ExtensionContext;
  skills: SkillRecord[];
}): Promise<SkillToggleUiResult> {
  return ctx.ui.custom<SkillToggleUiResult>(
    (tui, theme, _keybindings, done) =>
      new SkillToggleOverlay({ tui, theme, skills, done }),
    {
      overlay: true,
      overlayOptions: {
        anchor: "center",
        width: "92%",
        maxHeight: "88%",
        minWidth: 86,
      },
    },
  );
}

class SkillToggleOverlay {
  private readonly desired = new Map<string, SkillInvocationMode>();
  private search = "";
  private selectedIndex = 0;

  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly skills: SkillRecord[];
  private readonly done: (result: SkillToggleUiResult) => void;

  constructor({
    tui,
    theme,
    skills,
    done,
  }: {
    tui: TUI;
    theme: Theme;
    skills: SkillRecord[];
    done: (result: SkillToggleUiResult) => void;
  }) {
    this.tui = tui;
    this.theme = theme;
    this.skills = skills;
    this.done = done;
    for (const skill of skills) this.desired.set(skill.id, skill.mode);
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.done({ action: "cancel", drafts: this.getDrafts() });
      return;
    }

    if (matchesKey(data, Key.ctrl("s"))) {
      this.done({ action: "apply", drafts: this.getDrafts() });
      return;
    }

    if (matchesKey(data, Key.up)) {
      this.moveSelection(-1);
      return;
    }

    if (matchesKey(data, Key.down)) {
      this.moveSelection(1);
      return;
    }

    if (matchesKey(data, Key.space)) {
      const selected = this.getSelectedSkill();
      if (selected?.editable) {
        this.desired.set(
          selected.id,
          toggleMode(this.desired.get(selected.id) ?? selected.mode),
        );
        this.tui.requestRender();
      }
      return;
    }

    if (matchesKey(data, Key.backspace)) {
      if (this.search.length > 0) {
        this.search = Array.from(this.search).slice(0, -1).join("");
        this.selectedIndex = 0;
        this.tui.requestRender();
      }
      return;
    }

    if (isPrintableInput(data)) {
      this.search += data;
      this.selectedIndex = 0;
      this.tui.requestRender();
    }
  }

  render(width: number): string[] {
    const innerWidth = Math.max(20, width - 2);
    const panelHeight = this.getPanelHeight();
    const bodyHeight = Math.max(10, panelHeight - 8);
    const leftWidth = Math.max(32, Math.floor((innerWidth - 1) * 0.48));
    const rightWidth = Math.max(28, innerWidth - leftWidth - 1);

    const header = this.renderHeader({ innerWidth });
    const search = frameLine({
      theme: this.theme,
      content: this.theme.fg(
        "muted",
        `Search: ${this.search || "(type to filter)"}`,
      ),
      innerWidth,
    });
    const body = combineColumns({
      left: this.renderList({ width: leftWidth, height: bodyHeight }),
      right: this.renderDetails({ width: rightWidth, height: bodyHeight }),
      leftWidth,
      rightWidth,
      sep: this.theme.fg("borderMuted", "│"),
    }).map((line) =>
      frameLine({ theme: this.theme, content: line, innerWidth }),
    );

    const footer = [
      frameLine({
        theme: this.theme,
        content: this.theme.fg(
          "dim",
          "type search • ↑↓ move • space toggle • ctrl+s apply + reload",
        ),
        innerWidth,
      }),
      frameLine({
        theme: this.theme,
        content: this.theme.fg("dim", "esc cancel"),
        innerWidth,
      }),
    ];

    return [
      topBorder({ theme: this.theme, innerWidth }),
      frameLine({ theme: this.theme, content: header, innerWidth }),
      search,
      divider({ theme: this.theme, innerWidth }),
      ...body,
      divider({ theme: this.theme, innerWidth }),
      ...footer,
      bottomBorder({ theme: this.theme, innerWidth }),
    ];
  }

  invalidate(): void {}

  private renderHeader({ innerWidth }: { innerWidth: number }): string {
    const title = this.theme.fg("accent", this.theme.bold("Pi Skill Toggle"));
    const changed = this.getChangedCount();
    const editable = this.skills.filter((skill) => skill.editable).length;
    const summary = this.theme.fg(
      "muted",
      `${this.skills.length} skills • ${editable} editable • ${changed} changed`,
    );
    const gap = Math.max(
      1,
      innerWidth - visibleLength(title) - visibleLength(summary),
    );
    return `${title}${" ".repeat(gap)}${summary}`;
  }

  private renderList({
    width,
    height,
  }: {
    width: number;
    height: number;
  }): string[] {
    const lines: string[] = [];
    const filtered = this.getFilteredSkills();

    if (filtered.length === 0) {
      lines.push(this.theme.fg("dim", "No matching skills"));
      return pad({ lines, height });
    }

    this.selectedIndex = clamp({
      value: this.selectedIndex,
      min: 0,
      max: filtered.length - 1,
    });
    const visibleCount = Math.max(4, Math.floor(height / 2));
    const start = Math.max(
      0,
      Math.min(
        this.selectedIndex - Math.floor(visibleCount / 2),
        Math.max(0, filtered.length - visibleCount),
      ),
    );
    const end = Math.min(filtered.length, start + visibleCount);

    for (let i = start; i < end; i += 1) {
      const skill = filtered[i];
      const desired = this.desired.get(skill.id) ?? skill.mode;
      const selected = i === this.selectedIndex;
      const changed = desired !== skill.mode;
      const marker = selected ? "›" : " ";
      const box = desired === "manual-only" ? "◼" : "□";
      const readonly = skill.editable
        ? ""
        : this.theme.fg("warning", " read-only");
      const changedMark = changed ? this.theme.fg("accent", " *") : "";
      const label = `${marker} ${box} ${skill.name}${changedMark}${readonly}`;
      lines.push(
        selected
          ? this.theme.fg(
              "accent",
              this.theme.bold(fit({ text: label, width })),
            )
          : fit({ text: label, width }),
      );
      lines.push(
        this.theme.fg(
          "dim",
          fit({
            text: `    ${modeLabel(desired)} — ${shorten({ text: skill.description || "No description", width: width - 4 })}`,
            width,
          }),
        ),
      );
    }

    return pad({ lines, height });
  }

  private renderDetails({
    width,
    height,
  }: {
    width: number;
    height: number;
  }): string[] {
    const skill = this.getSelectedSkill();
    const lines: string[] = [];
    if (!skill) {
      lines.push(this.theme.fg("dim", "No skill selected"));
      return pad({ lines, height });
    }

    const desired = this.desired.get(skill.id) ?? skill.mode;
    lines.push(this.theme.fg("accent", this.theme.bold(skill.name)));
    lines.push("");
    lines.push(
      `${this.theme.fg("muted", "Current:")} ${modeLabel(skill.mode)}`,
    );
    lines.push(
      `${this.theme.fg("muted", "Desired:")} ${modeLabel(desired)}${desired !== skill.mode ? this.theme.fg("accent", " (changed)") : ""}`,
    );
    lines.push(
      `${this.theme.fg("muted", "Source:")} ${formatSourceKind(skill.source.kind)}`,
    );
    lines.push(`${this.theme.fg("muted", "Root:")} ${skill.source.root}`);
    lines.push(
      `${this.theme.fg("muted", "Editable:")} ${skill.editable ? "yes" : this.theme.fg("warning", "no")}`,
    );
    lines.push("");
    lines.push(this.theme.fg("muted", "Path:"));
    lines.push(...wrap({ text: skill.filePath, width }));
    lines.push("");
    lines.push(this.theme.fg("muted", "Description:"));
    lines.push(...wrap({ text: skill.description || "(missing)", width }));

    if (skill.diagnostics.length > 0) {
      lines.push("");
      lines.push(this.theme.fg("muted", "Diagnostics:"));
      for (const diagnostic of skill.diagnostics.slice(0, 4)) {
        const color =
          diagnostic.severity === "error"
            ? "error"
            : diagnostic.severity === "warning"
              ? "warning"
              : "dim";
        lines.push(
          ...wrap({ text: `- ${diagnostic.message}`, width }).map((line) =>
            this.theme.fg(color, line),
          ),
        );
      }
    }

    return pad({ lines, height });
  }

  private moveSelection(delta: number): void {
    const filtered = this.getFilteredSkills();
    if (filtered.length === 0) return;
    this.selectedIndex = clamp({
      value: this.selectedIndex + delta,
      min: 0,
      max: filtered.length - 1,
    });
    this.tui.requestRender();
  }

  private getFilteredSkills(): SkillRecord[] {
    return filterSkills({ skills: this.skills, query: this.search });
  }

  private getSelectedSkill(): SkillRecord | undefined {
    return this.getFilteredSkills()[this.selectedIndex];
  }

  private getDrafts() {
    return this.skills.map((skill) => ({
      skill,
      desiredMode: this.desired.get(skill.id) ?? skill.mode,
    }));
  }

  private getChangedCount(): number {
    return this.skills.filter(
      (skill) => (this.desired.get(skill.id) ?? skill.mode) !== skill.mode,
    ).length;
  }

  private getPanelHeight(): number {
    const rows = this.tui.terminal.rows ?? 30;
    return clamp({ value: Math.floor(rows * 0.82), min: 16, max: 52 });
  }
}

function isPrintableInput(data: string): boolean {
  return (
    data.length > 0 &&
    !data.includes("\x1b") &&
    !data.includes("\r") &&
    !data.includes("\n") &&
    data >= " "
  );
}

function clamp({
  value,
  min,
  max,
}: {
  value: number;
  min: number;
  max: number;
}): number {
  return Math.max(min, Math.min(max, value));
}

function pad({ lines, height }: { lines: string[]; height: number }): string[] {
  const padded = [...lines];
  while (padded.length < height) padded.push("");
  return padded.slice(0, height);
}

function shorten({ text, width }: { text: string; width: number }): string {
  return text.length <= width
    ? text
    : `${text.slice(0, Math.max(0, width - 1))}…`;
}

function wrap({ text, width }: { text: string; width: number }): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [""];
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (current.length === 0) {
      current = word;
    } else if (`${current} ${word}`.length <= width) {
      current = `${current} ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function visibleLength(input: string): number {
  return input.replace(/\x1b\[[0-9;]*m/g, "").length;
}
