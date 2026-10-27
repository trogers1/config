module.exports = {
  forbidden: [
    { name: "no-circular", severity: "error", from: {}, to: { circular: true } },
    {
      name: "owned-provider-no-upstream-runtime",
      severity: "error",
      from: { path: "^extensions/" },
      to: { path: "node_modules/(pi-claude-bridge|cc-session-io)(/|$)" },
    },
    {
      name: "runtime-not-to-tests",
      severity: "error",
      from: { path: "^extensions/" },
      to: { path: "^tests/" },
    },
    {
      name: "no-runtime-dev-dependency",
      severity: "error",
      from: { path: "^extensions/" },
      to: {
        dependencyTypes: ["npm-dev"],
        pathNot: "node_modules/@earendil-works/|node_modules/typebox",
      },
    },
    {
      name: "no-runtime-test-seam",
      severity: "error",
      from: { path: "^extensions/" },
      to: { path: "^tests/fixtures/" },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules|\.\./pi-guard-subagents" },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "node", "default"],
    },
  },
};
