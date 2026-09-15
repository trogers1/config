import { describe, expect, it } from "vitest";
import { createExtensionHarness } from "../integrationTests/support/extensionHarness";
import type { RuleKind } from "./profileConfig";
import type { ReadPathRule, WritePathRule } from "./policyHelpers";
import {
  isBroaderPattern,
  profileRuleEditRows,
  ruleDestination,
  ruleEffect,
  editProfileRuleRows,
  serializeProfileRuleSectionEdit,
  type EditableRuleRow,
} from "./profileRuleEditor";
import { ruleSectionPresentation } from "./profileAuthoringPresentation";
import { createProfileAuthoringFlow } from "./profileAuthoringFlow";

describe("profile rule editor semantics", () => {
  it("maps every layer to its real collection and non-effect", () => {
    const expectedDestinations = {
      bash: "tools.bash",
      read: "readPaths",
      write: "writePaths",
      protected: "protectedPathRules",
    } satisfies Record<RuleKind, string>;
    expect(ruleDestination("bash")).toBe(expectedDestinations.bash);
    expect(ruleDestination("read")).toBe(expectedDestinations.read);
    expect(ruleDestination("write")).toBe(expectedDestinations.write);
    expect(ruleDestination("protected")).toBe(expectedDestinations.protected);
    expect(ruleEffect("write", "allow")).toContain(
      "read-tool access is unaffected",
    );
    expect(ruleEffect("protected", "allow")).toContain(
      "grants no read or write permission",
    );
  });

  it("round-trips untouched raw local ASK rows, alternatives, and contexts", () => {
    const raw: ReadPathRule[] = [
      {
        pattern: "notes/**",
        decision: "ask",
        guidance: "Use the index first.",
        alternatives: ["notes/README.md"],
        contexts: ["grep", "find"],
      },
    ];
    const initial = profileRuleEditRows("read", raw);
    const rows: EditableRuleRow[] = [
      {
        id: initial[0].id,
        kind: "read",
        pattern: "notes/**",
        decision: "ask",
        guidance: "Use the index first.",
        contexts: ["grep", "find"],
        origin: "existing",
      },
    ];
    const edit = serializeProfileRuleSectionEdit({
      kind: "read",
      initial,
      rows,
    });
    expect(edit).toEqual({ mode: "set", value: raw });
    if (edit.mode === "set") expect(edit.value[0]).toBe(raw[0]);
  });

  it("preserves unedited optional fields while changing a local row and omits cleared sections", () => {
    const raw: WritePathRule[] = [
      {
        pattern: "generated/**",
        decision: "ask",
        guidance: "Use generated output.",
        alternatives: ["generated/index.ts"],
        contexts: ["write"],
      },
    ];
    const initial = profileRuleEditRows("write", raw);
    const changed: EditableRuleRow[] = [
      {
        id: initial[0].id,
        kind: "write",
        pattern: "generated/private/**",
        decision: "deny",
        guidance: "Use generated output.",
        contexts: ["write"],
        origin: "existing",
      },
    ];
    expect(
      serializeProfileRuleSectionEdit({
        kind: "write",
        initial,
        rows: changed,
      }),
    ).toEqual({
      mode: "set",
      value: [
        {
          pattern: "generated/private/**",
          decision: "deny",
          guidance: "Use generated output.",
          alternatives: ["generated/index.ts"],
          contexts: ["write"],
        },
      ],
    });
    expect(
      serializeProfileRuleSectionEdit({ kind: "write", initial, rows: [] }),
    ).toEqual({
      mode: "omit",
    });
    expect(
      serializeProfileRuleSectionEdit({
        kind: "write",
        initial: [],
        rows: [],
        preserveExplicitEmpty: true,
      }),
    ).toEqual({
      mode: "set",
      value: [],
    });
  });

  it("rejects rows whose kind or contexts do not match the destination", () => {
    const initial = profileRuleEditRows("read", []);
    const row: EditableRuleRow = {
      id: "wrong",
      kind: "write",
      pattern: "generated/**",
      decision: "allow",
      contexts: ["write"],
      origin: "existing",
    };
    expect(() =>
      serializeProfileRuleSectionEdit({ kind: "read", initial, rows: [row] }),
    ).toThrow("row kind does not match read section");
    expect(() =>
      serializeProfileRuleSectionEdit({
        kind: "read",
        initial,
        rows: [{ ...row, kind: "read", contexts: ["write"] }],
      }),
    ).toThrow("read rule contexts must be read contexts");
    expect(() =>
      serializeProfileRuleSectionEdit({
        kind: "bash",
        initial: profileRuleEditRows("bash", []),
        rows: [{ ...row, kind: "bash", contexts: ["write"] }],
      }),
    ).toThrow("contexts are not valid for bash rules");
  });

  it("renders an empty protected form in ordered, separated presentation blocks", async () => {
    const harness = createExtensionHarness({ interactiveUi: true });
    const pending = editProfileRuleRows({
      ctx: harness.context,
      options: {
        mode: "edit",
        kind: "protected",
        title: ruleSectionPresentation.protected.label,
        rows: [],
        allowAddRemove: true,
      },
    });
    const modal = await harness.ui.waitForRuleForm();
    const lines = modal.render(500);
    const presentation = ruleSectionPresentation.protected;
    const purpose = lines.findIndex((line) =>
      line.includes(presentation.purpose),
    );
    const examples = lines.findIndex((line) =>
      line.includes(presentation.examples),
    );
    const syntax = lines.findIndex((line) =>
      line.includes(presentation.syntax),
    );
    const empty = lines.findIndex((line) =>
      line.includes("No rules in this section"),
    );
    const controls = lines.findIndex((line) => line.includes("Enter save"));

    expect(lines[1]).toBe("");
    expect(lines[purpose - 1]).toBe("");
    expect(lines[examples - 1]).toBe("");
    expect(syntax).toBe(examples + 1);
    expect(lines[empty - 1]).toBe("");
    expect(lines[controls - 1]).toBe("");
    modal.press("Escape");
    await expect(pending).resolves.toMatchObject({ action: "back", rows: [] });
  });

  it("renders one arrow for a rule input added with Ctrl+N", async () => {
    const harness = createExtensionHarness({
      interactiveUi: true,
      tuiMode: true,
    });
    const pending = editProfileRuleRows({
      ctx: harness.context,
      options: {
        mode: "edit",
        kind: "bash",
        title: ruleSectionPresentation.bash.label,
        rows: [],
        allowAddRemove: true,
      },
    });
    const modal = await harness.ui.waitForRuleForm();

    modal.press("CtrlN");
    const inputRow = modal
      .render()
      .find(
        (line) =>
          line.startsWith("→ ") &&
          line.includes(ruleSectionPresentation.bash.label),
      );
    expect(inputRow).toBeDefined();
    expect(inputRow).toMatch(/^→ /u);
    expect(inputRow).not.toContain(" > ");
    expect(inputRow).not.toContain("> >");

    modal.type("git status");
    modal.press("Backspace");
    modal.type("s");
    modal.press("Enter");
    await expect(pending).resolves.toMatchObject({
      action: "save",
      rows: [expect.objectContaining({ pattern: "git status" })],
    });
  });

  it("lets the authoring adapter root-abort populated and empty rule forms with Ctrl+C", async () => {
    const populatedHarness = createExtensionHarness({ interactiveUi: true });
    const populatedFlow = createProfileAuthoringFlow({
      ctx: populatedHarness.context,
    });
    const populated = editProfileRuleRows({
      ctx: populatedHarness.context,
      custom: populatedFlow.custom,
      options: {
        mode: "edit",
        kind: "bash",
        title: ruleSectionPresentation.bash.label,
        rows: [
          {
            id: "existing-bash",
            kind: "bash",
            pattern: "git status",
            decision: "allow",
            origin: "existing",
          },
        ],
      },
    });
    const populatedModal = await populatedHarness.ui.waitForRuleForm();
    populatedModal.press("CtrlC");
    await expect(populated).resolves.toMatchObject({ action: "back" });
    expect(populatedFlow.signal.aborted).toBe(true);
    populatedFlow.dispose();

    const emptyHarness = createExtensionHarness({ interactiveUi: true });
    const emptyFlow = createProfileAuthoringFlow({ ctx: emptyHarness.context });
    const empty = editProfileRuleRows({
      ctx: emptyHarness.context,
      custom: emptyFlow.custom,
      options: {
        mode: "edit",
        kind: "bash",
        title: ruleSectionPresentation.bash.label,
        rows: [],
      },
    });
    const emptyModal = await emptyHarness.ui.waitForRuleForm();
    emptyModal.press("CtrlC");
    await expect(empty).resolves.toMatchObject({
      action: "back",
      rows: [],
    });
    expect(emptyFlow.signal.aborted).toBe(true);
    emptyFlow.dispose();
  });

  it("keeps the default ASK editor Ctrl+C behavior local", async () => {
    const harness = createExtensionHarness({ interactiveUi: true });
    const pending = editProfileRuleRows({
      ctx: harness.context,
      options: {
        mode: "ask",
        title: "Review 1 profile change",
        rows: [
          {
            id: "requested-bash",
            kind: "bash",
            pattern: "git status",
            decision: "ask",
            origin: "request",
          },
        ],
      },
    });
    const modal = await harness.ui.waitForRuleForm();
    modal.press("CtrlC");
    await expect(pending).resolves.toMatchObject({ action: "back" });
  });

  it("flags any request-derived pattern changed from its exact prefill", () => {
    const row: EditableRuleRow = {
      id: "request-1",
      kind: "write",
      pattern: "generated/**",
      decision: "allow",
      contexts: ["write"],
      origin: "request",
      request: {
        kind: "write",
        context: "write",
        requestedValue: "/repo/generated/a.ts",
        initialPattern: "generated/a.ts",
        currentDecision: "ask",
        source: { tool: "write" },
      },
    };
    expect(isBroaderPattern(row)).toBe(true);
    expect(isBroaderPattern({ ...row, pattern: "generated/a.ts" })).toBe(false);
  });
});
