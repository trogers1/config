import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const directoryPrefix = "pi-guard-";
const staleDirectoryMaximumAgeMs = 24 * 60 * 60 * 1000;

let directory: string | undefined;
let cleanupRegistered = false;

function parentDirectory(): string {
  // macOS's /tmp is a symlink to /private/tmp. Use the canonical path so the
  // generated sandbox allow root cannot depend on symlink interpretation.
  return process.platform === "darwin" ? "/private/tmp" : os.tmpdir();
}

function isOwnedStaleDirectory({
  entry,
  now,
}: {
  readonly entry: string;
  readonly now: number;
}): boolean {
  if (!entry.startsWith(directoryPrefix)) return false;
  const candidate = path.join(parentDirectory(), entry);
  try {
    const metadata = fs.lstatSync(candidate);
    return (
      metadata.isDirectory() &&
      !metadata.isSymbolicLink() &&
      metadata.uid === process.getuid?.() &&
      now - metadata.mtimeMs > staleDirectoryMaximumAgeMs
    );
  } catch {
    return false;
  }
}

/** Remove only our own old, user-owned directories; failures are harmless. */
function removeStaleDirectories(): void {
  const now = Date.now();
  try {
    for (const entry of fs.readdirSync(parentDirectory())) {
      if (!isOwnedStaleDirectory({ entry, now })) continue;
      fs.rmSync(path.join(parentDirectory(), entry), {
        recursive: true,
        force: true,
      });
    }
  } catch {
    // A missing or inaccessible temp parent must not prevent Pi from loading.
  }
}

function cleanupDirectory(): void {
  if (!directory) return;
  try {
    fs.rmSync(directory, { recursive: true, force: true });
  } catch {
    // Exit-time cleanup is best effort. Startup cleanup handles crashes.
  }
}

/**
 * Return this Pi process's private SRT work directory.
 *
 * SRT overwrites TMPDIR for filesystem-sandboxed children. Setting its
 * documented override prevents the unusable /tmp/claude fallback; the caller
 * must add this exact directory to the generated sandbox write roots.
 */
export function ensureSandboxTemporaryDirectory(): string {
  if (directory) return directory;

  removeStaleDirectories();
  directory = fs.mkdtempSync(path.join(parentDirectory(), directoryPrefix));
  fs.chmodSync(directory, 0o700);
  process.env.CLAUDE_CODE_TMPDIR = directory;

  if (!cleanupRegistered) {
    cleanupRegistered = true;
    process.once("exit", cleanupDirectory);
  }
  return directory;
}
