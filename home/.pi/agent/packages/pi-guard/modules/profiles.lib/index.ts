import {
  applyImplicitAskTransforms,
  definePolicyConfig,
  finalizeResolvedProfile,
  profileTransformNames,
  runtimeRequirementProvenanceFor,
  type BuiltinProfileName,
  type ProfilePolicy,
  type ProfileTransformName,
} from "../policyHelpers";
import {
  ruleSetDefinition,
  ruleSetNames,
  type RuleSetName,
} from "../ruleSets.lib/index";
import type { RuntimeRequirementName } from "../runtimeRequirements";
import {
  baseCompositionChain,
  baseProfile,
  defaultWithNetCompositionChain,
  defaultWithNetProfile,
} from "./base";
import {
  readOnlyCompositionChain,
  readOnlyProfile,
  workerCompositionChain,
  workerProfile,
} from "./core";
import {
  committerCompositionChain,
  committerProfile,
  gitFullCompositionChain,
  gitFullProfile,
} from "./git";
import {
  depsMutatorCompositionChain,
  depsMutatorProfile,
  noShellCompositionChain,
  noShellProfile,
  reviewerCompositionChain,
  reviewerProfile,
  scribeOnlyCompositionChain,
  scribeOnlyProfile,
} from "./scoped";
import {
  implementationOnlyCompositionChain,
  implementationOnlyProfile,
  testsHiddenCompositionChain,
  testsHiddenProfile,
  testsOnlyCompositionChain,
  testsOnlyProfile,
} from "./testWorkflows";

const builtinCompositionChains = {
  "builtin:default": baseCompositionChain,
  "builtin:default-with-net": defaultWithNetCompositionChain,
  "builtin:worker": workerCompositionChain,
  "builtin:read-only": readOnlyCompositionChain,
  "builtin:tests-hidden": testsHiddenCompositionChain,
  "builtin:tests-only": testsOnlyCompositionChain,
  "builtin:committer": committerCompositionChain,
  "builtin:reviewer": reviewerCompositionChain,
  "builtin:scribe-only": scribeOnlyCompositionChain,
  "builtin:deps-mutator": depsMutatorCompositionChain,
  "builtin:no-shell": noShellCompositionChain,
  "builtin:implementation-only": implementationOnlyCompositionChain,
  "builtin:git-full": gitFullCompositionChain,
} as const satisfies Record<BuiltinProfileName, readonly string[]>;

/**
 * Resolve runtime requirements from the same ordered recipe that documents a
 * built-in profile. Requirements are never maintained beside composition.
 */
function selectorsInComposition({
  chain,
}: {
  readonly chain: readonly string[];
}): RuleSetName[] {
  const knownSelectors = ruleSetNames();
  for (const name of chain) {
    if (
      name.startsWith("ruleset:") &&
      !knownSelectors.some((selector) => selector === name)
    ) {
      throw new Error(`Unknown rule set in built-in composition: '${name}'`);
    }
  }
  return knownSelectors.filter((selector) => chain.includes(selector));
}

function isProfileTransformName(name: string): name is ProfileTransformName {
  return profileTransformNames.some((transform) => transform === name);
}

function resolveCompositionRuntime({
  chain,
}: {
  readonly chain: readonly string[];
}) {
  const selectors = selectorsInComposition({ chain });
  const requirements = [
    ...new Set(
      selectors.flatMap(
        (name) => ruleSetDefinition({ name }).runtimeRequirements,
      ),
    ),
  ];
  const provenance = runtimeRequirementProvenanceFor({
    requirements,
    provenance: requirements.reduce<
      Partial<Record<RuntimeRequirementName, readonly string[]>>
    >((result, requirement) => {
      result[requirement] = selectors.filter((selector) =>
        ruleSetDefinition({ name: selector }).runtimeRequirements.includes(
          requirement,
        ),
      );
      return result;
    }, {}),
  });
  return {
    implicitAskDecision: applyImplicitAskTransforms({
      transforms: chain.filter(isProfileTransformName),
    }),
    requirements,
    provenance,
  };
}

