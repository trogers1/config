import { profileAuthoringSelectedRowMarker } from "../../modules/profileAuthoringPresentation";
import type { createExtensionHarness } from "./extensionHarness";

type RuleEditorModal = Awaited<
  ReturnType<ReturnType<typeof createExtensionHarness>["ui"]["waitForRuleForm"]>
>;
type DecisionEditor = Pick<RuleEditorModal, "press" | "render">;

export const renderedRuleDecisionLabels = [
  "ALLOW",
  "ASK",
  "DENY",
  "SKIP",
] as const;
type RenderedRuleDecision = (typeof renderedRuleDecisionLabels)[number];

function isRenderedRuleDecision(
  decision: string,
): decision is RenderedRuleDecision {
  return renderedRuleDecisionLabels.some((label) => label === decision);
}

/** Reads the decision on the selected rule's header row. */
function renderedRuleDecision({ editor }: { readonly editor: DecisionEditor }) {
  const decisions = editor
    .render()
    .filter((line) => line.startsWith(profileAuthoringSelectedRowMarker))
    .flatMap((line) => [...line.matchAll(/ · ([A-Z]+)\b/g)])
    .map((match) => match[1] ?? "");
  if (decisions.length !== 1)
    throw new Error(
      `Expected one selected rule decision; found ${decisions.length}`,
    );
  const [decision] = decisions;
  if (decision === undefined || !isRenderedRuleDecision(decision))
    throw new Error(`Unexpected rendered rule decision: ${decision ?? "none"}`);
  return decision;
}

/** Cycles the production editor's rendered decision state, with a hard bound. */
export function setRenderedRuleDecisionToAllow({
  editor,
}: {
  readonly editor: DecisionEditor;
}): void {
  for (
    let attempt = 0;
    attempt < renderedRuleDecisionLabels.length;
    attempt++
  ) {
    if (renderedRuleDecision({ editor }) === "ALLOW") return;
    editor.press("Tab");
  }
  throw new Error(
    `Rule decision did not reach ALLOW after ${renderedRuleDecisionLabels.length} Tab presses`,
  );
}

/**
 * The single production-UI script used to author the same custom declaration
 * from inline ASK and both profile authoring entry points. It deliberately
 * drives only the editor's public keyboard surface.
 */
export async function authorSubagentAllowRule({
  harness,
  removeInitialRule = false,
}: {
  readonly harness: ReturnType<typeof createExtensionHarness>;
  /** Inline ASK opens with request-derived rows; replace rather than retain it. */
  readonly removeInitialRule?: boolean;
}): Promise<RuleEditorModal> {
  const editor = await harness.ui.waitForRuleForm();
  if (removeInitialRule) editor.press("CtrlD");

  editor.press("CtrlN");
  // ASK locks its invoked target. Profile authoring exposes the same field.
  if (editor.render().join("\n").includes("Tool ")) editor.type("subagent");

  for (const [inputPath, pattern] of [
    ["agent", "*"],
    ["task", "*"],
    ["cwd", "~/Code/config/**"],
  ] as const) {
    editor.press("CtrlA");
    editor.type(inputPath);
    editor.press("CtrlK");
    editor.type(pattern);
  }

  setRenderedRuleDecisionToAllow({ editor });
  if (renderedRuleDecision({ editor }) !== "ALLOW")
    throw new Error("Rule decision must be ALLOW before saving");
  editor.press("Enter");
  return editor;
}
