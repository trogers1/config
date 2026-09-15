import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  decodeSandboxAuthoring,
  serializeDirectoryGlobs,
  serializeSandboxAuthoring,
} from "./profileAuthoring";
import type { ProfileAuthoringFlow } from "./profileAuthoringFlow";
import {
  decodePromptAuthoring,
  profileAuthoringDraftIsDirty,
  profileAuthoringSectionIds,
  serializePromptAuthoring,
  type ProfileAuthoringDraft,
  type ProfileAuthoringSectionId,
  type ProfileAuthoringValidationIssue,
} from "./profileAuthoringModel";
import {
  compositionSectionLabel,
  formatWizardProfileIdentity,
  generalSectionPresentation,
  localProfileDeclarationCount,
  metadataSectionPresentation,
  profileAuthoringInvalidMarker,
  profileAuthoringSectionOption,
  profileDraftDiscardTitle,
  promptSectionPresentation,
  ruleSectionPresentation,
  transformsSectionLabel,
} from "./profileAuthoringPresentation";
import {
  showProfileAuthoringOverview,
  type ProfileAuthoringOverviewDescriptor,
} from "./profileAuthoringOverview";
import { editProfileGeneral } from "./profileGeneralEditor";
import { editProfilePrompt } from "./profilePromptEditor";
import {
  editOrderedSelection,
  type OrderedSelectionOption,
} from "./profileOrderedSelectionEditor";
import {
  editDirectoryGlobs,
  editSandboxDeclaration,
} from "./profileMetadataEditor";
import {
  editProfileRuleSection,
  profileRuleEditRows,
} from "./profileRuleEditor";
import type {
  ProfileConfigProfile,
  ProfileTransformName,
  SandboxConfigOverride,
} from "./policyHelpers";

export type ProfileAuthoringSubmitResult =
  | { readonly status: "saved" }
  | {
      readonly status: "invalid";
      readonly issues: readonly ProfileAuthoringValidationIssue[];
    }
  | { readonly status: "retry" };

type SectionEditContext = {
  readonly ctx: ExtensionContext;
  readonly flow: ProfileAuthoringFlow;
  readonly startupCwd: string;
  readonly compositionOptions: readonly OrderedSelectionOption<string>[];
  readonly transformOptions: readonly OrderedSelectionOption<ProfileTransformName>[];
  readonly resolvedParentSandbox: ({
    composition,
  }: {
    readonly composition: readonly string[];
  }) => SandboxConfigOverride | false | undefined;
  readonly validateName: ({
    name,
  }: {
    readonly name: string;
  }) => string | undefined;
};

type SectionDefinition<Id extends ProfileAuthoringSectionId> = {
  readonly id: Id;
  readonly label: string;
  summary: ({ draft }: { readonly draft: ProfileAuthoringDraft }) => string;
  edit: ({
    draft,
    context,
    issues,
  }: {
    readonly draft: ProfileAuthoringDraft;
    readonly context: SectionEditContext;
    readonly issues?: readonly ProfileAuthoringValidationIssue[];
  }) => Promise<ProfileAuthoringDraft>;
};
type SectionRegistry = {
  readonly [Id in ProfileAuthoringSectionId]: SectionDefinition<Id>;
};

function defineSectionRegistry<Registry extends SectionRegistry>({
  registry,
}: {
  readonly registry: Registry;
}): Registry {
  return registry;
}

function withDefinition({
  draft,
  definition,
}: {
  readonly draft: ProfileAuthoringDraft;
  readonly definition: ProfileAuthoringDraft["definition"];
}): ProfileAuthoringDraft {
  return { ...draft, definition };
}

function sectionTitle({
  label,
  draft,
  issues,
}: {
  readonly label: string;
  readonly draft: ProfileAuthoringDraft;
  readonly issues?: readonly ProfileAuthoringValidationIssue[];
}): string {
  const identity = formatWizardProfileIdentity({
    emoji: draft.definition.emoji,
    name: draft.name,
  });
  const validation =
    issues && issues.length > 0
      ? ` · ${profileAuthoringInvalidMarker} ${issues.map(({ message }) => message).join("; ")}`
      : "";
  return `${label} for ${identity}${validation}`;
}

function ruleCount({
  definition,
  kind,
}: {
  readonly definition: ProfileConfigProfile;
  readonly kind: "bash" | "read" | "write" | "protected";
}): number {
  if (kind === "bash") return definition.tools?.bash?.length ?? 0;
  if (kind === "read") return definition.readPaths?.length ?? 0;
  if (kind === "write") return definition.writePaths?.length ?? 0;
  return definition.protectedPathRules?.length ?? 0;
}

