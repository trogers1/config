import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  Key,
  matchesKey,
  type Component,
  type KeybindingsManager,
  type TUI,
} from "@earendil-works/pi-tui";

const profileAuthoringAbort = Symbol("profile-authoring-abort");

export type ProfileAuthoringAbort = typeof profileAuthoringAbort;
export type ProfileAuthoringFlowResult<T> = T | ProfileAuthoringAbort;

export function isProfileAuthoringAbort<T>(
  value: ProfileAuthoringFlowResult<T>,
): value is ProfileAuthoringAbort {
  return value === profileAuthoringAbort;
}

type ProfileAuthoringCustomFactory<T> = (
  tui: TUI,
  theme: Theme,
  keybindings: KeybindingsManager,
  done: (result: T) => void,
) => Component & { dispose?(): void };

/** Narrow custom-dialog capability injected only into profile authoring screens. */
export type ProfileAuthoringCustom = <T>({
  factory,
}: {
  readonly factory: ProfileAuthoringCustomFactory<T>;
}) => Promise<ProfileAuthoringFlowResult<T>>;

export async function showProfileAuthoringCustom<T>({
  ctx,
  custom,
  factory,
}: {
  readonly ctx: { readonly ui: Pick<ExtensionContext["ui"], "custom"> };
  readonly custom?: ProfileAuthoringCustom;
  readonly factory: ProfileAuthoringCustomFactory<T>;
}): Promise<ProfileAuthoringFlowResult<T>> {
  return custom ? await custom({ factory }) : await ctx.ui.custom(factory);
}

export type ProfileAuthoringFlow = {
  readonly signal: AbortSignal;
  readonly custom: ProfileAuthoringCustom;
  input: ({
    title,
    placeholder,
  }: {
    readonly title: string;
    readonly placeholder?: string;
  }) => Promise<ProfileAuthoringFlowResult<string | undefined>>;
  confirm: ({
    title,
    message,
  }: {
    readonly title: string;
    readonly message: string;
  }) => Promise<ProfileAuthoringFlowResult<boolean>>;
  dispose: () => void;
};

/**
 * Adds a command-local Ctrl+C meaning without changing ordinary extension UI.
 * The raw listener precedes focused components, so it also covers custom forms
 * which intentionally retain Escape as their local Back action.
 */
export function createProfileAuthoringFlow({
  ctx,
}: {
  readonly ctx: {
    readonly ui: Pick<
      ExtensionContext["ui"],
      "onTerminalInput" | "input" | "confirm" | "custom"
    >;
  };
}): ProfileAuthoringFlow {
  const controller = new AbortController();
  let disposed = false;
  let completeCustomAbort: (() => void) | undefined;
  const abort = () => {
    if (!controller.signal.aborted) controller.abort();
    completeCustomAbort?.();
  };
  const unsubscribe = ctx.ui.onTerminalInput((data) => {
    if (!matchesKey(data, Key.ctrl("c"))) return undefined;
    abort();
    return { consume: true };
  });
  const aborted = <T>({
    value,
  }: {
    readonly value: T;
  }): ProfileAuthoringFlowResult<T> =>
    controller.signal.aborted ? profileAuthoringAbort : value;
  const abortable = <T>(
    pending: Promise<T>,
  ): Promise<ProfileAuthoringFlowResult<T>> => {
    if (controller.signal.aborted)
      return Promise.resolve(profileAuthoringAbort);
    return new Promise((resolve, reject) => {
      const onAbort = () => resolve(profileAuthoringAbort);
      controller.signal.addEventListener("abort", onAbort, { once: true });
      void pending.then(
        (value) => {
          controller.signal.removeEventListener("abort", onAbort);
          resolve(aborted({ value }));
        },
        (error: unknown) => {
          controller.signal.removeEventListener("abort", onAbort);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  };

  const custom: ProfileAuthoringCustom = async <T>({
    factory,
  }: {
    readonly factory: ProfileAuthoringCustomFactory<T>;
  }) => {
    if (controller.signal.aborted) return profileAuthoringAbort;
    let settled = false;
    const complete = (
      done: (value: ProfileAuthoringFlowResult<T>) => void,
      value: ProfileAuthoringFlowResult<T>,
    ) => {
      if (settled) return;
      settled = true;
      completeCustomAbort = undefined;
      done(value);
    };
    const value = await ctx.ui.custom<ProfileAuthoringFlowResult<T>>(
      (tui, theme, keybindings, done) => {
        completeCustomAbort = () => complete(done, profileAuthoringAbort);
        return factory(tui, theme, keybindings, (result) =>
          complete(done, result),
        );
      },
    );
    return controller.signal.aborted ? profileAuthoringAbort : value;
  };

  return {
    signal: controller.signal,
    custom,
    async input({ title, placeholder }) {
      if (controller.signal.aborted) return profileAuthoringAbort;
      return await abortable(
        ctx.ui.input(title, placeholder, { signal: controller.signal }),
      );
    },
    async confirm({ title, message }) {
      if (controller.signal.aborted) return profileAuthoringAbort;
      return await abortable(
        ctx.ui.confirm(title, message, { signal: controller.signal }),
      );
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      completeCustomAbort = undefined;
      unsubscribe();
    },
  };
}
