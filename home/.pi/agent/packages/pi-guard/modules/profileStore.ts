import {
  loadProfileConfigSnapshot,
  resolveProfileConfigPath,
  warnOnProfileConfigSnapshotRuleConflicts,
  type ProfileConfigSnapshot,
} from "./profileConfig";
import type { PolicyConfig } from "./policyHelpers";

export const profileStoreStatus = {
  uninitialized: "uninitialized",
  unchanged: "unchanged",
  refreshed: "refreshed",
  missing: "missing",
  invalid: "invalid",
} as const;

type ProfileStoreStatus =
  (typeof profileStoreStatus)[keyof typeof profileStoreStatus];
type UsableProfileStoreStatus =
  typeof profileStoreStatus.unchanged | typeof profileStoreStatus.refreshed;
type FailedProfileStoreStatus = Exclude<
  ProfileStoreStatus,
  UsableProfileStoreStatus
>;

export type UsableProfileStoreState = {
  readonly status: UsableProfileStoreStatus;
  readonly snapshot: ProfileConfigSnapshot;
};
type FailedProfileStoreState = {
  readonly status: FailedProfileStoreStatus;
  readonly error?: Error;
};
export type ProfileStoreState =
  UsableProfileStoreState | FailedProfileStoreState;
export type ProfileStoreRefreshResult = ProfileStoreState;

export type ProfileStore = object;
type ProfileStoreData = {
  readonly fallback: PolicyConfig;
  readonly configPath: string;
  /** A persisted source was adopted, so losing it may not broaden to fallback. */
  hasLoadedFile: boolean;
  /** Conflict diagnostics already emitted by this runtime store, keyed by source. */
  warnedSourceRevisions: Set<string>;
  state: ProfileStoreState;
};
const profileStoreData = new WeakMap<ProfileStore, ProfileStoreData>();

function dataFor({
  store,
}: {
  readonly store: ProfileStore;
}): ProfileStoreData {
  const data = profileStoreData.get(store);
  if (!data) throw new Error("unknown profile store");
  return data;
}

/**
 * Stores are deliberately profile-agnostic. A caller must resolve authority
 * from the returned snapshot and then validate that selected profile. Keeping
 * selection outside the loader prevents an old active selection from rejecting
 * a valid replacement snapshot before its new directory/default metadata is
 * considered.
 */
export function createProfileStore({
  fallback,
  configPath,
}: {
  readonly fallback: PolicyConfig;
  readonly configPath?: string;
}): ProfileStore {
  const store = {};
  profileStoreData.set(store, {
    fallback,
    configPath: resolveProfileConfigPath({ configPath }),
    hasLoadedFile: false,
    warnedSourceRevisions: new Set<string>(),
    state: { status: profileStoreStatus.uninitialized },
  });
  return store;
}

function failedState({
  status,
  error,
}: {
  readonly status: FailedProfileStoreStatus;
  readonly error?: Error;
}): FailedProfileStoreState {
  return error === undefined ? { status } : { status, error };
}

type ProfileStoreStateArgument = { readonly state: ProfileStoreState };
type UsableProfileStoreStateArgument = {
  readonly state: UsableProfileStoreState;
};

export function isUsableProfileStoreState(
  argument: ProfileStoreStateArgument,
): argument is UsableProfileStoreStateArgument {
  return (
    argument.state.status === profileStoreStatus.unchanged ||
    argument.state.status === profileStoreStatus.refreshed
  );
}

/** Extract a usable snapshot without exposing a mutable store implementation. */
export function profileStoreSnapshot({
  state,
}: ProfileStoreStateArgument): ProfileConfigSnapshot | undefined {
  if (state.status === profileStoreStatus.unchanged) return state.snapshot;
  if (state.status === profileStoreStatus.refreshed) return state.snapshot;
  return undefined;
}

function usableSnapshot({
  state,
}: {
  readonly state: ProfileStoreState;
}): ProfileConfigSnapshot | undefined {
  return profileStoreSnapshot({ state });
}

export function refreshProfileStore({
  store,
}: {
  readonly store: ProfileStore;
}): ProfileStoreRefreshResult {
  const data = dataFor({ store });
  let snapshot: ProfileConfigSnapshot;
  try {
    snapshot = loadProfileConfigSnapshot({
      fallback: data.fallback,
      configPath: data.configPath,
      // Store-owned deduplication preserves normal direct-loader linting.
      lintConflicts: false,
    });
  } catch (error) {
    const state = failedState({
      status: profileStoreStatus.invalid,
      error: error instanceof Error ? error : new Error(String(error)),
    });
    data.state = state;
    return state;
  }

  // A missing file remains optional only before any persisted source has been
  // adopted. This applies equally to explicit and resolved default paths.
  if (snapshot.raw === undefined && data.hasLoadedFile) {
    const state = failedState({ status: profileStoreStatus.missing });
    data.state = state;
    return state;
  }
  if (snapshot.raw !== undefined) data.hasLoadedFile = true;

  if (
    snapshot.raw !== undefined &&
    !data.warnedSourceRevisions.has(snapshot.sourceRevision)
  ) {
    warnOnProfileConfigSnapshotRuleConflicts({ snapshot });
    data.warnedSourceRevisions.add(snapshot.sourceRevision);
  }

  const previousSnapshot = usableSnapshot({ state: data.state });
  const status =
    previousSnapshot?.sourceRevision === snapshot.sourceRevision
      ? profileStoreStatus.unchanged
      : profileStoreStatus.refreshed;
  const state: UsableProfileStoreState = { status, snapshot };
  data.state = state;
  return state;
}

export function currentProfileStoreState({
  store,
}: {
  readonly store: ProfileStore;
}): ProfileStoreState {
  return dataFor({ store }).state;
}