const sectionRegistry = defineSectionRegistry({
  registry: {
    general: {
      id: "general",
      label: generalSectionPresentation.label,
      summary: ({ draft }) =>
        formatWizardProfileIdentity({
          emoji: draft.definition.emoji,
          name: draft.name,
        }),
      edit: async ({ draft, context, issues }) => {
        const result = await editProfileGeneral({
          ctx: context.ctx,
          custom: context.flow.custom,
          initial: {
            mode: draft.mode,
            name: draft.name,
            description: draft.definition.description,
            emoji: draft.definition.emoji ?? "",
            color: draft.definition.color,
          },
          title: sectionTitle({
            label: generalSectionPresentation.label,
            draft,
            issues,
          }),
          validateName: context.validateName,
        });
        if (!result || result.action === "cancel") return draft;
        return {
          ...draft,
          name: result.draft.name,
          definition: {
            ...draft.definition,
            description: result.draft.description,
            emoji: result.draft.emoji || undefined,
            color: result.draft.color,
          },
        };
      },
    },
    prompt: {
      id: "prompt",
      label: promptSectionPresentation.label,
      summary: ({ draft }) => {
        const prompt = decodePromptAuthoring({
          promptFile: draft.definition.promptFile,
        });
        return prompt.mode === "file" ? prompt.path : prompt.mode;
      },
      edit: async ({ draft, context, issues }) => {
        const result = await editProfilePrompt({
          ctx: context.ctx,
          custom: context.flow.custom,
          profile: draft.name,
          initial: decodePromptAuthoring({
            promptFile: draft.definition.promptFile,
          }),
          title: sectionTitle({
            label: promptSectionPresentation.label,
            draft,
            issues,
          }),
        });
        return result
          ? withDefinition({
              draft,
              definition: {
                ...draft.definition,
                promptFile: serializePromptAuthoring({ value: result.draft }),
              },
            })
          : draft;
      },
    },
    composition: {
      id: "composition",
      label: compositionSectionLabel,
      summary: ({ draft }) =>
        draft.definition.extends?.join(", ") ?? "standalone",
      edit: async ({ draft, context, issues }) => {
        const result = await editOrderedSelection({
          ctx: context.ctx,
          custom: context.flow.custom,
          title: sectionTitle({
            label: compositionSectionLabel,
            draft,
            issues,
          }),
          initial:
            draft.definition.extends === undefined
              ? { mode: "omit" }
              : { mode: "set", value: draft.definition.extends },
          options: context.compositionOptions,
          explicitEmpty: false,
        });
        if (!result) return draft;
        return withDefinition({
          draft,
          definition: {
            ...draft.definition,
            extends:
              result.draft.mode === "set" && result.draft.value.length > 0
                ? [...result.draft.value]
                : undefined,
          },
        });
      },
    },
    transforms: {
      id: "transforms",
      label: transformsSectionLabel,
      summary: ({ draft }) =>
        draft.definition.transforms === undefined
          ? "omitted"
          : localProfileDeclarationCount({
              count: draft.definition.transforms.length,
            }),
      edit: async ({ draft, context, issues }) => {
        const result = await editOrderedSelection({
          ctx: context.ctx,
          custom: context.flow.custom,
          title: sectionTitle({ label: transformsSectionLabel, draft, issues }),
          initial:
            draft.definition.transforms === undefined
              ? { mode: "omit" }
              : { mode: "set", value: draft.definition.transforms },
          options: context.transformOptions,
          explicitEmpty: true,
        });
        if (!result) return draft;
        return withDefinition({
          draft,
          definition: {
            ...draft.definition,
            transforms:
              result.draft.mode === "set" ? [...result.draft.value] : undefined,
          },
        });
      },
    },
    bash: {
      id: "bash",
      label: ruleSectionPresentation.bash.label,
      summary: ({ draft }) =>
        localProfileDeclarationCount({
          count: ruleCount({ definition: draft.definition, kind: "bash" }),
        }),
      edit: async ({ draft, context, issues }) => {
        const initial = draft.definition.tools?.bash;
        const result = await editProfileRuleSection({
          ctx: context.ctx,
          custom: context.flow.custom,
          mode: draft.mode,
          kind: "bash",
          initial: profileRuleEditRows("bash", initial ?? []),
          preserveExplicitEmpty: initial !== undefined,
          title: sectionTitle({
            label: ruleSectionPresentation.bash.label,
            draft,
            issues,
          }),
        });
        const tools = draft.definition.tools ?? {};
        const nextTools = { ...tools };
        if (result.edit.mode === "omit") delete nextTools.bash;
        else nextTools.bash = result.edit.value;
        return withDefinition({
          draft,
          definition: {
            ...draft.definition,
            tools: Object.keys(nextTools).length > 0 ? nextTools : undefined,
          },
        });
      },
    },
    read: {
      id: "read",
      label: ruleSectionPresentation.read.label,
      summary: ({ draft }) =>
        localProfileDeclarationCount({
          count: ruleCount({ definition: draft.definition, kind: "read" }),
        }),
      edit: async ({ draft, context, issues }) => {
        const initial = draft.definition.readPaths;
        const result = await editProfileRuleSection({
          ctx: context.ctx,
          custom: context.flow.custom,
          mode: draft.mode,
          kind: "read",
          initial: profileRuleEditRows("read", initial ?? []),
          preserveExplicitEmpty: initial !== undefined,
          title: sectionTitle({
            label: ruleSectionPresentation.read.label,
            draft,
            issues,
          }),
        });
        return withDefinition({
          draft,
          definition: {
            ...draft.definition,
            readPaths:
              result.edit.mode === "set" ? result.edit.value : undefined,
          },
        });
      },
    },
    write: {
      id: "write",
      label: ruleSectionPresentation.write.label,
      summary: ({ draft }) =>
        localProfileDeclarationCount({
          count: ruleCount({ definition: draft.definition, kind: "write" }),
        }),
      edit: async ({ draft, context, issues }) => {
        const initial = draft.definition.writePaths;
        const result = await editProfileRuleSection({
          ctx: context.ctx,
          custom: context.flow.custom,
          mode: draft.mode,
          kind: "write",
          initial: profileRuleEditRows("write", initial ?? []),
          preserveExplicitEmpty: initial !== undefined,
          title: sectionTitle({
            label: ruleSectionPresentation.write.label,
            draft,
            issues,
          }),
        });
        return withDefinition({
          draft,
          definition: {
            ...draft.definition,
            writePaths:
              result.edit.mode === "set" ? result.edit.value : undefined,
          },
        });
      },
    },
    protected: {
      id: "protected",
      label: ruleSectionPresentation.protected.label,
      summary: ({ draft }) =>
        localProfileDeclarationCount({
          count: ruleCount({ definition: draft.definition, kind: "protected" }),
        }),
      edit: async ({ draft, context, issues }) => {
        const initial = draft.definition.protectedPathRules;
        const result = await editProfileRuleSection({
          ctx: context.ctx,
          custom: context.flow.custom,
          mode: draft.mode,
          kind: "protected",
          initial: profileRuleEditRows("protected", initial ?? []),
          preserveExplicitEmpty: initial !== undefined,
          title: sectionTitle({
            label: ruleSectionPresentation.protected.label,
            draft,
            issues,
          }),
        });
        return withDefinition({
          draft,
          definition: {
            ...draft.definition,
            protectedPathRules:
              result.edit.mode === "set" ? result.edit.value : undefined,
          },
        });
      },
    },
    sandbox: {
      id: "sandbox",
      label: metadataSectionPresentation.sandbox.label,
      summary: ({ draft }) =>
        decodeSandboxAuthoring({ raw: draft.definition.sandbox }).mode,
      edit: async ({ draft, context, issues }) => {
        const composition = draft.definition.extends ?? [];
        const result = await editSandboxDeclaration({
          ctx: context.ctx,
          custom: context.flow.custom,
          initial: decodeSandboxAuthoring({ raw: draft.definition.sandbox }),
          resolvedParent: context.resolvedParentSandbox({ composition }),
          title: sectionTitle({
            label: metadataSectionPresentation.sandbox.label,
            draft,
            issues,
          }),
        });
        return result
          ? withDefinition({
              draft,
              definition: {
                ...draft.definition,
                sandbox: serializeSandboxAuthoring({ value: result.draft }),
              },
            })
          : draft;
      },
    },
    directoryGlobs: {
      id: "directoryGlobs",
      label: metadataSectionPresentation.directoryGlobs.label,
      summary: ({ draft }) =>
        localProfileDeclarationCount({
          count: draft.definition.directoryGlobs?.length ?? 0,
        }),
      edit: async ({ draft, context, issues }) => {
        const result = await editDirectoryGlobs({
          ctx: context.ctx,
          custom: context.flow.custom,
          initial:
            draft.definition.directoryGlobs === undefined
              ? { mode: "omit" }
              : { mode: "set", value: draft.definition.directoryGlobs },
          startupCwd: context.startupCwd,
          title: sectionTitle({
            label: metadataSectionPresentation.directoryGlobs.label,
            draft,
            issues,
          }),
        });
        return result
          ? withDefinition({
              draft,
              definition: {
                ...draft.definition,
                directoryGlobs: serializeDirectoryGlobs({
                  value: result.draft,
                }),
              },
            })
          : draft;
      },
    },
  } satisfies SectionRegistry,
});

