import { type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
import type { JsonObject } from "@earendil-works/pi-ai";

export function validateJsonObject({
  value,
  source,
}: {
  value: unknown;
  source: string;
}): JsonObject {
  function valid({
    item,
    ancestors = new Set<object>(),
  }: {
    item: unknown;
    ancestors?: Set<object>;
  }): boolean {
    if (item === null || typeof item === "string" || typeof item === "boolean") return true;
    if (typeof item === "number") return Number.isFinite(item);
    if (typeof item !== "object" || item === null || ancestors.has(item)) return false;
    const array = Array.isArray(item);
    if (
      !array &&
      Object.getPrototypeOf(item) !== Object.prototype &&
      Object.getPrototypeOf(item) !== null
    )
      return false;
    if (Object.getOwnPropertySymbols(item).length) return false;
    const descriptors = Object.entries(Object.getOwnPropertyDescriptors(item)).filter(
      ([key]) => !(array && key === "length"),
    );
    if (array && descriptors.length !== item.length) return false;
    ancestors.add(item);
    const result = descriptors.every(([key, descriptor]) => {
      if (!("value" in descriptor) || !descriptor.enumerable) return false;
      if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= item.length)) return false;
      return valid({ item: descriptor.value, ancestors });
    });
    ancestors.delete(item);
    return result;
  }
  function isObject(input: { value: unknown }): input is { value: JsonObject } {
    return (
      valid({ item: input.value }) &&
      input.value !== null &&
      typeof input.value === "object" &&
      !Array.isArray(input.value)
    );
  }
  const input = { value };
  if (!isObject(input)) throw new Error(`pi-claude: expected JSON object at ${source}`);
  return input.value;
}

export function parseArguments({ text }: { text: string }): JsonObject {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("pi-claude: incomplete or malformed tool arguments");
  }
  return validateJsonObject({ value, source: "tool arguments" });
}

/** Boundary errors deliberately omit rejected values, which may contain prompts. */
export function parseOrThrow<T extends TSchema>({
  schema,
  value,
  source,
}: {
  schema: T;
  value: unknown;
  source: string;
}): Static<T> {
  if (!Value.Check(schema, value)) throw new Error(`pi-claude: schema mismatch at ${source}`);
  return value;
}

export function parseJson<T extends TSchema>({
  text,
  schema,
  source,
}: {
  text: string;
  schema: T;
  source: string;
}): Static<T> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`pi-claude: invalid JSON at ${source}`);
  }
  return parseOrThrow({ schema, value, source });
}
