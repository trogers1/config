import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		allowOnly: false,
		environment: "node",
		globals: true,
	},
});
