import type { AccountInfo, Options } from "@anthropic-ai/claude-agent-sdk";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { constants } from "node:os";
import { Type } from "typebox";
import { SDK_RUNTIME_METADATA } from "./cli.ts";
import { SDK_SETTINGS_ISOLATION } from "./sdk-options.ts";
import { parseJson, parseOrThrow } from "./validation.ts";

// Public CLI contract, not inferred tokenSource strings:
// https://code.claude.com/docs/en/cli-reference#cli-commands
export const CliAuthStatusSchema = Type.Object({
  loggedIn: Type.Boolean(),
  authMethod: Type.Union([
    Type.Literal("none"),
    Type.Literal("claude.ai"),
    Type.Literal("oauth_token"),
    Type.Literal("api_key"),
    Type.Literal("api_key_helper"),
    Type.Literal("third_party"),
  ]),
  apiProvider: Type.Optional(Type.String()),
});
const SdkAccountRouteSchema = Type.Object({
  apiProvider: Type.Literal("firstParty"),
  apiKeySource: Type.Optional(Type.Literal("none")),
});
const execute = promisify(execFile);
const CHILD_ERROR_CODES = new Set([
  "ENOENT",
  "EACCES",
  "EPERM",
  "ENOEXEC",
  "ENOTDIR",
  "E2BIG",
  "ETIMEDOUT",
  "ABORT_ERR",
  "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
]);

function childFailureDetails({ error }: { error: unknown }) {
  if (typeof error !== "object" || error === null) return "";
  const details: string[] = [];
  if ("code" in error) {
    if (typeof error.code === "number" && Number.isSafeInteger(error.code))
      details.push(`exit=${error.code}`);
    else if (typeof error.code === "string" && CHILD_ERROR_CODES.has(error.code))
      details.push(`code=${error.code}`);
  }
  if (
    "signal" in error &&
    typeof error.signal === "string" &&
    Object.hasOwn(constants.signals, error.signal)
  )
    details.push(`signal=${error.signal}`);
  return details.length ? ` (${details.join(", ")})` : "";
}

export async function verifyCliAuthRoute({
  executable,
  cwd,
  env,
  signal,
}: {
  executable: string;
  cwd: string;
  env: NonNullable<Options["env"]>;
  signal: AbortSignal;
}) {
  let stdout: string;
  let stderr: string;
  try {
    // Global flags are also accepted by auth status. The SDK translates
    // settingSources: [] to the same empty --setting-sources argument.
    // Same executable/cwd/env/flags is corroborated by SDK accountInfo below;
    // managed policy and runtime remain trusted, not sandboxed by this check.
    ({ stdout, stderr } = await execute(
      executable,
      [
        "--setting-sources",
        "",
        "--settings",
        JSON.stringify(SDK_SETTINGS_ISOLATION),
        "auth",
        "status",
        "--json",
      ],
      {
        cwd,
        env,
        signal,
        encoding: "utf8",
        timeout: 3_000,
        maxBuffer: 16 * 1024,
        killSignal: "SIGKILL",
        windowsHide: true,
      },
    ));
  } catch (error) {
    // Child errors contain stdout/stderr/command arguments. Include only a
    // validated numeric exit code or known errno/signal, never the raw error,
    // account identity, rejected JSON or credential values (including causes).
    throw new Error(
      `pi-claude: Claude auth-status metadata command failed or was cancelled${childFailureDetails({ error })}`,
    );
  }
  if (stderr.trim())
    throw new Error("pi-claude: Claude auth-status metadata command emitted diagnostics");
  const status = parseJson({
    text: stdout,
    schema: CliAuthStatusSchema,
    source: "Claude CLI auth-status metadata",
  });
  if (
    !status.loggedIn ||
    status.authMethod !== "claude.ai" ||
    (status.apiProvider !== undefined && status.apiProvider !== "firstParty")
  )
    throw new Error("pi-claude: existing first-party Claude CLI claude.ai login is required");
}

export function verifySdkAccountRoute({ account }: { account: unknown }) {
  // Neither an absent source nor 'none' is OAuth proof. This is corroboration
  // only AFTER the CLI command positively identified same-context claude.ai
  // auth. AccountInfo declares apiKeySource optional; current CLI 2.1.301 with
  // SDK 0.3.293 was observed omitting it on this route. Explicit other values
  // still fail. No email/org/tokenSource/subscriptionType is interpreted.
  parseOrThrow({
    schema: SdkAccountRouteSchema,
    value: account,
    source: "Claude SDK account route (firstParty; API-key source absent or none required)",
  }) satisfies AccountInfo;
}

