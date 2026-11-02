import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { postureEnvironmentVariable } from "../pi-guard/modules/posture.ts";

export default defineConfig({
	test: {
		allowOnly: false,
		environment: "node",
		globals: true,
		env: {
			// The launcher forwards pi-guard's posture; tests must not inherit one.
			[postureEnvironmentVariable]: "",
			// Guarded Pi processes must never load the developer's live profiles.
			PI_GUARD_PROFILE_CONFIG: fileURLToPath(new URL("./tests/fixtures/empty-profiles.jsonc", import.meta.url)),
		},
		setupFiles: ["./tests/setup/guardProfileConfig.ts"],
	},
});
