import type { RuleKind } from "./profileConfig";

/** User-facing authoring copy shared by CREATE, EDIT, and their forms. */
export type PurposePresentationSpan = {
  readonly kind: "normal" | "deny" | "allow";
  readonly text: string;
};

type SectionPresentation = {
  readonly label: string;
  readonly purpose: string;
  readonly purposePresentation: readonly PurposePresentationSpan[];
  readonly examples: string;
  readonly syntax: string;
};

type PurposeSpanStyles = {
  readonly normal: (text: string) => string;
  readonly deny: (text: string) => string;
  readonly allow: (text: string) => string;
};

/** Joins ordered semantic purpose spans before ANSI-safe wrapping. */
function purposePresentationText({
  purpose,
}: {
  readonly purpose: readonly PurposePresentationSpan[];
}): string {
  return purpose.map((span) => span.text).join("");
}

export function renderPurposePresentation({
  purpose,
  styles,
}: {
  readonly purpose: readonly PurposePresentationSpan[];
  readonly styles: PurposeSpanStyles;
}): string {
  return purpose.map((span) => styles[span.kind](span.text)).join("");
}
export type RuleSectionPresentation = SectionPresentation;
export type MetadataSectionKind = "sandbox" | "directoryGlobs";
export type MetadataSectionPresentation = SectionPresentation;
export type GeneralSectionPresentation = SectionPresentation;
export type PromptSectionPresentation = SectionPresentation;

const pathRuleSyntax =
  "Path syntax: * matches within one segment; ** matches directories.";
const bashRuleSyntax =
  "Pattern syntax: * matches any characters, including spaces or slashes; ? matches one non-whitespace character.";
const sandboxPathSyntax =
  "Path syntax: entries are sandbox paths, not policy globs.";
const directoryGlobSyntax =
  "Path syntax: * stays in one segment; ** matches complete directory segments.";

const protectedPurposePresentation = [
  { kind: "deny", text: "🚫 DENY" },
  { kind: "normal", text: " blocks both reads and writes. " },
  { kind: "allow", text: "✅ ALLOW" },
  {
    kind: "normal",
    text: " only exempts a broader safeguard; it grants no normal access.",
  },
] as const satisfies readonly PurposePresentationSpan[];

export const ruleSectionPresentation = {
  bash: {
    label: "⚙️ Bash rules",
    purpose:
      "Matches normalized Bash command segments. Command authorization is separate from filesystem access.",
    purposePresentation: [
      {
        kind: "normal",
        text: "Matches normalized Bash command segments. Command authorization is separate from filesystem access.",
      },
    ],
    examples: "Examples: git status; npm test *.",
    syntax: bashRuleSyntax,
  },
  read: {
    label: "📖 Read-path rules",
    purpose:
      "Controls read, grep, find, and ls paths; patterns are startup-relative unless absolute.",
    purposePresentation: [
      {
        kind: "normal",
        text: "Controls read, grep, find, and ls paths; patterns are startup-relative unless absolute.",
      },
    ],
    examples: "Example: docs/**/*.md.",
    syntax: pathRuleSyntax,
  },
  write: {
    label: "✏️ Write-path rules",
    purpose:
      "Controls edit/write and analyzable Bash filesystem references and context.",
    purposePresentation: [
      {
        kind: "normal",
        text: "Controls edit/write and analyzable Bash filesystem references and context.",
      },
    ],
    examples: "Example: src/**/*.ts.",
    syntax: pathRuleSyntax,
  },
  protected: {
    label: "🛡️ Protected safeguards",
    purpose: purposePresentationText({
      purpose: protectedPurposePresentation,
    }),
    purposePresentation: protectedPurposePresentation,
    examples: "Examples: **/.env*; .env.template.",
    syntax: pathRuleSyntax,
  },
} as const satisfies Record<RuleKind, RuleSectionPresentation>;

export const generalSectionPresentation = {
  label: "⚙️ General",
  purpose:
    "Names and describes this user-owned profile and controls its optional emoji and color.",
  purposePresentation: [
    {
      kind: "normal",
      text: "Names and describes this user-owned profile and controls its optional emoji and color.",
    },
  ],
  examples: "Examples: client-work, review-tools.",
  syntax:
    "Name and description are required; blank emoji and inherited color omit local declarations.",
} as const satisfies GeneralSectionPresentation;

