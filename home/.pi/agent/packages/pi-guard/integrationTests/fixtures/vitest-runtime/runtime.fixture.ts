import { describe, expect, it } from "vitest";
import {
  viteRuntimeMarkerEnvironmentVariable,
  viteRuntimeMarkerValue,
} from "./fixtureContract";

describe("Vitest sandbox runtime fixture", () => {
  it("observes the marker written to Vite's runtime directory during config loading", () => {
    expect(process.env[viteRuntimeMarkerEnvironmentVariable]).toBe(
      viteRuntimeMarkerValue,
    );
  });
});
