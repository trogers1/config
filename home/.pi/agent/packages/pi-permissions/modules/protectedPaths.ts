/** Default secret and repository-metadata paths configured by standard profiles. */
export const defaultProtectedPathPatterns = [
  "**/.env*",
  "**/.env*/**",
  "**/.git",
  "**/.git/**",
  "**/secrets/*.tfvars",
];

/** Narrow readable exceptions applied after the default protected patterns. */
export const defaultProtectedPathExceptions = ["**/.env.template"];
