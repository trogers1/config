const tseslint = require("typescript-eslint");

module.exports = tseslint.config(
	{
		ignores: ["node_modules/**", "coverage/**"],
	},
	...tseslint.configs.recommended,
	{
		files: ["**/*.ts"],
		rules: {
			"@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports" }],
			"@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
		},
	},
	{
		files: ["*.config.js", ".dependency-cruiser.cjs"],
		rules: {
			"@typescript-eslint/no-require-imports": "off",
		},
	},
	{
		// Vitest mocks are intentionally inspected as methods in behavioral tests.
		files: ["tests/**/*.ts"],
		rules: {
			"@typescript-eslint/unbound-method": "off",
		},
	},
	{
		files: ["extensions/agents.ts", "extensions/handoff.ts"],
		rules: {
			"no-restricted-imports": [
				"error",
				{
					patterns: [
						{
							group: ["./index.ts", "../extensions/index.ts"],
							message:
								"Reusable agent and handoff helpers must not import the extension entrypoint; keep orchestration dependencies one-way.",
						},
					],
				},
			],
		},
	},
);