/** A runtime-bearing workflow must contribute its declared policy. */
function assertRuntimeWorkflowIsComposed({
  policy,
  chain,
}: {
  readonly policy: ProfilePolicy;
  readonly chain: readonly string[];
}): void {
  for (const name of selectorsInComposition({ chain })) {
    const definition = ruleSetDefinition({ name });
    if (definition.runtimeRequirements.length > 0) {
      for (const rule of definition.policy.tools?.bash ?? []) {
        if (
          !policy.tools.bash?.some(
            (candidate) =>
              candidate.pattern === rule.pattern &&
              candidate.decision === rule.decision,
          )
        ) {
          throw new Error(
            `Built-in composition '${name}' selects runtime requirements without its policy rule '${rule.pattern}'`,
          );
        }
      }
    }
  }
}

function resolvedBuiltin({
  policy,
  chain,
}: {
  readonly policy: ProfilePolicy;
  readonly chain: readonly string[];
}) {
  assertRuntimeWorkflowIsComposed({ policy, chain });
  const runtime = resolveCompositionRuntime({ chain });
  return finalizeResolvedProfile({ policy, runtime });
}

const configuredPolicy = definePolicyConfig({
  defaultProfile: "builtin:default",
  profiles: {
    "builtin:default": resolvedBuiltin({
      policy: baseProfile,
      chain: builtinCompositionChains["builtin:default"],
    }),
    "builtin:default-with-net": resolvedBuiltin({
      policy: defaultWithNetProfile,
      chain: builtinCompositionChains["builtin:default-with-net"],
    }),
    "builtin:worker": resolvedBuiltin({
      policy: workerProfile,
      chain: builtinCompositionChains["builtin:worker"],
    }),
    "builtin:read-only": resolvedBuiltin({
      policy: readOnlyProfile,
      chain: builtinCompositionChains["builtin:read-only"],
    }),
    "builtin:tests-hidden": resolvedBuiltin({
      policy: testsHiddenProfile,
      chain: builtinCompositionChains["builtin:tests-hidden"],
    }),
    "builtin:tests-only": resolvedBuiltin({
      policy: testsOnlyProfile,
      chain: builtinCompositionChains["builtin:tests-only"],
    }),
    "builtin:committer": resolvedBuiltin({
      policy: committerProfile,
      chain: builtinCompositionChains["builtin:committer"],
    }),
    "builtin:reviewer": resolvedBuiltin({
      policy: reviewerProfile,
      chain: builtinCompositionChains["builtin:reviewer"],
    }),
    "builtin:scribe-only": resolvedBuiltin({
      policy: scribeOnlyProfile,
      chain: builtinCompositionChains["builtin:scribe-only"],
    }),
    "builtin:deps-mutator": resolvedBuiltin({
      policy: depsMutatorProfile,
      chain: builtinCompositionChains["builtin:deps-mutator"],
    }),
    "builtin:no-shell": resolvedBuiltin({
      policy: noShellProfile,
      chain: builtinCompositionChains["builtin:no-shell"],
    }),
    "builtin:implementation-only": resolvedBuiltin({
      policy: implementationOnlyProfile,
      chain: builtinCompositionChains["builtin:implementation-only"],
    }),
    "builtin:git-full": resolvedBuiltin({
      policy: gitFullProfile,
      chain: builtinCompositionChains["builtin:git-full"],
    }),
  },
});

function deepFreeze({ value }: { readonly value: unknown }): void {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return;
  }
  for (const child of Object.values(value)) deepFreeze({ value: child });
  Object.freeze(value);
}

deepFreeze({ value: configuredPolicy });
/** Portable profiles shipped by the package. Local profiles live in user config. */
export const policyConfig = configuredPolicy;

/** Resolve a shipped explanation chain without asserting an unchecked key. */
export function builtinCompositionChain({
  name,
}: {
  readonly name: string;
}): readonly string[] | undefined {
  return Object.entries(builtinCompositionChains).find(
    ([candidate]) => candidate === name,
  )?.[1];
}

/** Ordered provenance used by catalog checks for shipped profiles. */
export { builtinCompositionChains };
