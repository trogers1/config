import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const maximumPromptFileBytes = 256 * 1024;
export const promptFileCreationMode = 0o666;

export type PromptFileValidation = {
  readonly declaredPath: string;
  readonly resolvedPath: string;
  readonly missing: boolean;
};

export type CreatedPromptFile = {
  readonly path: string;
  readonly device: number;
  readonly inode: number;
};

function promptFileError({
  profile,
  resolvedPath,
  detail,
}: {
  readonly profile: string;
  readonly resolvedPath: string;
  readonly detail: string;
}): Error {
  return new Error(
    `Profile '${profile}' prompt file '${resolvedPath}' ${detail}`,
  );
}

class MissingPromptFileError extends Error {}

function errorDetail({ error }: { readonly error: unknown }): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode({ error }: { readonly error: unknown }): unknown {
  return typeof error === "object" && error !== null && "code" in error
    ? Reflect.get(error, "code")
    : undefined;
}

export function resolveUserPromptFilePath({
  declaredPath,
  home = homedir(),
}: {
  readonly declaredPath: string;
  readonly home?: string;
}): string {
  if (declaredPath.startsWith("~/"))
    return path.join(home, declaredPath.slice(2));
  if (path.isAbsolute(declaredPath)) return declaredPath;
  throw new Error("promptFile must be absolute or begin with ~/");
}

/** Open, verify, and bounded-read one immutable descriptor to avoid path races. */
function readVerifiedPromptFile({
  profile,
  resolvedPath,
}: {
  readonly profile: string;
  readonly resolvedPath: string;
}): string {
  let descriptor: number;
  try {
    descriptor = fs.openSync(
      resolvedPath,
      fs.constants.O_RDONLY | fs.constants.O_NONBLOCK,
    );
  } catch (error) {
    const failure = promptFileError({
      profile,
      resolvedPath,
      detail:
        errorCode({ error }) === "ENOENT"
          ? "does not exist"
          : `is not readable: ${errorDetail({ error })}`,
    });
    if (errorCode({ error }) === "ENOENT")
      throw new MissingPromptFileError(failure.message);
    throw failure;
  }
  try {
    const status = fs.fstatSync(descriptor);
    if (!status.isFile())
      throw promptFileError({
        profile,
        resolvedPath,
        detail: "must resolve to a regular file",
      });
    if (status.size > maximumPromptFileBytes)
      throw promptFileError({
        profile,
        resolvedPath,
        detail: `exceeds ${maximumPromptFileBytes} bytes`,
      });

    const bytes = Buffer.allocUnsafe(maximumPromptFileBytes + 1);
    let length = 0;
    while (length <= maximumPromptFileBytes) {
      const read = fs.readSync(
        descriptor,
        bytes,
        length,
        bytes.byteLength - length,
        null,
      );
      if (read === 0) break;
      length += read;
    }
    if (length > maximumPromptFileBytes)
      throw promptFileError({
        profile,
        resolvedPath,
        detail: `exceeds ${maximumPromptFileBytes} bytes`,
      });
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(0, length),
      );
    } catch {
      throw promptFileError({
        profile,
        resolvedPath,
        detail: "is not valid UTF-8",
      });
    }
  } catch (error) {
    if (error instanceof Error) throw error;
    throw promptFileError({
      profile,
      resolvedPath,
      detail: `is not readable: ${errorDetail({ error })}`,
    });
  } finally {
    fs.closeSync(descriptor);
  }
}

function existingPromptFile({
  profile,
  declaredPath,
  resolvedPath,
}: {
  readonly profile: string;
  readonly declaredPath: string;
  readonly resolvedPath: string;
}): PromptFileValidation {
  readVerifiedPromptFile({ profile, resolvedPath });
  return { declaredPath, resolvedPath, missing: false };
}

export function validatePromptFile({
  profile,
  declaredPath,
  allowMissing,
}: {
  readonly profile: string;
  readonly declaredPath: string;
  readonly allowMissing: boolean;
}): PromptFileValidation {
  const resolvedPath = resolveUserPromptFilePath({ declaredPath });
  try {
    return existingPromptFile({ profile, declaredPath, resolvedPath });
  } catch (error) {
    if (!(error instanceof MissingPromptFileError)) throw error;
  }
  if (!allowMissing)
    throw promptFileError({ profile, resolvedPath, detail: "does not exist" });
  const parent = path.dirname(resolvedPath);
  let parentStatus: fs.Stats;
  try {
    parentStatus = fs.statSync(parent);
  } catch (error) {
    throw promptFileError({
      profile,
      resolvedPath,
      detail: `has no readable parent directory '${parent}': ${errorDetail({ error })}`,
    });
  }
  if (!parentStatus.isDirectory())
    throw promptFileError({
      profile,
      resolvedPath,
      detail: `has a parent '${parent}' that is not a directory`,
    });
  return { declaredPath, resolvedPath, missing: true };
}

export function createMissingPromptFile({
  validation,
  profile,
}: {
  readonly validation: PromptFileValidation;
  readonly profile: string;
}): CreatedPromptFile | undefined {
  if (!validation.missing) return undefined;
  let descriptor: number;
  try {
    descriptor = fs.openSync(
      validation.resolvedPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
      promptFileCreationMode,
    );
  } catch (error) {
    if (errorCode({ error }) === "EEXIST") {
      existingPromptFile({
        profile,
        declaredPath: validation.declaredPath,
        resolvedPath: validation.resolvedPath,
      });
      return undefined;
    }
    throw error;
  }
  try {
    const status = fs.fstatSync(descriptor);
    return {
      path: validation.resolvedPath,
      device: status.dev,
      inode: status.ino,
    };
  } finally {
    fs.closeSync(descriptor);
  }
}

export function rollbackCreatedPromptFile({
  created,
}: {
  readonly created: CreatedPromptFile | undefined;
}): void {
  if (!created) return;
  try {
    const status = fs.lstatSync(created.path);
    if (
      status.isFile() &&
      status.dev === created.device &&
      status.ino === created.inode &&
      status.size === 0
    )
      fs.unlinkSync(created.path);
  } catch {
    // Best effort: never hide the original configuration commit error.
  }
}

export function readRuntimePromptFile({
  profile,
  declaredPath,
  allowPackageRelative,
  packageRoot,
}: {
  readonly profile: string;
  readonly declaredPath: string;
  readonly allowPackageRelative: boolean;
  readonly packageRoot: string;
}): string {
  const resolvedPath =
    allowPackageRelative &&
    !declaredPath.startsWith("~/") &&
    !path.isAbsolute(declaredPath)
      ? path.resolve(packageRoot, declaredPath)
      : resolveUserPromptFilePath({ declaredPath });
  return readVerifiedPromptFile({ profile, resolvedPath }).trim();
}
