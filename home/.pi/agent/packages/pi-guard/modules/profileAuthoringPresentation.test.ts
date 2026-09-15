import { describe, expect, it } from "vitest";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { RuleKind } from "./profileConfig";
import {
  formatWizardProfileIdentity,
  generalSectionOption,
  generalSectionPresentation,
  localProfileDeclarationCount,
  metadataSectionPresentation,
  profileAuthoringSectionOption,
  renderPurposePresentation,
  ruleSectionOption,
  ruleSectionPresentation,
} from "./profileAuthoringPresentation";

describe("profile authoring presentation", () => {
  it("keeps every schema-derived rule section labeled and documented", () => {
    const labels = {
      bash: "⚙️ Bash rules",
      read: "📖 Read-path rules",
      write: "✏️ Write-path rules",
      protected: "🛡️ Protected safeguards",
    } as const satisfies Record<RuleKind, string>;
    for (const kind of Object.keys(labels) as RuleKind[]) {
      expect(ruleSectionPresentation[kind].label).toBe(labels[kind]);
      expect(ruleSectionPresentation[kind].purpose).not.toBe("");
      expect(ruleSectionPresentation[kind].examples).not.toBe("");
      expect(ruleSectionPresentation[kind].syntax).not.toBe("");
      expect(ruleSectionOption({ kind, count: 2 })).toBe(
        profileAuthoringSectionOption({
          label: labels[kind],
          summary: localProfileDeclarationCount({ count: 2 }),
        }),
      );
    }
  });

  it("renders protected policy spans with semantic colors and exact ordered copy", () => {
    const themeCalls: Array<{ color: string; text: string }> = [];
    const theme = {
      fg: (color: string, text: string) => {
        themeCalls.push({ color, text });
        return `\x1b[${themeCalls.length}m${text}\x1b[0m`;
      },
    };
    const protectedPresentation = ruleSectionPresentation.protected;
    const rendered = renderPurposePresentation({
      purpose: protectedPresentation.purposePresentation,
      styles: {
        normal: (text) => theme.fg("text", text),
        deny: (text) => theme.fg("error", text),
        allow: (text) => theme.fg("success", text),
      },
    });
    const wrapped = wrapTextWithAnsi(rendered, 24).join(" ");
    const visible = wrapped.replace(/\x1b\[[0-9;]*m/g, "");
    expect(themeCalls).toContainEqual({ color: "error", text: "🚫 DENY" });
    expect(themeCalls).toContainEqual({ color: "success", text: "✅ ALLOW" });
    expect(visible).toBe(protectedPresentation.purpose);
  });

  it("keeps metadata labels, examples, and plain profile identities consistent", () => {
    expect(generalSectionPresentation.label).toBe("⚙️ General");
    expect(generalSectionPresentation.purpose).not.toBe("");
    expect(generalSectionPresentation.examples).toContain("client-work");
    expect(generalSectionPresentation.syntax).toContain("description");
    expect(generalSectionPresentation.syntax).toContain("color");
    expect(generalSectionOption({ emoji: "🧪", name: "work" })).toBe(
      profileAuthoringSectionOption({
        label: generalSectionPresentation.label,
        summary: "🧪 work",
      }),
    );
    expect(metadataSectionPresentation.sandbox.label).toBe("🔐 Sandbox");
    expect(metadataSectionPresentation.directoryGlobs.label).toBe(
      "🎬 Startup Directory globs",
    );
    expect(metadataSectionPresentation.sandbox.syntax).toContain(
      "not policy globs",
    );
    expect(metadataSectionPresentation.directoryGlobs.examples).toContain(
      "/srv/**/service",
    );
    expect(metadataSectionPresentation.directoryGlobs.syntax).toContain(
      "** matches complete directory segments",
    );
    expect(formatWizardProfileIdentity({ emoji: "🧪", name: "work" })).toBe(
      "🧪 work",
    );
    expect(
      formatWizardProfileIdentity({ emoji: undefined, name: "work" }),
    ).toBe("work");
  });
});
