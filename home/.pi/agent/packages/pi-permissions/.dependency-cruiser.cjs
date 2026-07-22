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
    {
      name: "lib-public-entrypoint-only",
      severity: "error",
      comment:
        "Code outside a *.lib/ directory may only import it through its public index.ts (docs/.lib_definition.md). Caveat: dependency-cruiser cannot correlate from/to paths, so deep imports from inside one lib into another lib's internals are not caught; refine per-lib if a second *.lib/ appears.",
      from: { pathNot: "\\.lib/" },
      to: { path: "\\.lib/", pathNot: "\\.lib/index\\.ts$" },
    },
    {
      name: "lib-no-index-self-import",
      severity: "error",
      comment:
        "Files inside a *.lib/ import siblings directly, never through an index.ts, so index stays a true public boundary and knip can flag unused exports (docs/.lib_definition.md). Exact only while one *.lib/ exists — it blocks lib files from importing ANY lib index; on adding a second lib, replace with per-lib rules so cross-lib imports via the public index stay legal. index.test.ts is exempt so the public entrypoint itself remains testable.",
      from: { path: "\\.lib/", pathNot: "index\\.test\\.ts$" },
      to: { path: "\\.lib/index\\.ts$" },
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
