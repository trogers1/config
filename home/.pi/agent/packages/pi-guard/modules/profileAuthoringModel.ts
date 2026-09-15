import path from "node:path";
import { Type, type Static } from "typebox";
import { validateDirectoryGlobs } from "./directoryGlobs";
import {
  customProfileNamePattern,
  parseOrThrow,
  profileConfigProfileSchema,
  type ProfileConfigProfile,
} from "./policyHelpers";

export const profileAuthoringSectionIds = [
  "general",
  "prompt",
  "composition",
  "transforms",
  "bash",
  "read",
  "write",
  "protected",
  "sandbox",
  "directoryGlobs",
] as const;
export type ProfileAuthoringSectionId =
  (typeof profileAuthoringSectionIds)[number];

export type ProfileAuthoringValidationIssueCode =
  | "invalid-name"
  | "profile-exists"
  | "invalid-prompt-file"
  | "invalid-composition"
  | "cyclic-composition"
  | "invalid-transforms"
  | "overlapping-rules"
  | "invalid-rule"
  | "invalid-sandbox"
  | "invalid-directory-globs"
  | "invalid-profile";
export type ProfileAuthoringValidationIssue = {
  readonly section: ProfileAuthoringSectionId;
  readonly code: ProfileAuthoringValidationIssueCode;
  readonly message: string;
};

const authoringProfileDefinitionSchema = Type.Object(
  {
    ...profileConfigProfileSchema.properties,
    description: Type.String(),
  },
  {
    additionalProperties: false,
    dependentRequired: { transforms: ["extends"] },
  },
);

const profileAuthoringNameSchema = Type.String({
  pattern: customProfileNamePattern,
});

const profileAuthoringCreateDraftSchema = Type.Object(
  {
    mode: Type.Literal("create"),
    name: profileAuthoringNameSchema,
    definition: authoringProfileDefinitionSchema,
  },
  { additionalProperties: false },
);
const profileAuthoringEditDraftSchema = Type.Object(
  {
    mode: Type.Literal("edit"),
    originalName: profileAuthoringNameSchema,
    name: profileAuthoringNameSchema,
    definition: authoringProfileDefinitionSchema,
  },
  { additionalProperties: false },
);
export type ProfileAuthoringDraft =
  | Static<typeof profileAuthoringCreateDraftSchema>
  | Static<typeof profileAuthoringEditDraftSchema>;

type ProfileGeneralDraftFor<Draft extends ProfileAuthoringDraft> = {
  readonly mode: Draft["mode"];
  readonly name: Draft["name"];
  readonly description: Draft["definition"]["description"];
  readonly emoji: NonNullable<Draft["definition"]["emoji"]> | "";
  readonly color?: Draft["definition"]["color"];
};
export type ProfileGeneralDraft = ProfileAuthoringDraft extends infer Draft
  ? Draft extends ProfileAuthoringDraft
    ? ProfileGeneralDraftFor<Draft>
    : never
  : never;

export const defaultCustomProfileEmoji = "💅";

export type ProfilePromptAuthoring =
  | { readonly mode: "inherit" }
  | { readonly mode: "disable" }
  | { readonly mode: "file"; readonly path: string };

const suggestedNameFallbacks = {
  profile: "profile",
  directory: "directory",
} as const;
const firstCollisionSuffix = 2;

function suggestedNameStem({
  value,
  fallback,
}: {
  readonly value: string;
  readonly fallback: string;
}): string {
  return value.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "") || fallback;
}

/** Existing child-profile suggestion rules, parameterized for shared CREATE. */
export function suggestedProfileName({
  profile,
  cwd,
  existingNames,
}: {
  readonly profile: string;
  readonly cwd: string;
  readonly existingNames: ReadonlySet<string>;
}): string {
  const profileStem = suggestedNameStem({
    value: profile.replace(/^builtin:/, ""),
    fallback: suggestedNameFallbacks.profile,
  });
  const directoryStem = suggestedNameStem({
    value: path.basename(path.resolve(cwd)),
    fallback: suggestedNameFallbacks.directory,
  });
  const base = `${profileStem}-${directoryStem}`;
  let name = base;
  let suffix = firstCollisionSuffix;
  while (existingNames.has(name)) name = `${base}-${suffix++}`;
  return name;
}

function startupDirectoryDeclaration({
  startupCwd,
}: {
  readonly startupCwd: string;
}): ProfileConfigProfile["directoryGlobs"] {
  const validation = validateDirectoryGlobs([startupCwd]);
  return validation.valid ? validation.value : undefined;
}

export function createProfileAuthoringDraft({
  activeProfile,
  startupCwd,
  existingNames,
}: {
  readonly activeProfile: string;
  readonly startupCwd: string;
  readonly existingNames: ReadonlySet<string>;
}): Extract<ProfileAuthoringDraft, { readonly mode: "create" }> {
  return parseOrThrow({
    unverifiedData: {
      mode: "create",
      name: suggestedProfileName({
        profile: activeProfile,
        cwd: startupCwd,
        existingNames,
      }),
      definition: {
        description: "",
        emoji: defaultCustomProfileEmoji,
        extends: [activeProfile],
        directoryGlobs: startupDirectoryDeclaration({ startupCwd }),
      },
    },
    schema: profileAuthoringCreateDraftSchema,
    message: "Invalid initial CREATE profile draft",
  });
}

export function createProfileEditDraft({
  name,
  definition,
}: {
  readonly name: string;
  readonly definition: ProfileConfigProfile;
}): Extract<ProfileAuthoringDraft, { readonly mode: "edit" }> {
  return parseOrThrow({
    unverifiedData: {
      mode: "edit",
      originalName: name,
      name,
      definition: structuredClone(definition),
    },
    schema: profileAuthoringEditDraftSchema,
    message: `Invalid raw profile '${name}'`,
  });
}

export function decodePromptAuthoring({
  promptFile,
}: {
  readonly promptFile: ProfileConfigProfile["promptFile"];
}): ProfilePromptAuthoring {
  if (promptFile === undefined) return { mode: "inherit" };
  if (promptFile === null) return { mode: "disable" };
  return { mode: "file", path: promptFile };
}

export function serializePromptAuthoring({
  value,
}: {
  readonly value: ProfilePromptAuthoring;
}): ProfileConfigProfile["promptFile"] {
  if (value.mode === "inherit") return undefined;
  if (value.mode === "disable") return null;
  return value.path;
}

export function profileAuthoringDraftIsDirty({
  draft,
  initial,
}: {
  readonly draft: ProfileAuthoringDraft;
  readonly initial: ProfileAuthoringDraft;
}): boolean {
  return (
    draft.mode === "create" || JSON.stringify(draft) !== JSON.stringify(initial)
  );
}
