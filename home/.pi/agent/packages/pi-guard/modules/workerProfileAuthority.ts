import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Type, type Static } from "typebox";
import { parseOrThrow } from "./policyHelpers";

export const workerProfileAuthorityMaxBytes = 16 * 1024;

const workerProfileAuthoritySchema = Type.Object(
  {
    workerId: Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$" }),
    launchProfile: Type.String({ minLength: 1 }),
    scope: Type.Union([Type.String(), Type.Null()]),
    startupCwd: Type.String({ minLength: 1 }),
    profile: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);
type WorkerProfileAuthority = Static<typeof workerProfileAuthoritySchema>;
export type WorkerProfileBinding = Omit<WorkerProfileAuthority, "profile">;

/** User-owned state outside ordinary worker workspace scopes. */
export function workerProfileAuthorityDirectory({}: Record<
  never,
  never
>): string {
  return path.join(os.homedir(), ".pi", "agent", "pi-guard-worker-profiles");
}

function authorityFile({
  binding,
}: {
  readonly binding: WorkerProfileBinding;
}): string {
  // Validate before using worker identity as a filename.
  parseOrThrow({
    unverifiedData: { ...binding, profile: binding.launchProfile },
    schema: workerProfileAuthoritySchema,
    message: "Invalid worker profile authority binding",
  });
  return path.join(
    workerProfileAuthorityDirectory({}),
    `${binding.workerId}.json`,
  );
}

function checkPrivatePath({
  file,
  directory,
  allowMissing = false,
}: {
  readonly file: string;
  readonly directory: boolean;
  readonly allowMissing?: boolean;
}): boolean {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if (
      allowMissing &&
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return false;
    throw error;
  }
  if (
    stat.isSymbolicLink() ||
    (directory ? !stat.isDirectory() : !stat.isFile()) ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o022) !== 0 ||
    (!directory && (stat.mode & 0o077) !== 0)
  )
    throw new Error(`Unsafe worker profile authority path: ${file}`);
  return true;
}

function checkAuthorityDirectory({
  create,
}: {
  readonly create: boolean;
}): boolean {
  const home = os.homedir();
  const directories = [
    home,
    path.join(home, ".pi"),
    path.join(home, ".pi", "agent"),
    workerProfileAuthorityDirectory({}),
  ];
  for (const directory of directories) {
    if (
      !checkPrivatePath({
        file: directory,
        directory: true,
        allowMissing: true,
      })
    ) {
      if (!create) return false;
      fs.mkdirSync(directory, { mode: 0o700 });
      checkPrivatePath({ file: directory, directory: true });
    }
  }
  return true;
}

export function readWorkerProfileAuthority({
  binding,
}: {
  readonly binding: WorkerProfileBinding;
}): string | undefined {
  const file = authorityFile({ binding });
  if (!checkAuthorityDirectory({ create: false })) return undefined;
  let descriptor: number;
  try {
    descriptor = fs.openSync(
      file,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return undefined;
    throw error;
  }
  try {
    checkPrivatePath({ file, directory: false });
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > workerProfileAuthorityMaxBytes)
      throw new Error(`Invalid worker profile authority file: ${file}`);
    const authority = parseOrThrow({
      unverifiedData: JSON.parse(fs.readFileSync(descriptor, "utf8")),
      schema: workerProfileAuthoritySchema,
      message: `Invalid worker profile authority: ${file}`,
    });
    if (
      authority.workerId !== binding.workerId ||
      authority.launchProfile !== binding.launchProfile ||
      authority.scope !== binding.scope ||
      authority.startupCwd !== binding.startupCwd
    )
      throw new Error(
        `Worker profile authority does not match the immutable launch binding: ${file}`,
      );
    return authority.profile;
  } finally {
    fs.closeSync(descriptor);
  }
}

export function writeWorkerProfileAuthority({
  binding,
  profile,
}: {
  readonly binding: WorkerProfileBinding;
  readonly profile: string;
}): void {
  const file = authorityFile({ binding });
  const authority = parseOrThrow({
    unverifiedData: { ...binding, profile } satisfies WorkerProfileAuthority,
    schema: workerProfileAuthoritySchema,
    message: "Invalid human worker profile selection",
  });
  const serialized = JSON.stringify(authority);
  if (Buffer.byteLength(serialized, "utf8") > workerProfileAuthorityMaxBytes)
    throw new Error(
      `Worker profile authority exceeds ${workerProfileAuthorityMaxBytes} bytes: ${file}`,
    );
  checkAuthorityDirectory({ create: true });
  checkPrivatePath({ file, directory: false, allowMissing: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, serialized, {
      mode: 0o600,
      flag: "wx",
    });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
