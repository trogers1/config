import {
  COMPONENT_LIMITS,
  DISABLED_PLUGINS,
  DISABLED_SKILLS,
  SECURITY_DEFAULT_PLUGIN,
  SecurityDefaultPluginSchema,
} from "../../extensions/components.ts";
import { parseOrThrow } from "../../extensions/validation.ts";

const approvedPlugin = parseOrThrow({
  schema: SecurityDefaultPluginSchema,
  value: SECURITY_DEFAULT_PLUGIN,
  source: "approved native plugin fixture",
});
export const approvedInventories = [
  { label: "empty", rawInit: { plugins: [], skills: [] } },
  { label: "native singleton", rawInit: { plugins: [approvedPlugin], skills: [] } },
  {
    label: "native singleton with manifest version",
    rawInit: {
      plugins: [
        parseOrThrow({
          schema: SecurityDefaultPluginSchema,
          value: { ...approvedPlugin, version: "native-build.1" },
          source: "versioned native plugin fixture",
        }),
      ],
      skills: [],
    },
  },
];
const plugin = approvedPlugin;
export const rejectedInventories: { label: string; rawInit: Record<string, unknown> }[] = [
  { label: "missing plugins", rawInit: { plugins: undefined } },
  { label: "missing skills", rawInit: { skills: undefined } },
  ...[null, {}, "plugins", 42].map((plugins) => ({
    label: `non-array plugins ${JSON.stringify(plugins)}`,
    rawInit: { plugins },
  })),
  ...[null, {}, "skills", 42, [null], [42]].map((skills) => ({
    label: `malformed skills ${JSON.stringify(skills)}`,
    rawInit: { skills },
  })),
  ...[null, [], "plugin", 42, {}].map((record) => ({
    label: `malformed plugin record ${JSON.stringify(record)}`,
    rawInit: { plugins: [record] },
  })),
  ...[
    { name: plugin.name, path: plugin.path },
    { ...plugin, source: `${plugin.source}-foreign` },
    { ...plugin, source: `${plugin.name}@other-registry` },
    { ...plugin, source: null },
    { ...plugin, source: 42 },
    { ...plugin, source: "" },
    { ...plugin, name: `${plugin.name}-unknown` },
    { ...plugin, path: "/private/forged/builtin" },
    { ...plugin, path: "builtin/" },
    { ...plugin, path: undefined },
    { ...plugin, path: null },
    { ...plugin, path: 42 },
    { ...plugin, version: null },
    { ...plugin, version: 42 },
    { ...plugin, version: {} },
    { ...plugin, version: "" },
    { ...plugin, version: "x".repeat(COMPONENT_LIMITS.identityChars + 1) },
    { ...plugin, enabled: true },
  ].map((record, index) => ({
    label: `forged native plugin ${index}`,
    rawInit: { plugins: [record] },
  })),
  { label: "duplicate singleton", rawInit: { plugins: [plugin, plugin] } },
  {
    label: "unknown builtin suffix",
    rawInit: { plugins: [{ name: "unknown", source: "unknown@builtin", path: plugin.path }] },
  },
  ...Object.keys(DISABLED_PLUGINS).map((source) => ({
    label: `managed-forced additional ${source}`,
    rawInit: {
      plugins: [plugin, { name: source.split("@")[0], source, path: plugin.path }],
    },
  })),
  ...Object.keys(DISABLED_SKILLS).map((skill) => ({
    label: `advertised disabled skill ${skill}`,
    rawInit: { plugins: [plugin], skills: [skill] },
  })),
  { label: "unknown advertised skill", rawInit: { skills: ["unknown-skill"] } },
];
