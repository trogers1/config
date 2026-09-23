import fs from "node:fs";
import path from "node:path";
import { defineConfig } from "vitest/config";
import {
  viteRuntimeMarkerEnvironmentVariable,
  viteRuntimeMarkerValue,
  viteTemporaryDirectoryRelativePath,
} from "./fixtureContract";

const viteTemporaryDirectory = path.resolve(
  import.meta.dirname,
  viteTemporaryDirectoryRelativePath,
);
const runtimeMarker = path.join(viteTemporaryDirectory, "fixture-marker");
fs.mkdirSync(viteTemporaryDirectory, { recursive: true });
fs.writeFileSync(runtimeMarker, viteRuntimeMarkerValue);
const runtimeMarkerContents = fs.readFileSync(runtimeMarker, "utf8");

export default defineConfig({
  test: {
    include: ["runtime.fixture.ts"],
    env: {
      [viteRuntimeMarkerEnvironmentVariable]: runtimeMarkerContents,
    },
  },
});
