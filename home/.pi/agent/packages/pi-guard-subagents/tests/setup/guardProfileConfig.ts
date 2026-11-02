import { readFileSync } from "node:fs";
import { afterAll } from "vitest";

// vitest.config.mts points every worker, and the Pi processes and tmux servers
// they launch, at the committed empty profile fixture. It is shared, so a test
// that persists profile changes must fail rather than silently edit it.
const configPath = process.env.PI_GUARD_PROFILE_CONFIG;
if (!configPath) throw new Error("PI_GUARD_PROFILE_CONFIG must point at the test profile fixture");
const original = readFileSync(configPath, "utf8");

afterAll(() => {
	if (readFileSync(configPath, "utf8") !== original)
		throw new Error(`A test modified the shared profile fixture ${configPath}; give it its own config.`);
});
