import { definePolicyConfig } from "../policyHelpers";
import { baseCompositionChain, baseProfile } from "./base";
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

const configuredPolicy = definePolicyConfig({
  defaultProfile: "builtin:default",
  profiles: {
    "builtin:default": baseProfile,
    "builtin:worker": workerProfile,
    "builtin:read-only": readOnlyProfile,
    "builtin:tests-hidden": testsHiddenProfile,
    "builtin:tests-only": testsOnlyProfile,
    "builtin:committer": committerProfile,
    "builtin:reviewer": reviewerProfile,
    "builtin:scribe-only": scribeOnlyProfile,
    "builtin:deps-mutator": depsMutatorProfile,
    "builtin:no-shell": noShellProfile,
    "builtin:implementation-only": implementationOnlyProfile,
    "builtin:git-full": gitFullProfile,
  },
});

function deepFreeze<T extends object>(value: T): T {
  for (const key of Reflect.ownKeys(value) as (keyof T)[]) {
    const prop = value[key];
    if (prop && typeof prop === "object" && !Object.isFrozen(prop)) {
      deepFreeze(prop);
    }
  }
  return Object.freeze(value);
}

/** Portable profiles shipped by the package. Local profiles live in user config. */
export const policyConfig = deepFreeze(configuredPolicy);

/** Ordered provenance used by the explainer for shipped profiles. */
export const builtinCompositionChains: Record<string, readonly string[]> = {
  "builtin:default": baseCompositionChain,
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
};
