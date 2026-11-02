import {
  CURSOR_MARKER,
  stripTerminalSequences,
  visibleWidth,
} from "@earendil-works/pi-tui";
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
  editRules,
  serializeProfileRuleSectionEdit,
  type EditableRuleCreation,
  type EditableRuleRow,
} from "./profileRuleEditor";
import { ruleSectionPresentation } from "./profileAuthoringPresentation";
import { createProfileAuthoringFlow } from "./profileAuthoringFlow";
import {
  customToolInputCandidates,
  decodeCustomRuleGroups,
  encodeCustomRuleGroups,
  rawGlobWarning,
  ruleEditorIdentityHistory,
  validateCustomRule,
  transitionRuleEditor,
  type RuleEditorState,
} from "./ruleEditorDomain";

describe("profile rule editor semantics", () => {
  it("extracts representable custom leaves and reports unconstrained paths", () => {
    const cyclic: Record<string, unknown> = {
      agent: "*",
      nested: { task: "review", list: [null, 2] },
      "bad.key": "skip",
      "": "empty key",
      options: {},
      tags: [],
      missing: undefined,
      ratio: Number.NaN,
      when: new Date(0),
    };
    cyclic.self = cyclic;
    const { candidates, unconstrainedPaths } = customToolInputCandidates({
      input: cyclic,
    });
    expect(candidates).toEqual([
      expect.objectContaining({ inputPath: "agent", initialPattern: "*" }),
      expect.objectContaining({
        inputPath: "nested.task",
        initialPattern: "review",
      }),
      expect.objectContaining({
        inputPath: "nested.list.0",
        initialPattern: "null",
      }),
      expect.objectContaining({
        inputPath: "nested.list.1",
        initialPattern: "2",
      }),
    ]);
    expect(candidates[0]?.rawGlobWarning).toEqual(expect.any(String));
    // Each of these is left unconstrained by a rule prefilled from the request.
    expect(unconstrainedPaths).toEqual([
      '["bad.key"]',
      '[""]',
      "options",
      "tags",
      "missing",
      "ratio",
      "when",
      "self",
    ]);
  });

  it("serializes custom clauses conjunctively and retains explicit empty groups", () => {
    const rows = decodeCustomRuleGroups({
      tools: {
        subagent: [
          {
            decision: "allow",
            match: { agent: "*", task: "*", cwd: "~/Code/config/**" },
          },
        ],
        empty: [],
      },
    });
    expect(encodeCustomRuleGroups({ rows, emptyToolNames: ["empty"] })).toEqual(
      {
        subagent: [
          {
            decision: "allow",
            match: { agent: "*", task: "*", cwd: "~/Code/config/**" },
          },
        ],
        empty: [],
      },
    );
    expect(
      validateCustomRule({
        rule: { toolName: "bash", inputs: [], decision: "allow" },
      }),
    ).toContain("reserved");
    expect(
      validateCustomRule({
        rule: { toolName: "__proto__", inputs: [], decision: "allow" },
      }),
    ).toContain("reserved");
    expect(
      validateCustomRule({
        rule: {
          toolName: "x",
          inputs: [
            { inputPath: "a", matcher: { kind: "glob", pattern: "*" } },
            { inputPath: "a", matcher: { kind: "glob", pattern: "*" } },
          ],
          decision: "allow",
        },
      }),
    ).toContain("duplicate");
  });

  it("maps every layer to its real collection and non-effect", () => {
    const expectedDestinations = {
      bash: "tools.bash",
      read: "readPaths",
      write: "writePaths",
      protected: "protectedPathRules",
    } satisfies Record<RuleKind, string>;
    expect(ruleDestination({ kind: "bash" })).toBe(expectedDestinations.bash);
    expect(ruleDestination({ kind: "read" })).toBe(expectedDestinations.read);
    expect(ruleDestination({ kind: "write" })).toBe(expectedDestinations.write);
    expect(ruleDestination({ kind: "protected" })).toBe(
      expectedDestinations.protected,
    );
    expect(ruleEffect({ kind: "write", decision: "allow" })).toContain(
      "read-tool access is unaffected",
    );
    expect(ruleEffect({ kind: "protected", decision: "allow" })).toContain(
      "grants no read or write permission",
    );
  });

  it("round-trips untouched raw local ASK rows, multiline guidance, and contexts", () => {
    const raw: ReadPathRule[] = [
      {
        pattern: "notes/**",
        decision: "ask",
        guidance:
          "Use the index first.\n\nSuggested alternatives:\n- notes/README.md",
        contexts: ["grep", "find"],
      },
    ];
    const initial = profileRuleEditRows({ kind: "read", rules: raw });
    const rows: EditableRuleRow[] = [
      {
        id: initial[0].id,
        kind: "read",
        pattern: "notes/**",
        decision: "ask",
        guidance:
          "Use the index first.\n\nSuggested alternatives:\n- notes/README.md",
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
        guidance:
          "Use generated output.\n\nSuggested alternatives:\n- generated/index.ts",
        contexts: ["write"],
      },
    ];
    const initial = profileRuleEditRows({ kind: "write", rules: raw });
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
          guidance: raw[0].guidance,
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
    const initial = profileRuleEditRows({ kind: "read", rules: [] });
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
        initial: profileRuleEditRows({ kind: "bash", rules: [] }),
        rows: [{ ...row, kind: "bash", contexts: ["write"] }],
      }),
    ).toThrow("contexts are not valid for bash rules");
  });

  it("saves an ASK catch-all with a submission-layer warning", async () => {
    const harness = createExtensionHarness({ interactiveUi: true });
    const pending = editRules({
      ctx: harness.context,
      options: {
        mode: "ask",
        title: "Review custom tool",
        lockedToolName: "opaque",
        rows: [],
      },
    });
    const modal = await harness.ui.waitForRuleForm();
    modal.press("CtrlN");
    modal.type("Tool-wide guidance");
    const screen = modal.render(500).join("\n");
    expect(screen).toContain(
      "Tool-wide catch-all: Save opens a separate confirmation before this rule is persisted.",
    );
    expect(screen).toContain("Ctrl+K field");
    modal.press("Enter");
    const result = await pending;
    expect(result.action).toBe("save");
    expect(result.rows[0]?.rule).toMatchObject({
      toolName: "opaque",
      inputs: [],
      guidance: "Tool-wide guidance",
    });
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

  it("dispatches production rule gestures through the domain state machine", async () => {
    const initial = {
      id: "read-0",
      origin: "existing" as const,
      rule: {
        toolName: "read",
        inputs: [
          {
            id: "read-0:clause",
            inputPath: "path",
            matcher: { kind: "glob" as const, pattern: "src/**" },
          },
        ],
        contexts: ["grep" as const],
        decision: "allow" as const,
      },
    };
    const domainOptions = {
      mode: "edit" as const,
      allowAddRemove: true,
      clearAvailable: true,
      builtin: {
        allowedTools: ["read"] as const,
        defaultTool: "read" as const,
      },
    };
    let expected: RuleEditorState = {
      baseline: [initial],
      rows: [initial],
      ...ruleEditorIdentityHistory({ rows: [initial] }),
      selected: 0,
      clause: 0,
      field: "pattern",
    };
    expected = transitionRuleEditor({
      state: expected,
      action: { type: "reset" },
      options: domainOptions,
    });
    expected = transitionRuleEditor({
      state: expected,
      action: {
        type: "add-clause",
        ruleId: initial.id,
        input: { inputPath: "", matcher: { kind: "glob", pattern: "" } },
      },
      options: domainOptions,
    });
    const added = expected.rows[0]?.rule.inputs[1];
    expect(added).toBeDefined();
    const rowWithAddedClause = expected.rows[0];
    if (added === undefined || rowWithAddedClause === undefined)
      throw new Error("domain did not add a clause");
    expected = transitionRuleEditor({
      state: expected,
      action: {
        type: "remove-clause",
        ruleId: initial.id,
        clauseId: added.id,
      },
      options: domainOptions,
    });
    expected = transitionRuleEditor({
      state: expected,
      action: { type: "set-decision", ruleId: initial.id, decision: "deny" },
      options: domainOptions,
    });
    expected = transitionRuleEditor({
      state: expected,
      action: { type: "toggle-context", ruleId: initial.id, context: "grep" },
      options: domainOptions,
    });
    expected = transitionRuleEditor({
      state: expected,
      action: { type: "toggle-context", ruleId: initial.id, context: "find" },
      options: domainOptions,
    });

    const harness = createExtensionHarness({ interactiveUi: true });
    const pending = editProfileRuleRows({
      ctx: harness.context,
      options: {
        mode: "edit",
        kind: "read",
        title: ruleSectionPresentation.read.label,
        rows: [
          {
            id: "read-0",
            kind: "read",
            pattern: "src/**",
            contexts: ["grep"],
            decision: "allow",
            origin: "existing",
          },
        ],
        allowAddRemove: true,
      },
    });
    const modal = await harness.ui.waitForRuleForm();
    modal.type(" changed");
    modal.press("CtrlShiftR");
    modal.press("CtrlA");
    modal.press("CtrlShiftD");
    modal.press("Tab");
    modal.press("CtrlX");
    modal.press("Enter");
    await expect(pending).resolves.toEqual({
      action: "save",
      rows: [
        expect.objectContaining({
          kind: "read",
          pattern: expected.rows[0]?.rule.inputs[0]?.matcher.pattern,
          decision: expected.rows[0]?.rule.decision,
          contexts: expected.rows[0]?.rule.contexts,
        }),
      ],
    });

    const askHarness = createExtensionHarness({ interactiveUi: true });
    const askPending = editProfileRuleRows({
      ctx: askHarness.context,
      options: {
        mode: "ask",
        kind: "bash",
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
    const askModal = await askHarness.ui.waitForRuleForm();
    askModal.press("Tab");
    askModal.press("Tab");
    askModal.press("Tab");
    askModal.press("Enter");
    expect(askModal.render().join("\n")).toContain(
      "Save disabled: every row is skipped",
    );
    askModal.press("Escape");
    await expect(askPending).resolves.toMatchObject({ action: "back" });
  });

  it("resets with Ctrl+Shift+R and clears profile sections with Ctrl+Shift+X", async () => {
    const harness = createExtensionHarness({ interactiveUi: true });
    const pending = editProfileRuleRows({
      ctx: harness.context,
      options: {
        mode: "edit",
        kind: "bash",
        title: ruleSectionPresentation.bash.label,
        rows: [
          {
            id: "bash-reset-clear",
            kind: "bash",
            pattern: "echo baseline",
            decision: "allow",
            origin: "existing",
          },
        ],
      },
    });
    const modal = await harness.ui.waitForRuleForm();
    modal.type(" changed");
    modal.press("CtrlShiftR");
    expect(modal.render(500).join("\n")).toContain("Ctrl+Shift+X clear");
    modal.press("CtrlShiftX");
    await expect(pending).resolves.toEqual({ action: "clear", rows: [] });
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

  it("keeps production rendering width-safe while Ctrl+K traverses editable built-in fields", async () => {
    const harness = createExtensionHarness({ interactiveUi: true });
    const pending = editProfileRuleRows({
      ctx: harness.context,
      options: {
        mode: "edit",
        kind: "read",
        title: ruleSectionPresentation.read.label,
        rows: [
          {
            id: "read-width",
            kind: "read",
            pattern: "資料/**",
            contexts: ["grep"],
            decision: "allow",
            origin: "existing",
          },
        ],
      },
    });
    const modal = await harness.ui.waitForRuleForm();
    for (const width of [20, 40, 80]) {
      const lines = modal.render(width);
      const overflow = lines.filter((line) => visibleWidth(line) > width);
      expect(overflow).toEqual([]);
    }
    // Target cycling returns structural focus to the visible matcher.
    modal.press("CtrlShiftK");
    modal.type(" changed");
    modal.press("CtrlK");
    modal.type("first");
    modal.press("Enter");
    await expect(pending).resolves.toMatchObject({
      action: "save",
      rows: [
        {
          // Glob patterns ignore leading and trailing spaces.
          pattern: "changed資料/**",
          guidance: "first",
          contexts: ["grep"],
        },
      ],
    });
  });

  it("renders hostile multiline guidance safely focused and unfocused without changing stored text", async () => {
    const guidance = "first\u001b[2J\u009b\u202e\nsecond";
    const harness = createExtensionHarness({ interactiveUi: true });
    const pending = editProfileRuleRows({
      ctx: harness.context,
      options: {
        mode: "edit",
        kind: "bash",
        title: "Guidance safety",
        rows: [
          {
            id: "safe-guidance",
            kind: "bash",
            pattern: "echo test",
            decision: "deny",
            origin: "existing",
            guidance,
          },
        ],
      },
    });
    void pending.catch(() => undefined);
    const modal = await harness.ui.waitForRuleForm();
    for (const focused of [false, true]) {
      if (focused) modal.press("CtrlK");
      const raw = modal.render().join("\n");
      for (const unsafe of ["\u001b[2J", "\u009b", "\u202e"])
        expect(raw).not.toContain(unsafe);
      const displayed = stripTerminalSequences(raw);
      expect(displayed).toContain("first\\u001b[2J\\u009b\\u202e");
      expect(displayed).toContain("second");
      expect(displayed).not.toContain("\\u000a");
    }
    modal.press("Enter");
    await expect(pending).resolves.toMatchObject({
      action: "save",
      rows: [{ guidance }],
    });
  });

  it.each([
    {
      label: "ordinary wrapped text",
      guidance: "a".repeat(60),
      rawIndex: 29,
      cursorPrefix: "a".repeat(29),
    },
    {
      label: "escape-expanded wrapping",
      guidance: `${"a".repeat(29)}\u001b${"b".repeat(30)}`,
      rawIndex: 30,
      cursorPrefix: "001b",
    },
  ])(
    "navigates sanitized visual guidance lines: $label",
    async ({ guidance, rawIndex, cursorPrefix }) => {
      const harness = createExtensionHarness({ interactiveUi: true });
      const pending = editProfileRuleRows({
        ctx: harness.context,
        options: {
          mode: "edit",
          kind: "bash",
          title: "Visual guidance navigation",
          rows: [
            {
              id: "visual-guidance",
              kind: "bash",
              pattern: "echo test",
              decision: "deny",
              origin: "existing",
              guidance,
            },
          ],
        },
      });
      void pending.catch(() => undefined);
      const modal = await harness.ui.waitForRuleForm();
      modal.press("CtrlK");
      modal.render(36);
      modal.press("ArrowUp");
      const up = modal.render(36).find((line) => line.includes(CURSOR_MARKER));
      expect(up).toBeDefined();
      expect(stripTerminalSequences((up ?? "").split(CURSOR_MARKER)[0])).toBe(
        `    ${cursorPrefix}`,
      );
      // Returning down must retain the preferred visual column even when Up
      // landed inside an escape and snapped to its nearest raw boundary.
      modal.press("ArrowDown");
      const down = modal
        .render(36)
        .find((line) => line.includes(CURSOR_MARKER));
      expect(
        stripTerminalSequences(
          (down ?? "").split(CURSOR_MARKER)[1] ?? "",
        ).trim(),
      ).toBe("");
      modal.press("ArrowUp");
      modal.render(36);
      modal.type("!");
      modal.press("Enter");
      await expect(pending).resolves.toMatchObject({
        action: "save",
        rows: [
          {
            guidance: `${guidance.slice(0, rawIndex)}!${guidance.slice(rawIndex)}`,
          },
        ],
      });
    },
  );

  it("pages through the sanitized guidance layout before inserting raw text", async () => {
    const guidance = "a".repeat(600);
    const harness = createExtensionHarness({ interactiveUi: true });
    const pending = editProfileRuleRows({
      ctx: harness.context,
      options: {
        mode: "edit",
        kind: "bash",
        title: "Guidance page navigation",
        rows: [
          {
            id: "page-guidance",
            kind: "bash",
            pattern: "echo test",
            decision: "deny",
            origin: "existing",
            guidance,
          },
        ],
      },
    });
    void pending.catch(() => undefined);
    const modal = await harness.ui.waitForRuleForm();
    modal.press("CtrlK");
    modal.render(36);
    modal.press("\u001b[5~");
    const up = modal.render(36).find((line) => line.includes(CURSOR_MARKER));
    expect(stripTerminalSequences((up ?? "").split(CURSOR_MARKER)[0])).toBe(
      `    ${"a".repeat(11)}`,
    );
    modal.press("\u001b[6~");
    modal.render(36);
    modal.press("\u001b[5~");
    modal.render(36);
    modal.type("!");
    modal.press("Enter");
    // At 31 layout columns: final row 19, column 11; a 15-row page
    // reaches visual row 4, raw index 4 * 31 + 11 = 135.
    await expect(pending).resolves.toMatchObject({
      action: "save",
      rows: [{ guidance: `${guidance.slice(0, 135)}!${guidance.slice(135)}` }],
    });
  });

  it("escapes hostile duplicate-path validation before styling", async () => {
    const inputPath = "key\u001b[2J\u009b\u202e";
    const harness = createExtensionHarness({ interactiveUi: true });
    const pending = editRules({
      ctx: harness.context,
      options: {
        mode: "edit",
        title: "Validation safety",
        rows: [
          {
            id: "duplicates",
            origin: "existing",
            rule: {
              toolName: "deploy",
              decision: "allow",
              inputs: [
                { inputPath, matcher: { kind: "glob", pattern: "one" } },
                { inputPath, matcher: { kind: "glob", pattern: "two" } },
              ],
            },
          },
        ],
      },
    });
    void pending.catch(() => undefined);
    const modal = await harness.ui.waitForRuleForm();
    const raw = modal.render().join("\n");
    for (const unsafe of ["\u001b[2J", "\u009b", "\u202e"])
      expect(raw).not.toContain(unsafe);
    const displayed = stripTerminalSequences(raw);
    expect(displayed).toContain("Save disabled:");
    expect(displayed).toContain("key\\u001b[2J\\u009b\\u202e");
    modal.press("Escape");
    await expect(pending).resolves.toMatchObject({ action: "back" });
  });

  it("maps a cursor after an escaped character in a narrow input and edits the raw value", async () => {
    const harness = createExtensionHarness({ interactiveUi: true });
    const pattern = "ab\u001b[2Jxyz";
    const pending = editProfileRuleRows({
      ctx: harness.context,
      options: {
        mode: "edit",
        kind: "bash",
        title: "Cursor mapping",
        rows: [
          {
            id: "cursor-map",
            kind: "bash",
            pattern,
            decision: "allow",
            origin: "existing",
          },
        ],
      },
    });
    void pending.catch(() => undefined);
    const modal = await harness.ui.waitForRuleForm();
    for (let i = 0; i < 3; i++) modal.press("ArrowRight");
    const lines = modal.render(36);
    expect(lines.every((line) => visibleWidth(line) <= 36)).toBe(true);
    const cursorLine = lines.find((line) => line.includes(CURSOR_MARKER));
    expect(cursorLine).toBeDefined();
    const [before, after] = (cursorLine ?? "").split(CURSOR_MARKER);
    expect(stripTerminalSequences(before)).toContain("ab\\u001b");
    expect(stripTerminalSequences(after ?? "")).toMatch(/^\[2Jxyz/u);
    modal.type("!");
    modal.press("ArrowLeft");
    modal.type("?");
    modal.press("Enter");
    await expect(pending).resolves.toMatchObject({
      action: "save",
      rows: [{ pattern: "ab\u001b?![2Jxyz" }],
    });
  });

  it("keeps one live cursor marker on the semantic built-in field", async () => {
    const harness = createExtensionHarness({ interactiveUi: true });
    const pending = editProfileRuleRows({
      ctx: harness.context,
      options: {
        mode: "edit",
        kind: "bash",
        title: ruleSectionPresentation.bash.label,
        rows: [
          {
            id: "bash-cursor",
            kind: "bash",
            pattern: "git status",
            decision: "allow",
            origin: "existing",
          },
        ],
      },
    });
    const modal = await harness.ui.waitForRuleForm();
    expect(modal.render().join("\n").split(CURSOR_MARKER)).toHaveLength(2);

    // Ctrl+K moves from the matcher to guidance; the marker follows it.
    modal.press("CtrlK");
    const guidance = modal.render().join("\n");
    expect(guidance.split(CURSOR_MARKER)).toHaveLength(2);
    expect(guidance.indexOf(CURSOR_MARKER)).toBeGreaterThan(
      guidance.indexOf("Guidance:"),
    );

    // A rebuilt adapter for a new implicit clause restores focus to its matcher.
    modal.press("CtrlA");
    const clause = modal.render().join("\n");
    expect(clause.split(CURSOR_MARKER)).toHaveLength(2);
    expect(clause.indexOf(CURSOR_MARKER)).toBeLessThan(
      clause.indexOf("Guidance:"),
    );
    modal.press("Escape");
    await expect(pending).resolves.toMatchObject({ action: "back" });
  });

  it("cycles inline ASK targets only through supported built-ins", async () => {
    const harness = createExtensionHarness({ interactiveUi: true });
    const pending = editProfileRuleRows({
      ctx: harness.context,
      options: {
        mode: "ask",
        title: "Resolve ASK",
        rows: [
          {
            id: "requested-bash",
            kind: "bash",
            pattern: "git status",
            decision: "allow",
            origin: "request",
          },
        ],
        allowAddRemove: true,
        defaultKind: "bash",
        defaultDecision: "deny",
      },
    });
    const modal = await harness.ui.waitForRuleForm();
    modal.press("CtrlN");
    modal.press("CtrlShiftK");
    expect(modal.render().join("\n")).toContain(
      ruleSectionPresentation.read.label,
    );
    modal.press("CtrlShiftK");
    expect(modal.render().join("\n")).toContain(
      ruleSectionPresentation.write.label,
    );
    modal.press("CtrlShiftK");
    const wrapped = modal.render().join("\n");
    expect(wrapped).toContain(ruleSectionPresentation.bash.label);
    expect(wrapped).not.toContain(ruleSectionPresentation.protected.label);
    modal.type("echo supported");
    modal.press("Tab");
    modal.press("Tab");
    modal.press("Enter");
    await expect(pending).resolves.toMatchObject({
      action: "save",
      rows: [
        expect.objectContaining({ kind: "bash", decision: "allow" }),
        expect.objectContaining({
          kind: "bash",
          pattern: "echo supported",
          decision: "allow",
        }),
      ],
    });
  });

  it("keeps expanded built-in contexts while adding an implicit clause", async () => {
    const harness = createExtensionHarness({ interactiveUi: true });
    const pending = editProfileRuleRows({
      ctx: harness.context,
      options: {
        mode: "edit",
        kind: "read",
        title: ruleSectionPresentation.read.label,
        rows: [
          {
            id: "read-context-expansion",
            kind: "read",
            pattern: "src/**",
            contexts: ["grep"],
            decision: "allow",
            origin: "existing",
          },
        ],
      },
    });
    const modal = await harness.ui.waitForRuleForm();
    modal.press("CtrlA");
    modal.type("tests/**");
    modal.press("Enter");
    await expect(pending).resolves.toMatchObject({
      action: "save",
      rows: [
        expect.objectContaining({ pattern: "src/**", contexts: ["grep"] }),
        expect.objectContaining({ pattern: "tests/**", contexts: ["grep"] }),
      ],
    });
  });

  it("does not copy untouched raw guidance to declarations expanded by Ctrl+A", async () => {
    const harness = createExtensionHarness({ interactiveUi: true });
    const pending = editProfileRuleRows({
      ctx: harness.context,
      options: {
        mode: "edit",
        kind: "bash",
        title: ruleSectionPresentation.bash.label,
        rows: [
          {
            id: "bash-provenance",
            kind: "bash",
            pattern: "git status",
            decision: "allow",
            guidance: "Existing raw guidance",
            origin: "existing",
          },
        ],
      },
    });
    const modal = await harness.ui.waitForRuleForm();
    modal.press("CtrlA");
    modal.type("git log");
    modal.press("Enter");
    const result = await pending;
    expect(result).toMatchObject({
      action: "save",
      rows: [
        { pattern: "git status", guidance: "Existing raw guidance" },
        { pattern: "git log" },
      ],
    });
    expect(result.rows[1]).not.toHaveProperty("guidance");
  });

  it("does not attach removed declaration guidance to a replacement clause", async () => {
    const harness = createExtensionHarness({ interactiveUi: true });
    const pending = editProfileRuleRows({
      ctx: harness.context,
      options: {
        mode: "edit",
        kind: "bash",
        title: ruleSectionPresentation.bash.label,
        rows: [
          {
            id: "bash-original-clause",
            kind: "bash",
            pattern: "git status",
            decision: "allow",
            guidance: "Only the original declaration owns this guidance.",
            origin: "existing",
          },
        ],
      },
    });
    const modal = await harness.ui.waitForRuleForm();
    modal.press("CtrlShiftD");
    modal.press("CtrlA");
    modal.type("git log");
    modal.press("Enter");
    await expect(pending).resolves.toEqual({
      action: "save",
      rows: [expect.objectContaining({ pattern: "git log" })],
    });
    const result = await pending;
    expect(result.rows[0]).not.toHaveProperty("guidance");
  });

  it("allows ASK for a custom tool literally named protected", async () => {
    const harness = createExtensionHarness({ interactiveUi: true });
    const pending = editRules({
      ctx: harness.context,
      options: { mode: "edit", title: "Custom protected", rows: [] },
    });
    const modal = await harness.ui.waitForRuleForm();
    modal.press("CtrlN");
    modal.type("protected");
    modal.press("CtrlK");
    modal.press("Tab"); // deny → ask for a custom tool, not the path adapter
    modal.press("Enter");
    await expect(pending).resolves.toMatchObject({
      action: "save",
      rows: [
        {
          rule: {
            toolName: "protected",
            decision: "ask",
          },
        },
      ],
    });
  });

  it("cycles newly added profile-edit rows through ASK", async () => {
    const harness = createExtensionHarness({ interactiveUi: true });
    const pending = editProfileRuleRows({
      ctx: harness.context,
      options: {
        mode: "edit",
        kind: "bash",
        title: ruleSectionPresentation.bash.label,
        rows: [],
      },
    });
    const modal = await harness.ui.waitForRuleForm();
    modal.press("CtrlN");
    modal.type("echo review");
    expect(modal.render().join("\n")).toContain("· DENY");
    modal.press("Tab"); // deny → ask
    expect(modal.render().join("\n")).toContain("· ASK");
    modal.press("Tab"); // ask → allow
    expect(modal.render().join("\n")).toContain("· ALLOW");
    modal.press("Enter");
    await expect(pending).resolves.toMatchObject({
      rows: [expect.objectContaining({ decision: "allow" })],
    });
  });

  it("edits multiline guidance with newline shortcuts without submitting", async () => {
    const harness = createExtensionHarness({ interactiveUi: true });
    const pending = editProfileRuleRows({
      ctx: harness.context,
      options: {
        mode: "edit",
        kind: "bash",
        title: ruleSectionPresentation.bash.label,
        rows: [
          {
            id: "bash-guidance",
            kind: "bash",
            pattern: "echo guidance",
            decision: "allow",
            origin: "existing",
          },
        ],
      },
    });
    const modal = await harness.ui.waitForRuleForm();
    modal.press("CtrlK");
    modal.type("first");
    modal.press("ShiftEnter");
    modal.type("second");

    expect(modal.render(24).join("\n")).toContain("first");
    expect(modal.render(24).join("\n")).toContain("second");
    modal.press("Enter");
    await expect(pending).resolves.toEqual({
      action: "save",
      rows: [expect.objectContaining({ guidance: "first\nsecond" })],
    });
  });

  it("takes a legacy terminal line feed as a guidance newline, not Save", async () => {
    const harness = createExtensionHarness({ interactiveUi: true });
    let settled = false;
    const pending = editProfileRuleRows({
      ctx: harness.context,
      options: {
        mode: "edit",
        kind: "bash",
        title: ruleSectionPresentation.bash.label,
        rows: [
          {
            id: "bash-guidance",
            kind: "bash",
            pattern: "echo guidance",
            decision: "deny",
            origin: "existing",
          },
        ],
      },
    }).finally(() => {
      settled = true;
    });
    const modal = await harness.ui.waitForRuleForm();
    modal.press("CtrlK");
    modal.type("first");
    // Ctrl+J, and unextended Shift/Ctrl+Enter, arrive as a raw "\n" that
    // pi-tui also matches as Enter.
    modal.press("LineFeed");
    modal.type("second");
    await Promise.resolve();
    expect(settled).toBe(false);

    modal.press("Enter");
    await expect(pending).resolves.toEqual({
      action: "save",
      rows: [expect.objectContaining({ guidance: "first\nsecond" })],
    });
  });

  it("edits a later clause after Ctrl+Right selects it", async () => {
    const harness = createExtensionHarness({ interactiveUi: true });
    const pending = editRules({
      ctx: harness.context,
      options: {
        mode: "ask",
        title: "Resolve ASK · deploy",
        lockedToolName: "deploy",
        rows: [
          {
            id: "request-deploy",
            origin: "request",
            rule: {
              toolName: "deploy",
              inputs: [
                {
                  inputPath: "environment",
                  matcher: { kind: "glob", pattern: "staging" },
                },
                {
                  inputPath: "region",
                  matcher: { kind: "glob", pattern: "eu" },
                },
              ],
              decision: "allow",
            },
          },
        ],
      },
    });
    const modal = await harness.ui.waitForRuleForm();
    // A prefilled Input's cursor starts before its value.
    modal.press("CtrlArrowRight");
    modal.type("*-");
    modal.press("CtrlArrowLeft");
    modal.type("1-");
    modal.press("Enter");

    const result = await pending;
    expect(result.action).toBe("save");
    expect(encodeCustomRuleGroups({ rows: result.rows })).toEqual({
      deploy: [
        {
          decision: "allow",
          match: { environment: "1-staging", region: "*-eu" },
        },
      ],
    });
  });

  it("leaves Up and Down to multiline guidance editing", async () => {
    const harness = createExtensionHarness({ interactiveUi: true });
    const pending = editProfileRuleRows({
      ctx: harness.context,
      options: {
        mode: "edit",
        kind: "bash",
        title: ruleSectionPresentation.bash.label,
        rows: [
          {
            id: "bash-guidance-up",
            kind: "bash",
            pattern: "echo guidance",
            decision: "allow",
            guidance: "first\nsecond",
            origin: "existing",
          },
        ],
      },
    });
    const modal = await harness.ui.waitForRuleForm();
    modal.press("CtrlK");
    modal.press("ArrowUp");
    modal.type("!");
    modal.press("Enter");
    await expect(pending).resolves.toMatchObject({
      rows: [expect.objectContaining({ guidance: "first!\nsecond" })],
    });
  });

  it("preserves blank lines from bracketed multiline guidance paste", async () => {
    const harness = createExtensionHarness({ interactiveUi: true });
    const pending = editProfileRuleRows({
      ctx: harness.context,
      options: {
        mode: "edit",
        kind: "bash",
        title: ruleSectionPresentation.bash.label,
        rows: [
          {
            id: "bash-paste",
            kind: "bash",
            pattern: "echo paste",
            decision: "allow",
            origin: "existing",
          },
        ],
      },
    });
    const modal = await harness.ui.waitForRuleForm();
    modal.press("CtrlK");
    modal.paste("\x1b[200~first\n\nsecond\x1b[201~");
    modal.press("Enter");

    await expect(pending).resolves.toEqual({
      action: "save",
      rows: [expect.objectContaining({ guidance: "first\n\nsecond" })],
    });
  });

  it("reopens multiline and explicitly empty guidance without changing either", async () => {
    const rows = [
      {
        id: "bash-multiline",
        kind: "bash" as const,
        pattern: "echo multiline",
        decision: "deny" as const,
        guidance: "first\nsecond",
        origin: "existing" as const,
      },
      {
        id: "bash-empty-guidance",
        kind: "bash" as const,
        pattern: "echo empty",
        decision: "deny" as const,
        guidance: "",
        origin: "existing" as const,
      },
    ];
    const harness = createExtensionHarness({ interactiveUi: true });
    const first = editProfileRuleRows({
      ctx: harness.context,
      options: {
        mode: "edit",
        kind: "bash",
        title: ruleSectionPresentation.bash.label,
        rows,
      },
    });
    const firstModal = await harness.ui.waitForRuleForm();
    expect(firstModal.render().join("\n")).toContain("first");
    firstModal.press("Enter");
    const saved = await first;
    expect(saved.rows).toEqual([
      expect.objectContaining({ guidance: "first\nsecond" }),
      expect.objectContaining({ guidance: "" }),
    ]);

    const reopened = editProfileRuleRows({
      ctx: harness.context,
      options: {
        mode: "edit",
        kind: "bash",
        title: ruleSectionPresentation.bash.label,
        rows: saved.rows,
      },
    });
    const reopenedModal = await harness.ui.waitForRuleForm();
    expect(reopenedModal.render().join("\n")).toContain("second");
    reopenedModal.press("Enter");
    await expect(reopened).resolves.toEqual({
      action: "save",
      rows: saved.rows,
    });
  });

  it("edits guidance on protected deny rules", async () => {
    const harness = createExtensionHarness({ interactiveUi: true });
    const pending = editProfileRuleRows({
      ctx: harness.context,
      options: {
        mode: "edit",
        kind: "protected",
        title: ruleSectionPresentation.protected.label,
        rows: [
          {
            id: "protected-deny",
            kind: "protected",
            pattern: ".env",
            decision: "deny",
            origin: "existing",
          },
        ],
      },
    });
    const modal = await harness.ui.waitForRuleForm();
    modal.press("CtrlK");
    modal.type("Do not read");
    modal.press("CtrlEnter");
    modal.type("or write.");
    modal.press("Enter");
    await expect(pending).resolves.toEqual({
      action: "save",
      rows: [
        expect.objectContaining({
          decision: "deny",
          guidance: "Do not read\nor write.",
        }),
      ],
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

  it("shows raw-glob prefill warnings and preserves raw matchers", async () => {
    const rawUrl = "https://example.test/search?q=one";
    const rawPath = "workspace\\reports\\today";
    const { candidates } = customToolInputCandidates({
      input: { url: rawUrl, resourcePath: rawPath },
    });
    const rows = [
      {
        id: "request-webfetch",
        origin: "request",
        rule: {
          toolName: "webfetch",
          inputs: candidates.map((candidate) => ({
            inputPath: candidate.inputPath,
            matcher: {
              kind: "glob" as const,
              pattern: candidate.initialPattern,
            },
          })),
          decision: "allow",
        },
      },
    ] as const satisfies readonly EditableRuleCreation[];
    const harness = createExtensionHarness({ interactiveUi: true });
    const pending = editRules({
      ctx: harness.context,
      options: {
        mode: "ask",
        title: "Resolve ASK · webfetch",
        lockedToolName: "webfetch",
        requestWarnings: candidates.flatMap(
          (candidate) => candidate.rawGlobWarning ?? [],
        ),
        rows,
      },
    });
    const modal = await harness.ui.waitForRuleForm();
    let result: Awaited<typeof pending> | undefined;
    let settled = false;
    try {
      // Styled warning text may close and reopen its ANSI decoration around
      // punctuation in the raw request value; assert the visible terminal text.
      const screen = modal
        .render(500)
        .join("\n")
        .replace(/\x1B\[[0-?]*[ -/]*[@-~]/gu, "")
        .replace(/\x1B_[^\x07\x1B]*(?:\x07|\x1B\\)/gu, "");
      expect(screen).toContain(rawGlobWarning({ inputPath: "url" }));
      expect(screen).toContain(rawGlobWarning({ inputPath: "resourcePath" }));
      expect(screen).toContain(rawUrl);
      expect(screen).toContain(rawPath);
      modal.press("Enter");
      result = await pending;
      settled = true;
    } finally {
      // An assertion failure must still settle the active harness modal.
      if (!settled) {
        modal.press("Escape");
        await pending;
      }
    }
    expect(result).toMatchObject({ action: "save" });
    expect(encodeCustomRuleGroups({ rows: result.rows })).toEqual({
      webfetch: [
        {
          decision: "allow",
          match: { url: rawUrl, resourcePath: rawPath },
        },
      ],
    });
  });

  it("shows the built-in changed-pattern safety warning in the production editor", async () => {
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
            request: {
              kind: "bash",
              requestedValue: "git status",
              initialPattern: "git status",
              currentDecision: "ask",
            },
          },
        ],
      },
    });
    const modal = await harness.ui.waitForRuleForm();
    modal.type(" *");
    expect(modal.render().join("\n")).toContain(
      "Broader/custom pattern: this rule may affect paths beyond this request.",
    );
    modal.press("Escape");
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
    expect(
      isBroaderPattern({
        pattern: row.pattern,
        pathMatch: row.pathMatch,
        request: row.request,
      }),
    ).toBe(true);
    expect(
      isBroaderPattern({
        pattern: "generated/a.ts",
        pathMatch: row.pathMatch,
        request: row.request,
      }),
    ).toBe(false);
  });
});