export const promptSectionPresentation = {
  label: "📝 Prompt instructions",
  purpose:
    "Adds profile-specific text to Pi's system prompt. It changes model instructions; it does not grant tool permissions.",
  purposePresentation: [
    {
      kind: "normal",
      text: "Adds profile-specific text to Pi's system prompt. It changes model instructions; it does not grant tool permissions.",
    },
  ],
  examples:
    "Examples: ~/.pi/agent/prompts/client-work.md; /Users/alice/policies/release.md.",
  syntax:
    "Choose inherit, disable, or a readable absolute/~/ UTF-8 file no larger than 256 KiB.",
} as const satisfies PromptSectionPresentation;

export const compositionSectionLabel = "🧬 Composition";
export const transformsSectionLabel = "🔀 Transforms";

export const metadataSectionPresentation = {
  sandbox: {
    label: "🔐 Sandbox",
    purpose:
      "OS containment for approved Bash and its children, not Pi's in-process tools.",
    purposePresentation: [
      {
        kind: "normal",
        text: "OS containment for approved Bash and its children, not Pi's in-process tools.",
      },
    ],
    examples: "Path examples: build-cache, temporary paths, or token paths.",
    syntax: sandboxPathSyntax,
  },
  directoryGlobs: {
    label: "🎬 Startup Directory globs",
    purpose:
      "Activates a profile when an ancestor/project root matches Pi's immutable startup CWD.",
    purposePresentation: [
      {
        kind: "normal",
        text: "Activates a profile when an ancestor/project root matches Pi's immutable startup CWD.",
      },
    ],
    examples: "Examples: ~/Code/client, /work/*/frontend, /srv/**/service.",
    syntax: directoryGlobSyntax,
  },
} as const satisfies Record<MetadataSectionKind, MetadataSectionPresentation>;

const metadataConfirmationSuffix = {
  sandbox: "capability expansion",
  directoryGlobs: "activation",
} as const satisfies Record<MetadataSectionKind, string>;

export function metadataConfirmationTitle({
  kind,
}: {
  readonly kind: MetadataSectionKind;
}): string {
  return `Confirm ${metadataSectionPresentation[kind].label} ${metadataConfirmationSuffix[kind]}`;
}

export type ProfileAuthoringAction = "create" | "save";
const profileAuthoringActionPresentation = {
  create: "✅ Create and activate profile",
  save: "✅ Save profile changes",
} as const satisfies Record<ProfileAuthoringAction, string>;
export const profileSettingsHeading = "Profile settings";
export const profileDraftDiscardTitle = "Discard profile draft?";
export const profileAuthoringInvalidMarker = "Invalid:";

export function postSaveActivationFailureMessage({
  profile,
  error,
}: {
  readonly profile: string;
  readonly error: unknown;
}): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `Profile '${profile}' was saved, but reloading or activating it failed: ${detail}`;
}
export const profileAuthoringSelectedRowMarker = "→ ";
export const profileAuthoringUnselectedRowMarker = " ".repeat(
  profileAuthoringSelectedRowMarker.length,
);

export function profileAuthoringAction({
  action,
}: {
  readonly action: ProfileAuthoringAction;
}): string {
  return profileAuthoringActionPresentation[action];
}

export function profileAuthoringSectionOption({
  label,
  summary,
}: {
  readonly label: string;
  readonly summary: string;
}): string {
  return `${label} (${summary}) · Edit`;
}

export function localProfileDeclarationCount({
  count,
}: {
  readonly count: number;
}): string {
  return `${count} local`;
}

export function ruleSectionOption({
  kind,
  count,
}: {
  readonly kind: RuleKind;
  readonly count: number;
}): string {
  return profileAuthoringSectionOption({
    label: ruleSectionPresentation[kind].label,
    summary: localProfileDeclarationCount({ count }),
  });
}

/** General's summary is the mutable identity, not a redundant field count. */
export function generalSectionOption({
  emoji,
  name,
}: {
  readonly emoji: string | undefined;
  readonly name: string;
}): string {
  return `${generalSectionPresentation.label} (${formatWizardProfileIdentity({ emoji, name })}) · Edit`;
}

/** Plain text only: stock ui.select applies its own rendering. */
export function formatWizardProfileIdentity({
  emoji,
  name,
}: {
  readonly emoji: string | undefined;
  readonly name: string;
}): string {
  return emoji ? `${emoji} ${name}` : name;
}
