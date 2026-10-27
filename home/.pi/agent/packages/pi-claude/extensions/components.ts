import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { Type } from "typebox";
import { Value } from "typebox/value";

// Invocation-only optional components. Never disable or seat the managed
// security component; policy precedence is preserved by the native runtime.
export const DISABLED_PLUGINS = Object.freeze({
  "cc-plugin-agents-md@builtin": false,
  "cc-plugin-telemetry@builtin": false,
  "cc-plugin-plugin-authoring@builtin": false,
} satisfies NonNullable<Exclude<Options["settings"], string>>["enabledPlugins"]);
export const DISABLED_SKILLS = Object.freeze({
  design: "off",
  doctor: "off",
  "plugin-authoring": "off",
} satisfies NonNullable<Exclude<Options["settings"], string>>["skillOverrides"]);
export const SECURITY_DEFAULT_PLUGIN = Object.freeze({
  name: "cc-plugin-sec-default",
  source: "cc-plugin-sec-default@builtin",
  path: "builtin",
});
export const COMPONENT_LIMITS = { inventoryItems: 64, identityChars: 256 };
const identity = Type.String({ minLength: 1, maxLength: COMPONENT_LIMITS.identityChars });
// Version metadata is informational, not an identity or trust check.
// Accept only a bounded nonempty string, never use it to establish provenance.
const version = Type.Optional(identity);

// Raw boundary schema also supports safe diagnostics of unapproved identities.
// source is additive native metadata absent from the pinned SDK init type.
export const ComponentInventorySchema = Type.Object({
  plugins: Type.Array(
    Type.Object({
      name: identity,
      source: Type.Optional(identity),
      path: Type.Optional(identity),
      version,
    }),
    { maxItems: COMPONENT_LIMITS.inventoryItems },
  ),
  skills: Type.Array(identity, { maxItems: COMPONENT_LIMITS.inventoryItems }),
});
export const SecurityDefaultPluginSchema = Type.Object(
  {
    name: Type.Literal(SECURITY_DEFAULT_PLUGIN.name),
    source: Type.Literal(SECURITY_DEFAULT_PLUGIN.source),
    path: Type.Literal(SECURITY_DEFAULT_PLUGIN.path),
    version,
  },
  { additionalProperties: false },
);
const ApprovedComponentsSchema = Type.Object({
  plugins: Type.Array(SecurityDefaultPluginSchema, { maxItems: 1 }),
  skills: Type.Array(Type.Never(), { maxItems: 0 }),
});

/** Zero plugins or exactly the approved native registry singleton, no skills.
 * Validate raw metadata, not the SDK's narrower declared plugin type. */
export function hasApprovedComponents({ value }: { value: unknown }): boolean {
  return Value.Check(ApprovedComponentsSchema, value);
}
