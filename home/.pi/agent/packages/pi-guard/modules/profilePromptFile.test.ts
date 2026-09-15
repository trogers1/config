import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createMissingPromptFile,
  maximumPromptFileBytes,
  promptFileCreationMode,
  readRuntimePromptFile,
  resolveUserPromptFilePath,
  rollbackCreatedPromptFile,
  validatePromptFile,
} from "./profilePromptFile";

const fixture = {
  profile: "prompt-profile",
  fileName: "instructions.md",
  content: "Follow the profile instructions.",
} as const;
const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-guard-prompt-"));
  temporaryDirectories.push(directory);
  return directory;
}

function validationFor({
  declaredPath,
  allowMissing = false,
}: {
  readonly declaredPath: string;
  readonly allowMissing?: boolean;
}) {
  return validatePromptFile({
    profile: fixture.profile,
    declaredPath,
    allowMissing,
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

describe("profile prompt files", () => {
  it("accepts absolute and home-relative user paths", () => {
    const directory = temporaryDirectory();
    const absolute = path.join(directory, fixture.fileName);
    fs.writeFileSync(absolute, fixture.content);

    expect(validationFor({ declaredPath: absolute })).toMatchObject({
      resolvedPath: absolute,
      missing: false,
    });
    expect(
      resolveUserPromptFilePath({
        declaredPath: `~/${fixture.fileName}`,
        home: directory,
      }),
    ).toBe(absolute);
    expect(() =>
      resolveUserPromptFilePath({ declaredPath: fixture.fileName }),
    ).toThrow("absolute or begin with ~/");
  });

  it("accepts symlinks to regular UTF-8 files", () => {
    const directory = temporaryDirectory();
    const target = path.join(directory, fixture.fileName);
    const link = path.join(directory, "linked.md");
    fs.writeFileSync(target, fixture.content);
    fs.symlinkSync(target, link);

    expect(validationFor({ declaredPath: link }).missing).toBe(false);
  });

  it("accepts the exact byte limit and rejects non-files, invalid UTF-8, and oversized content", () => {
    const directory = temporaryDirectory();
    const boundary = path.join(directory, "boundary.md");
    const invalid = path.join(directory, "invalid.md");
    const oversized = path.join(directory, "oversized.md");
    fs.writeFileSync(boundary, Buffer.alloc(maximumPromptFileBytes));
    fs.writeFileSync(invalid, Uint8Array.from([0xc3, 0x28]));
    fs.writeFileSync(oversized, Buffer.alloc(maximumPromptFileBytes + 1));

    expect(validationFor({ declaredPath: boundary }).missing).toBe(false);
    expect(() => validationFor({ declaredPath: directory })).toThrow(
      "regular file",
    );
    expect(() => validationFor({ declaredPath: invalid })).toThrow("UTF-8");
    expect(() => validationFor({ declaredPath: oversized })).toThrow(
      String(maximumPromptFileBytes),
    );
  });

  it("creates a zero-byte missing file only when its parent exists", () => {
    const directory = temporaryDirectory();
    const promptPath = path.join(directory, fixture.fileName);
    const validation = validationFor({
      declaredPath: promptPath,
      allowMissing: true,
    });
    const previousUmask = process.umask(0);
    let created;
    try {
      created = createMissingPromptFile({
        validation,
        profile: fixture.profile,
      });
    } finally {
      process.umask(previousUmask);
    }

    expect(created).toBeDefined();
    expect(fs.readFileSync(promptPath)).toHaveLength(0);
    expect(fs.statSync(promptPath).mode & 0o777).toBe(promptFileCreationMode);

    rollbackCreatedPromptFile({ created });
    expect(fs.existsSync(promptPath)).toBe(false);

    const retainedPath = path.join(directory, "retained.md");
    const retained = createMissingPromptFile({
      validation: validationFor({
        declaredPath: retainedPath,
        allowMissing: true,
      }),
      profile: fixture.profile,
    });
    fs.writeFileSync(retainedPath, fixture.content);
    rollbackCreatedPromptFile({ created: retained });
    expect(fs.readFileSync(retainedPath, "utf8")).toBe(fixture.content);

    expect(() =>
      validationFor({
        declaredPath: path.join(directory, "missing", fixture.fileName),
        allowMissing: true,
      }),
    ).toThrow("parent directory");
  });

  it("fails closed at runtime for missing, non-file, invalid, and oversized targets", () => {
    const directory = temporaryDirectory();
    const missing = path.join(directory, "missing.md");
    const invalid = path.join(directory, "runtime-invalid.md");
    const oversized = path.join(directory, "runtime-oversized.md");
    fs.writeFileSync(invalid, Uint8Array.from([0xc3, 0x28]));
    fs.writeFileSync(oversized, Buffer.alloc(maximumPromptFileBytes + 1));

    const read = ({ declaredPath }: { readonly declaredPath: string }) =>
      readRuntimePromptFile({
        profile: fixture.profile,
        declaredPath,
        allowPackageRelative: false,
        packageRoot: directory,
      });
    expect(() => read({ declaredPath: missing })).toThrow(fixture.profile);
    expect(() => read({ declaredPath: directory })).toThrow("regular file");
    expect(() => read({ declaredPath: invalid })).toThrow("UTF-8");
    expect(() => read({ declaredPath: oversized })).toThrow(
      String(maximumPromptFileBytes),
    );
  });

  it("revalidates a symlink target at runtime after authoring validation", () => {
    const directory = temporaryDirectory();
    const target = path.join(directory, fixture.fileName);
    const link = path.join(directory, "changing-link.md");
    fs.writeFileSync(target, fixture.content);
    fs.symlinkSync(target, link);
    expect(validationFor({ declaredPath: link }).missing).toBe(false);

    fs.unlinkSync(link);
    fs.symlinkSync(directory, link);
    expect(() =>
      readRuntimePromptFile({
        profile: fixture.profile,
        declaredPath: link,
        allowPackageRelative: false,
        packageRoot: directory,
      }),
    ).toThrow("regular file");
  });

  it("loads shipped relative paths only through the package capability", () => {
    const directory = temporaryDirectory();
    const promptPath = path.join(directory, fixture.fileName);
    fs.writeFileSync(promptPath, `  ${fixture.content}  `);

    expect(
      readRuntimePromptFile({
        profile: fixture.profile,
        declaredPath: fixture.fileName,
        allowPackageRelative: true,
        packageRoot: directory,
      }),
    ).toBe(fixture.content);
    expect(() =>
      readRuntimePromptFile({
        profile: fixture.profile,
        declaredPath: fixture.fileName,
        allowPackageRelative: false,
        packageRoot: directory,
      }),
    ).toThrow("absolute or begin with ~/");
  });
});
