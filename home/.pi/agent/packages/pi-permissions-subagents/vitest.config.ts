import path from "node:path";
import { defineConfig } from "vitest/config";

// Pi packages resolve their peer imports from the globally installed pi runtime.
const piRuntimeDir = "/Users/taylorrogers/.nvm/versions/node/v24.16.0/lib/node_modules/@earendil-works/pi-coding-agent";

export default defineConfig({
	resolve: {
		alias: {
			"@earendil-works/pi-coding-agent": piRuntimeDir,
			"@earendil-works/pi-ai": path.join(piRuntimeDir, "node_modules/@earendil-works/pi-ai"),
			"@earendil-works/pi-agent-core": path.join(piRuntimeDir, "node_modules/@earendil-works/pi-agent-core"),
			"@earendil-works/pi-tui": path.join(piRuntimeDir, "node_modules/@earendil-works/pi-tui"),
			typebox: path.join(piRuntimeDir, "node_modules/typebox"),
		},
	},
	test: {
		environment: "node",
		globals: true,
	},
});
