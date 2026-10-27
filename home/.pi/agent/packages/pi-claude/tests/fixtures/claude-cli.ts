import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { Type, type Static } from "typebox";
import { ClaudeCliVersionSchema, SDK_RUNTIME_METADATA } from "../../extensions/cli.ts";
import type { CliAuthStatusSchema } from "../../extensions/auth-route.ts";
import { SDK_SETTINGS_ISOLATION } from "../../extensions/sdk-options.ts";
import { parseOrThrow } from "../../extensions/validation.ts";

export const CLI_AUTH_STATUS = {
  loggedIn: true,
  authMethod: "claude.ai",
  apiProvider: "firstParty",
} satisfies Static<typeof CliAuthStatusSchema>;
export const CliAuthRequestSchema = Type.Object({
  cwd: Type.String(),
  settings: Type.Refine(Type.Record(Type.String(), Type.Unknown()), (value) =>
    isDeepStrictEqual(value, SDK_SETTINGS_ISOLATION),
  ),
  configDir: Type.Optional(Type.String()),
  ordinaryFixture: Type.Optional(Type.String()),
  requestFixture: Type.Optional(Type.String()),
});
export const CliAuthResponseSchema = Type.Object({
  stdout: Type.String(),
  stderr: Type.String(),
  exitCode: Type.Integer(),
  delayMs: Type.Number(),
  signal: Type.Optional(Type.Literal("SIGTERM")),
});
export const CLI_AUTH_RESPONSE = {
  stdout: JSON.stringify(CLI_AUTH_STATUS),
  stderr: "",
  exitCode: 0,
  delayMs: 0,
} satisfies Static<typeof CliAuthResponseSchema>;

/** Metadata-only executable: any attempt to start a real query fails loudly. */
export function createFakeClaudeCli({
  directory,
  version = SDK_RUNTIME_METADATA.claudeCodeVersion,
  output,
}: {
  directory: string;
  version?: string;
  output?: string;
}) {
  const validVersion = parseOrThrow({
    value: version,
    schema: ClaudeCliVersionSchema,
    source: "fixture CLI version",
  });
  mkdirSync(directory, { recursive: true });
  const executable = join(directory, "claude");
  const unexpectedExecution = join(directory, "unexpected-runtime-invocation");
  const metadataRequests = join(directory, "metadata-requests");
  const authRequests = join(directory, "auth-requests");
  const authResponse = join(directory, "auth-response.json");
  writeFileSync(authResponse, JSON.stringify(CLI_AUTH_RESPONSE));
  const versionOutput = output ?? `${validVersion} (Claude Code)`;
  const authArgs = [
    "--setting-sources",
    "",
    "--settings",
    JSON.stringify(SDK_SETTINGS_ISOLATION),
    "auth",
    "status",
    "--json",
  ];
  writeFileSync(
    executable,
    `#!${process.execPath}
const {readFileSync,writeFileSync,appendFileSync}=require("node:fs");
if(process.argv.length===3&&process.argv[2]==="--version"){appendFileSync(${JSON.stringify(metadataRequests)},"version\\n");console.log(${JSON.stringify(versionOutput)});process.exit(0);}
if(JSON.stringify(process.argv.slice(2))===${JSON.stringify(JSON.stringify(authArgs))}){
  appendFileSync(${JSON.stringify(authRequests)},JSON.stringify({cwd:process.cwd(),settings:JSON.parse(process.argv[5]),configDir:process.env.CLAUDE_CONFIG_DIR,ordinaryFixture:process.env.BRIDGE_ORDINARY_FIXTURE,requestFixture:process.env.BRIDGE_REQUEST_FIXTURE})+"\\n");
  if(process.env.CLAUDE_AGENT_SDK_VERSION!==${JSON.stringify(SDK_RUNTIME_METADATA.version)})process.exit(98);
  const response=JSON.parse(readFileSync(${JSON.stringify(authResponse)},"utf8"));
  setTimeout(()=>{process.stdout.write(response.stdout);process.stderr.write(response.stderr);if(response.signal)process.kill(process.pid,response.signal);else process.exit(response.exitCode);},response.delayMs);
}else{
  writeFileSync(${JSON.stringify(unexpectedExecution)},"No Claude runtime queries are allowed in deterministic tests");
  process.stderr.write("Fixture permits only version and isolated auth-status metadata requests\\n");process.exit(97);
}
`,
  );
  chmodSync(executable, 0o700);
  return { executable, unexpectedExecution, metadataRequests, authRequests, authResponse };
}
