import { definePolicyConfig } from "../policyHelpers";
import { baseProfile } from "./base";
import { readOnlyProfile, workerProfile } from "./core";
import { committerProfile, gitFullProfile } from "./git";
import {
  depsMutatorProfile,
  noShellProfile,
  reviewerProfile,
  scribeOnlyProfile,
} from "./scoped";
import {
  implementationOnlyProfile,
  testsHiddenProfile,
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
