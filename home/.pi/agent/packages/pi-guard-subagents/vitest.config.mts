import { defineConfig } from "vitest/config";
import { postureEnvironmentVariable } from "../pi-guard/modules/posture.ts";

export default defineConfig({
	test: {
		allowOnly: false,
		environment: "node",
		globals: true,
		// The launcher forwards pi-guard's posture; tests must not inherit one.
		env: { [postureEnvironmentVariable]: "" },
	},
});
