const tseslint = require("typescript-eslint");

module.exports = tseslint.config(
  {
    ignores: ["node_modules/**", "coverage/**"],
  },
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    rules: {
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports" },
      ],
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["./extensions/*", "../extensions/*"],
              message:
                "Core policy files must not import from extension entrypoints; put shared helpers in policy-helpers.ts to avoid extension↔policy cycles.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["test/**/*.js", "scripts/**/*.js", "*.config.js"],
    languageOptions: {
      sourceType: "commonjs",
      globals: {
        require: "readonly",
        module: "readonly",
        __dirname: "readonly",
        process: "readonly",
      },
    },
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
);
