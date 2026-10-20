// Fake package-owned boundary: validates its exact CLI contract without Pi,
// credentials, or loading a policy engine. Real policy validation is guard's test.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {parseArgs} from "node:util";

const {values: {profile, cwd}} = parseArgs({
  options: {profile: {type: "string"}, cwd: {type: "string"}},
  strict: true, allowPositionals: false,
});
assert.ok(profile);
assert.ok(path.isAbsolute(cwd));
process.chdir(cwd);
const config = JSON.parse(fs.readFileSync(process.env.DEV_TEST_GUARD_CONFIG, "utf8"));
assert.ok(config.profiles.includes(profile), `Unknown startup profile: ${profile}`);
assert.ok(!process.env.PI_SUBAGENT_PROFILE || process.env.PI_SUBAGENT_PROFILE === profile,
  "Startup profile conflicts with authoritative subagent selection");
if (process.env.DEV_TEST_GUARD_LOG) {
  fs.appendFileSync(process.env.DEV_TEST_GUARD_LOG, `${JSON.stringify({profile, cwd})}\n`);
}
console.log(JSON.stringify({profile}));
