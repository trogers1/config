import type {
  ProfileConfigProfile,
  SandboxConfig,
  SandboxConfigOverride,
} from "./policyHelpers";
import { validateDirectoryGlobs, type DirectoryGlobs } from "./directoryGlobs";

export const overwritePathArrayNames = [
  "extraWritePaths",
  "extraDenyReadPaths",
  "extraDenyWritePaths",
  "kernelUnenforcedProtectedPaths",
] as const;
export type OverwritePathArrayName = (typeof overwritePathArrayNames)[number];

type Local<T> = { readonly mode: "local"; readonly value: T };
type Omitted = { readonly mode: "omitted" };
type ScalarAuthoring<T> = Omitted | Local<T>;
export type PathArrayAuthoring =
  | { readonly mode: "inherit" }
  | { readonly mode: "append"; readonly value: readonly string[] }
  | { readonly mode: "overwrite"; readonly value: readonly string[] };
export type DirectoryGlobsAuthoring =
  | { readonly mode: "omit" }
  | { readonly mode: "set"; readonly value: readonly string[] };

/** Raw declaration state. It never contains resolved parent values. */
export type RawSandboxAuthoring =
  | { readonly mode: "inherit" }
  | { readonly mode: "disabled" }
  | {
      readonly mode: "customize";
      readonly network: ScalarAuthoring<SandboxConfigOverride["network"]>;
      readonly allowLocalBinding: ScalarAuthoring<boolean>;
      readonly allowAppleEvents: ScalarAuthoring<boolean>;
      readonly enableWeakerNetworkIsolation: ScalarAuthoring<boolean>;
      readonly onUnavailable: ScalarAuthoring<
        SandboxConfigOverride["onUnavailable"]
      >;
      readonly extraWritePaths: PathArrayAuthoring;
      readonly extraDenyReadPaths: PathArrayAuthoring;
      readonly extraDenyWritePaths: PathArrayAuthoring;
      readonly kernelUnenforcedProtectedPaths: PathArrayAuthoring;
    };

/** Resolved state is intentionally separate from the raw declaration draft. */
export type EffectiveSandboxAuthoring = SandboxConfig | false | undefined;

function putScalars(
  target: SandboxConfigOverride,
  value: Extract<RawSandboxAuthoring, { mode: "customize" }>,
): void {
  if (value.network.mode === "local") target.network = value.network.value;
  if (value.allowLocalBinding.mode === "local")
    target.allowLocalBinding = value.allowLocalBinding.value;
  if (value.allowAppleEvents.mode === "local")
    target.allowAppleEvents = value.allowAppleEvents.value;
  if (value.enableWeakerNetworkIsolation.mode === "local")
    target.enableWeakerNetworkIsolation =
      value.enableWeakerNetworkIsolation.value;
  if (value.onUnavailable.mode === "local")
    target.onUnavailable = value.onUnavailable.value;
}
function putPathArray(
  target: SandboxConfigOverride,
  key: OverwritePathArrayName,
  value: PathArrayAuthoring,
  overwritten: OverwritePathArrayName[],
): void {
  if (value.mode === "inherit") return;
  // Empty append is canonical omission; empty overwrite remains meaningful.
  if (value.mode === "append" && value.value.length === 0) return;
  target[key] = [...value.value];
  if (value.mode === "overwrite") overwritten.push(key);
}

/** Serialize only raw declaration state, never an effective inherited value. */
export function serializeSandboxAuthoring({
  value,
}: {
  readonly value: RawSandboxAuthoring | undefined;
}): SandboxConfigOverride | false | undefined {
  if (value === undefined || value.mode === "inherit") return undefined;
  if (value.mode === "disabled") return false;
  const result: SandboxConfigOverride = {};
  putScalars(result, value);
  const overwritten: OverwritePathArrayName[] = [];
  for (const key of overwritePathArrayNames)
    putPathArray(result, key, value[key], overwritten);
  if (overwritten.length > 0) result.overwritePathArrays = overwritten;
  return result;
}

/** Decode only a raw declaration; callers resolve effective state elsewhere. */
export function decodeSandboxAuthoring({
  raw,
}: {
  readonly raw: ProfileConfigProfile["sandbox"];
}): RawSandboxAuthoring {
  if (raw === undefined) return { mode: "inherit" };
  if (raw === false) return { mode: "disabled" };
  const paths = (key: OverwritePathArrayName): PathArrayAuthoring => {
    const value = raw[key];
    if (value === undefined) return { mode: "inherit" };
    const overwrite = raw.overwritePathArrays?.includes(key) ?? false;
    if (!overwrite && value.length === 0) return { mode: "inherit" };
    return { mode: overwrite ? "overwrite" : "append", value: [...value] };
  };
  const scalar = <K extends keyof SandboxConfigOverride>(
    key: K,
  ): ScalarAuthoring<NonNullable<SandboxConfigOverride[K]>> => {
    const value = raw[key];
    return value === undefined ? { mode: "omitted" } : { mode: "local", value };
  };
  return {
    mode: "customize",
    network: scalar("network"),
    allowLocalBinding: scalar("allowLocalBinding"),
    allowAppleEvents: scalar("allowAppleEvents"),
    enableWeakerNetworkIsolation: scalar("enableWeakerNetworkIsolation"),
    onUnavailable: scalar("onUnavailable"),
    extraWritePaths: paths("extraWritePaths"),
    extraDenyReadPaths: paths("extraDenyReadPaths"),
    extraDenyWritePaths: paths("extraDenyWritePaths"),
    kernelUnenforcedProtectedPaths: paths("kernelUnenforcedProtectedPaths"),
  };
}

export function serializeDirectoryGlobs({
  value,
}: {
  readonly value: DirectoryGlobsAuthoring | undefined;
}): DirectoryGlobs | undefined {
  if (value?.mode !== "set") return undefined;
  const result = validateDirectoryGlobs(value.value);
  if (!result.valid) throw new Error(`${result.message} (${result.code})`);
  return result.value;
}
