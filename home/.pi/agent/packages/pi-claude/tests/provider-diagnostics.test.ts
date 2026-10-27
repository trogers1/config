import { expect, test } from "vitest";
import {
  failureCategory,
  failureHints,
  SDK_ERROR_CATEGORIES,
  THIRD_PARTY_EXTRA_USAGE_NOTICE,
} from "./fixtures/provider-diagnostics.ts";

test("failure hints release boolean flags rather than upstream values", () => {
  const hints = failureHints({ message: "Unknown model private-account-identity" });
  expect(hints.model).toBe(true);
  expect(Object.values(hints).every((value) => typeof value === "boolean")).toBe(true);
  expect(JSON.stringify(hints)).not.toContain("private-account-identity");
  expect(Object.values(failureHints({ message: undefined })).every((value) => !value)).toBe(true);
});

test("third-party extra-usage rejection is actionable without exposing upstream details", () => {
  const message = `pi-claude: Claude unknown: API Error: 400 ${THIRD_PARTY_EXTRA_USAGE_NOTICE} private-account-identity`;
  expect(failureCategory({ message })).toBe("third-party-extra-usage-required");
  expect(failureHints({ message }).thirdPartyExtraUsage).toBe(true);
  expect(
    JSON.stringify({ category: failureCategory({ message }), hints: failureHints({ message }) }),
  ).not.toContain("private-account-identity");
  expect(failureCategory({ message: THIRD_PARTY_EXTRA_USAGE_NOTICE })).toBe("unclassified");
});

test("diagnostic reporting releases only fixed SDK categories, never upstream details", () => {
  for (const [kind, category] of Object.entries(SDK_ERROR_CATEGORIES)) {
    for (const suffix of ["", ": private account identity and upstream error text"]) {
      expect(failureCategory({ message: `pi-claude: Claude ${kind}${suffix}` })).toBe(category);
    }
    expect(failureCategory({ message: `pi-claude: Claude ${kind}_unexpected: private text` })).toBe(
      "unclassified",
    );
  }
  expect(failureCategory({ message: undefined })).toBeNull();
  expect(failureCategory({ message: "private unknown error text" })).toBe("unclassified");
});
