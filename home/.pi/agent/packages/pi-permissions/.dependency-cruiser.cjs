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
      comment:
        "Runtime code must never depend on integration or colocated unit tests.",
      from: { pathNot: "(^integrationTests/|\\.test\\.ts$)" },
      to: { path: "(^integrationTests/|\\.test\\.ts$)" },
    },
    {
      name: "not-to-dev-dependency",
      severity: "error",
      comment:
        "Pi runtime code must not depend on packages declared only for development.",
      from: { path: "^(extensions|modules)/", pathNot: "\\.test\\.ts$" },
      to: { dependencyTypes: ["npm-dev"] },
    },
    {
      name: "modules-do-not-import-extension-entrypoints",
      severity: "error",
      comment:
        "Runtime modules must remain reusable and must not import Pi extension entrypoints.",
      from: { path: "^modules/" },
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
