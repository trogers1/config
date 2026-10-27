const tseslint = require("typescript-eslint");

module.exports = tseslint.config(
  { ignores: ["node_modules/**", "coverage/**"] },
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    rules: {
      "@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports" }],
      "no-restricted-syntax": [
        "error",
        {
          selector: "TSAsExpression",
          message: "Derive types or validate unknown data centrally; do not cast.",
        },
        {
          selector: "TSTypeAssertion",
          message: "Derive types or validate unknown data centrally; do not cast.",
        },
        { selector: "TSNonNullExpression", message: "Fail loudly when required data is absent." },
      ],
    },
  },
  {
    files: ["extensions/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "pi-claude-bridge",
                "pi-claude-bridge/**",
                "cc-session-io",
                "cc-session-io/**",
              ],
              message:
                "This package owns its provider and session reconstruction; upstream runtime imports are forbidden.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["*.cjs"],
    languageOptions: {
      sourceType: "commonjs",
      globals: { require: "readonly", module: "readonly" },
    },
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
);
