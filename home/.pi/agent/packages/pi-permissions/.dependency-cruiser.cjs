module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      comment:
        "Policy evaluation must stay acyclic so the pi extension can load reliably through jiti.",
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
      name: "not-to-deprecated-core",
      severity: "error",
      from: {},
      to: {
        dependencyTypes: ["core"],
        path: "^(punycode|domain|constants|sys)$",
      },
    },
    {
      name: "not-to-test",
      severity: "error",
      comment: "Runtime extension code must never depend on tests.",
      from: { pathNot: "^test/" },
      to: { path: "^test/" },
    },
    {
      name: "policy-files-do-not-import-extension-entrypoints",
      severity: "error",
      comment:
        "Shared policy helpers live in policy-helpers.ts; importing extension entrypoints from policy files recreates a load-time cycle.",
      from: { path: "^(policy|policy-helpers)\\.ts$" },
      to: { path: "^extensions/" },
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
    reporterOptions: {
      dot: {
        collapsePattern: "node_modules/[^/]+",
      },
    },
  },
};
