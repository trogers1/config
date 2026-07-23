import fs from "node:fs";
import path from "node:path";
import prettier from "prettier";
import { profileConfigFileSchema } from "../modules/policyHelpers";

async function main(): Promise<void> {
  const outputPath = path.resolve(
    import.meta.dirname,
    "../schemas/profiles.schema.json",
  );
  const schema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    ...profileConfigFileSchema,
  };
  const output = await prettier.format(JSON.stringify(schema), {
    parser: "json",
  });

  if (process.argv.includes("--check")) {
    const existing = fs.existsSync(outputPath)
      ? fs.readFileSync(outputPath, "utf8")
      : "";
    if (existing !== output) {
      throw new Error(
        "profiles.schema.json is stale; run npm run generate:profile-schema",
      );
    }
  } else {
    fs.writeFileSync(outputPath, output);
  }
}

void main();
