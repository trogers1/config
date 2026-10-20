#!/usr/bin/env node
import { createRequire } from "node:module";
import { parseArgs } from "node:util";

// Pi is a peer, not a second runtime dependency. Resolve its existing loader
// without importing Pi (and therefore without initializing an agent).
try {
  const { values } = parseArgs({
    options: {
      profile: { type: "string" },
      cwd: { type: "string" },
      help: { type: "boolean" },
    },
    allowPositionals: false,
    strict: true,
  });
  if (values.help) {
    process.stdout.write(
      "Usage: node guard-profile.mjs --profile NAME --cwd PATH\nRead-only pi-guard startup validation; prints JSON {profile} on success.\nUses PI_GUARD_PROFILE_CONFIG and authoritative PI_SUBAGENT_PROFILE.\nDoes not prove the guard extension is enabled; launchers must check resource configuration.\n",
    );
  } else {
    if (!values.profile || !values.cwd)
      throw new Error("Required: --profile NAME --cwd PATH (see --help).");
    process.chdir(values.cwd);
    const piRequire = createRequire(
      import.meta.resolve("@earendil-works/pi-coding-agent"),
    );
    const { createJiti } = piRequire("jiti");
    const jiti = createJiti(import.meta.url, { moduleCache: false });
    const { validateStartupProfile } = await jiti.import(
      new URL("./modules/startupProfile.ts", import.meta.url).href,
    );
    const profile = validateStartupProfile({ profile: values.profile });
    process.stdout.write(`${JSON.stringify({ profile })}\n`);
  }
} catch (error) {
  process.stderr.write(
    `pi-guard startup validation failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
