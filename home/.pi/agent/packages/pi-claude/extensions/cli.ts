import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, sep } from "node:path";
import { promisify } from "node:util";
import { Type } from "typebox";
import { parseJson, parseOrThrow } from "./validation.ts";

export const CLAUDE_EXECUTABLE_ENV = "CLAUDE_BRIDGE_EXECUTABLE";
const versionPattern = "(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)";
export const ClaudeCliVersionSchema = Type.String({ pattern: `^${versionPattern}$` });
/** Official SDK sdk.d.ts, Options.verbatimPrompts: older CLIs ignore
 * client_composed and may expand @paths or dispatch slash commands. */
export const CLAUDE_CLI_VERSION_CONTRACT = {
  minimumVersion: parseOrThrow({
    value: "2.1.248",
    schema: ClaudeCliVersionSchema,
    source: "Claude CLI verbatimPrompts capability minimum",
  }),
  requiredCapability: "verbatimPrompts/client_composed",
};
const versionOutput = new RegExp(`^(${versionPattern}) \\(Claude Code\\)\\r?\\n?$`);
const SdkMetadataSchema = Type.Object({
  name: Type.Literal("@anthropic-ai/claude-agent-sdk"),
  version: ClaudeCliVersionSchema,
  claudeCodeVersion: ClaudeCliVersionSchema,
});
const require = createRequire(import.meta.url);
export const SDK_RUNTIME_METADATA = parseJson({
  text: readFileSync(
    join(dirname(require.resolve("@anthropic-ai/claude-agent-sdk")), "package.json"),
    "utf8",
  ),
  schema: SdkMetadataSchema,
  source: "installed official Claude Agent SDK metadata",
});
const execute = promisify(execFile);

function within({ root, path }: { root: string; path: string }) {
  const suffix = relative(root, path);
  return !suffix || (suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix));
}
function missing({ error }: { error: unknown }) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
async function candidate({
  path,
  cwd,
  explicit,
}: {
  path: string;
  cwd: string;
  explicit: boolean;
}) {
  if (within({ root: cwd, path })) {
    if (explicit)
      throw new Error("pi-claude: Claude executable override must be outside the session project");
    return undefined;
  }
  let canonical: string;
  try {
    canonical = await realpath(path);
  } catch (error) {
    if (!explicit && missing({ error })) return undefined;
    throw new Error("pi-claude: cannot resolve the selected installed Claude executable", {
      cause: error,
    });
  }
  if (within({ root: cwd, path: canonical })) {
    if (explicit)
      throw new Error(
        "pi-claude: canonical Claude executable override must be outside the session project",
      );
    return undefined;
  }
  const info = await stat(canonical);
  if (!info.isFile())
    throw new Error("pi-claude: selected Claude executable is not a regular file");
  try {
    await access(canonical, constants.R_OK | constants.X_OK);
  } catch (cause) {
    throw new Error("pi-claude: selected Claude executable is not readable and executable", {
      cause,
    });
  }
  return {
    path: canonical,
    identity: JSON.stringify({
      path: canonical,
      dev: info.dev,
      ino: info.ino,
      size: info.size,
      mtime: info.mtimeMs,
    }),
  };
}
async function select({ cwd }: { cwd: string }) {
  const override = process.env[CLAUDE_EXECUTABLE_ENV];
  if (override !== undefined) {
    if (!isAbsolute(override))
      throw new Error(`pi-claude: ${CLAUDE_EXECUTABLE_ENV} must be a nonempty absolute path`);
    const selected = await candidate({ path: override, cwd, explicit: true });
    if (!selected) throw new Error("pi-claude: explicit Claude executable was not selected");
    return selected;
  }
  for (const entry of (process.env.PATH ?? "").split(delimiter)) {
    // Never interpret empty/relative PATH entries against the current project.
    if (!isAbsolute(entry)) continue;
    const selected = await candidate({
      path: join(entry, process.platform === "win32" ? "claude.exe" : "claude"),
      cwd,
      explicit: false,
    });
    if (selected) return selected;
  }
  throw new Error(
    `pi-claude: no installed Claude executable on eligible absolute PATH entries; set ${CLAUDE_EXECUTABLE_ENV} to an absolute path outside the session project`,
  );
}
async function inspect({ path }: { path: string }) {
  let stdout: string;
  let stderr: string;
  try {
    ({ stdout, stderr } = await execute(path, ["--version"], {
      cwd: homedir(),
      encoding: "utf8",
      timeout: 3_000,
      maxBuffer: 4_096,
      killSignal: "SIGKILL",
      windowsHide: true,
    }));
  } catch (cause) {
    throw new Error(
      "pi-claude: selected Claude executable failed its bounded --version metadata check",
      { cause },
    );
  }
  const version = versionOutput.exec(stdout)?.[1];
  if (stderr.length || !version)
    throw new Error("pi-claude: selected executable returned unexpected Claude --version metadata");
  const validatedVersion = parseOrThrow({
    schema: ClaudeCliVersionSchema,
    value: version,
    source: "installed Claude CLI version",
  });
  const minimum = CLAUDE_CLI_VERSION_CONTRACT.minimumVersion.split(".");
  for (const [index, component] of validatedVersion.split(".").entries()) {
    const required = minimum[index];
    if (required === undefined)
      throw new Error("pi-claude: invalid CLI capability version contract");
    const difference = BigInt(component) - BigInt(required);
    if (difference > 0n) return validatedVersion;
    if (difference < 0n)
      throw new Error(
        `pi-claude: installed Claude CLI ${validatedVersion} is unsupported; Claude Code >=${CLAUDE_CLI_VERSION_CONTRACT.minimumVersion} is required for ${CLAUDE_CLI_VERSION_CONTRACT.requiredCapability} prompt isolation`,
      );
  }
  return validatedVersion;
}

/** One current executable/version per extension instance. Discovery never runs a
 * CLI; the first trusted provider request performs only bounded --version.
 * Replacing the selected file invalidates metadata and checkpoint identity. */
export function createClaudeExecutableResolver() {
  let cached: { identity: string; version: Promise<string> } | undefined;
  let warned: string | undefined;
  return {
    async resolve({
      cwd,
      warn,
    }: {
      cwd: string;
      warn: ({ message }: { message: string }) => void;
    }) {
      const selected = await select({ cwd });
      if (cached?.identity !== selected.identity)
        cached = { identity: selected.identity, version: inspect({ path: selected.path }) };
      const version = await cached.version;
      if (version !== SDK_RUNTIME_METADATA.claudeCodeVersion && warned !== selected.identity) {
        warned = selected.identity;
        warn({
          message: `pi-claude: installed Claude CLI ${version} differs from SDK ${SDK_RUNTIME_METADATA.version}'s declared runtime ${SDK_RUNTIME_METADATA.claudeCodeVersion}. Version metadata does not establish protocol compatibility; offline and explicitly approved live checks are required.`,
        });
      }
      return {
        ...selected,
        version,
        sdkVersion: SDK_RUNTIME_METADATA.version,
        declaredCliVersion: SDK_RUNTIME_METADATA.claudeCodeVersion,
      };
    },
  };
}
