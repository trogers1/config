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
        "Code outside a *.lib/ directory may only import it through its public index.ts (docs/.lib_definition.md).",
      from: { pathNot: "\\.lib/" },
      to: { path: "\\.lib/", pathNot: "\\.lib/index\\.ts$" },
    },
    {
      name: "profiles-lib-no-index-self-import",
      severity: "error",
      comment:
        "Files inside profiles.lib import siblings directly, never through profiles.lib/index.ts, so the index stays a true public boundary and knip can flag unused exports (docs/.lib_definition.md). index.test.ts is exempt so the public entrypoint itself remains testable.",
      from: { path: "^modules/profiles\\.lib/", pathNot: "index\\.test\\.ts$" },
      to: { path: "^modules/profiles\\.lib/index\\.ts$" },
    },
    {
      name: "ruleSets-lib-no-index-self-import",
      severity: "error",
      comment:
        "Files inside ruleSets.lib import siblings directly, never through ruleSets.lib/index.ts, so the index stays a true public boundary and knip can flag unused exports (docs/.lib_definition.md). index.test.ts is exempt so the public entrypoint itself remains testable.",
      from: { path: "^modules/ruleSets\\.lib/", pathNot: "index\\.test\\.ts$" },
      to: { path: "^modules/ruleSets\\.lib/index\\.ts$" },
    },
    {
      name: "profiles-lib-no-cross-deep-imports",
      severity: "error",
      comment:
        "profiles.lib may depend on ruleSets.lib only through ruleSets.lib/index.ts, never its deep files (docs/.lib_definition.md).",
      from: { path: "^modules/profiles\\.lib/", pathNot: "index\\.test\\.ts$" },
      to: {
        path: "^modules/ruleSets\\.lib/",
        pathNot: "^modules/ruleSets\\.lib/index\\.ts$",
      },
    },
    {
      name: "ruleSets-lib-no-cross-deep-imports",
      severity: "error",
      comment:
        "ruleSets.lib may depend on profiles.lib only through profiles.lib/index.ts, never its deep files (docs/.lib_definition.md).",
      from: { path: "^modules/ruleSets\\.lib/", pathNot: "index\\.test\\.ts$" },
      to: {
        path: "^modules/profiles\\.lib/",
        pathNot: "^modules/profiles\\.lib/index\\.ts$",
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
    reporterOptions: {
      dot: {
        collapsePattern: "node_modules/[^/]+",
      },
    },
  },
};