function overviewDescriptor({
  draft,
  issues,
}: {
  readonly draft: ProfileAuthoringDraft;
  readonly issues: readonly ProfileAuthoringValidationIssue[];
}): ProfileAuthoringOverviewDescriptor {
  return {
    mode: draft.mode,
    identity: {
      name: draft.name,
      emoji: draft.definition.emoji,
    },
    details: [`Description: ${draft.definition.description || "required"}`],
    sections: profileAuthoringSectionIds.map((id) => {
      const section = sectionRegistry[id];
      const sectionIssues = issues.filter((issue) => issue.section === id);
      const warning = sectionIssues
        .map(({ message }) => ` ⚠ ${profileAuthoringInvalidMarker} ${message}`)
        .join("");
      return {
        id,
        label: `${profileAuthoringSectionOption({
          label: section.label,
          summary: section.summary({ draft }),
        })}${warning}`,
      };
    }),
  };
}

export async function runProfileAuthoringWizard({
  ctx,
  flow,
  initial,
  startupCwd,
  compositionOptions,
  transformOptions,
  resolvedParentSandbox,
  validateName,
  submit,
}: {
  readonly ctx: ExtensionContext;
  readonly flow: ProfileAuthoringFlow;
  readonly initial: ProfileAuthoringDraft;
  readonly startupCwd: string;
  readonly compositionOptions: readonly OrderedSelectionOption<string>[];
  readonly transformOptions: readonly OrderedSelectionOption<ProfileTransformName>[];
  readonly resolvedParentSandbox: SectionEditContext["resolvedParentSandbox"];
  readonly validateName: SectionEditContext["validateName"];
  readonly submit: ({
    draft,
  }: {
    readonly draft: ProfileAuthoringDraft;
  }) => Promise<ProfileAuthoringSubmitResult>;
}): Promise<void> {
  let draft = initial;
  let issues: readonly ProfileAuthoringValidationIssue[] = [];
  const context: SectionEditContext = {
    ctx,
    flow,
    startupCwd,
    compositionOptions,
    transformOptions,
    resolvedParentSandbox,
    validateName,
  };
  while (!flow.signal.aborted) {
    const selection = await showProfileAuthoringOverview({
      ctx,
      custom: flow.custom,
      descriptor: overviewDescriptor({ draft, issues }),
    });
    if (flow.signal.aborted) return;
    if (!selection) {
      if (!profileAuthoringDraftIsDirty({ draft, initial })) return;
      const discard = await flow.confirm({
        title: profileDraftDiscardTitle,
        message:
          "No profile changes have been written. Discard the complete draft?",
      });
      if (typeof discard === "boolean" && discard) return;
      continue;
    }
    if (selection.kind === "section") {
      const section = sectionRegistry[selection.id];
      draft = await section.edit({
        draft,
        context,
        issues: issues.filter((issue) => issue.section === selection.id),
      });
      issues = issues.filter((issue) => issue.section !== selection.id);
      continue;
    }
    const result = await submit({ draft });
    if (result.status === "saved") return;
    if (result.status === "retry") continue;
    issues = result.issues;
    const firstIssue = profileAuthoringSectionIds
      .map((id) => issues.find((candidate) => candidate.section === id))
      .find((candidate) => candidate !== undefined);
    if (!firstIssue) continue;
    const section = sectionRegistry[firstIssue.section];
    draft = await section.edit({
      draft,
      context,
      issues: issues.filter((issue) => issue.section === firstIssue.section),
    });
    issues = issues.filter((issue) => issue.section !== firstIssue.section);
  }
}