// Reviewed against the pinned official SDK's sdk.mjs provider selectors,
// endpoint/credential companion lists and credential file-descriptor list.
// These are route controls, NOT a general environment allowlist. Ordinary
// environment (including proxy/TLS configuration) remains trusted and intact.
const AUTH_ROUTE_VARIABLES = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
  "CLAUDE_CODE_GATEWAY_TOKEN_FILE_DESCRIPTOR",
  "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
  "CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR",
  "CCR_AGENT_PROXY_TOKEN_FILE_DESCRIPTOR",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
  "CLAUDE_CODE_USE_MANTLE",
  "CLAUDE_CODE_USE_GATEWAY",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_VERTEX_BASE_URL",
  "ANTHROPIC_FOUNDRY_BASE_URL",
  "ANTHROPIC_AWS_BASE_URL",
  "ANTHROPIC_GOOGLE_CLOUD_BASE_URL",
  "ANTHROPIC_BEDROCK_MANTLE_BASE_URL",
  "CLAUDE_CODE_SKIP_BEDROCK_AUTH",
  "CLAUDE_CODE_SKIP_VERTEX_AUTH",
  "CLAUDE_CODE_SKIP_FOUNDRY_AUTH",
  "CLAUDE_CODE_SKIP_ANTHROPIC_AWS_AUTH",
  "CLAUDE_CODE_SKIP_ANTHROPIC_GOOGLE_CLOUD_AUTH",
  "CLAUDE_CODE_SKIP_MANTLE_AUTH",
  "AWS_BEARER_TOKEN_BEDROCK",
  "ANTHROPIC_FOUNDRY_API_KEY",
  "ANTHROPIC_FOUNDRY_AUTH_TOKEN",
  "ANTHROPIC_AWS_API_KEY",
  "ANTHROPIC_FOUNDRY_RESOURCE",
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "ANTHROPIC_AWS_WORKSPACE_ID",
  "ANTHROPIC_GOOGLE_CLOUD_PROJECT",
  "ANTHROPIC_GOOGLE_CLOUD_LOCATION",
  "ANTHROPIC_GOOGLE_CLOUD_WORKSPACE_ID",
  "CLOUD_ML_REGION",
];

export function effectiveSdkEnvironment({
  ambient,
  request,
  claudeConfigDir,
  maxTokens,
}: {
  ambient: NodeJS.ProcessEnv;
  request: Options["env"];
  claudeConfigDir: string;
  maxTokens: number | undefined;
}): NonNullable<Options["env"]> {
  // Check BOTH sources: a request cannot conceal ambient credentials with an
  // empty override. Reject presence, including empty strings/false-like flags;
  // do not read credentials, silently strip variables or log their values.
  if (request?.CLAUDE_CONFIG_DIR !== undefined)
    throw new Error(
      "pi-claude: CLAUDE_CONFIG_DIR may only be set in Pi's user-owned process environment, not request/project configuration",
    );
  if (ambient.CLAUDE_CONFIG_DIR === "")
    throw new Error("pi-claude: explicitly configured CLAUDE_CONFIG_DIR must not be empty");
  const conflicts = AUTH_ROUTE_VARIABLES.filter(
    (name) => ambient[name] !== undefined || request?.[name] !== undefined,
  );
  if (conflicts.length)
    throw new Error(`pi-claude: conflicting Claude auth/route variables: ${conflicts.join(", ")}`);
  return {
    ...ambient,
    ...request,
    CLAUDE_CODE_AUTO_COMPACT: "0",
    DISABLE_AUTO_COMPACT: "1",
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
    CLAUDE_CODE_DISABLE_CLAUDE_AI_MCP: "1",
    CLAUDE_AGENT_SDK_CLIENT_APP: "pi-claude/0.1.0",
    // query() mutates process.env with this metadata. Normalize it before the
    // first identity and use this exact snapshot for dispatch and continuation.
    CLAUDE_AGENT_SDK_VERSION: SDK_RUNTIME_METADATA.version,
    CLAUDE_CODE_ENTRYPOINT: "sdk-ts",
    CLAUDE_CODE_SDK_READS_SESSION_STATE: "1",
    // An explicit default path is NOT equivalent to omission for CLI auth
    // identity/keychain selection. Normalize only a user-configured override;
    // the separately derived default remains reconstruction storage, not env.
    ...(ambient.CLAUDE_CONFIG_DIR !== undefined ? { CLAUDE_CONFIG_DIR: claudeConfigDir } : {}),
    ...(maxTokens !== undefined ? { CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(maxTokens) } : {}),
  };
}
