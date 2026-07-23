module.exports = {
	forbidden: [
		{
			name: "no-circular",
			severity: "error",
			comment: "The extension must load predictably when Pi imports it through jiti.",
			from: {},
			to: { circular: true },
		},
		{
			name: "not-to-unresolvable",
			severity: "error",
			from: {},
			to: { couldNotResolve: true },
		},
		{
			name: "not-to-test",
			severity: "error",
			comment: "Runtime extension code must never depend on test helpers or test cases.",
			from: { path: "^extensions/" },
			to: { path: "^tests/" },
		},
		{
			name: "not-to-dev-dependency",
			severity: "error",
			comment:
				"Pi APIs are optional peerDependencies installed locally as devDependencies for tests. All other dev-only imports are unavailable in Pi's host runtime.",
			from: { path: "^extensions/" },
			to: {
				dependencyTypes: ["npm-dev"],
				pathNot: "node_modules/(?:@earendil-works/pi-(?:agent-core|ai|coding-agent|tui)|typebox)/",
			},
		},
		{
			name: "helpers-do-not-import-extension-entrypoint",
			severity: "error",
			comment: "Agent discovery and handoff helpers stay reusable and independent from registration.",
			from: { path: "^extensions/(agents|handoff)\.ts$" },
			to: { path: "^extensions/index\.ts$" },
		},
	],
	options: {
		doNotFollow: { path: "node_modules" },
		tsPreCompilationDeps: true,
		tsConfig: { fileName: "tsconfig.json" },
		enhancedResolveOptions: {
			exportsFields: ["exports"],
			conditionNames: ["import", "require", "node", "default"],
		},
	},
};
