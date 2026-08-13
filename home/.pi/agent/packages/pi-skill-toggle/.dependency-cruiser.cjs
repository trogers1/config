module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      comment:
        "The extension must load predictably when Pi imports it through jiti.",
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
      comment: "Runtime extension code must not depend on test cases.",
      from: { path: "^src/", pathNot: "\\.test\\.ts$" },
      to: { path: "\\.test\\.ts$" },
    },
    {
      name: "not-to-dev-dependency",
      severity: "error",
      comment:
        "Only Pi's declared peer APIs may be imported by runtime extension code.",
      from: { path: "^src/", pathNot: "\\.test\\.ts$" },
      to: {
        dependencyTypes: ["npm-dev"],
        pathNot: "node_modules/@earendil-works/pi-(?:coding-agent|tui)/",
      },
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
