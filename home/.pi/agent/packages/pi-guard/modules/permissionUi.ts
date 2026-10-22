import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

// InteractiveMode has one non-overlay editor slot. Queue the whole permission
// interaction, not individual screens: remember/back/denial screens share it.
// Key by the actual UI binding so independent sessions never block each other.
const pendingInteractions = new WeakMap<
  ExtensionContext["ui"],
  Promise<void>
>();
const cancelled = Symbol("permission-ui-cancelled");

function withCancellableCustom({
  ctx,
  signal,
}: {
  readonly ctx: ExtensionContext;
  readonly signal: AbortSignal | undefined;
}): ExtensionContext {
  const ui = ctx.ui;
  const custom: typeof ui.custom = async <T>(
    factory: Parameters<typeof ui.custom<T>>[0],
    options: Parameters<typeof ui.custom<T>>[1],
  ): Promise<T> => {
    signal?.throwIfAborted();
    let onAbort: (() => void) | undefined;
    try {
      const result = await ui.custom<T | typeof cancelled>(
        (tui, theme, keys, done) => {
          onAbort = () => done(cancelled);
          signal?.addEventListener("abort", onAbort, { once: true });
          if (signal?.aborted) onAbort();
          return factory(tui, theme, keys, done);
        },
        options,
      );
      signal?.throwIfAborted();
      if (result === cancelled)
        throw new Error("Permission interaction aborted");
      return result;
    } finally {
      if (onAbort) signal?.removeEventListener("abort", onAbort);
    }
  };
  return { ...ctx, ui: { ...ui, custom } };
}

export async function withPermissionInteraction<T>({
  ctx,
  run,
}: {
  readonly ctx: ExtensionContext;
  readonly run: (options: { readonly ctx: ExtensionContext }) => Promise<T>;
}): Promise<T> {
  const ui = ctx.ui;
  const signal = ctx.signal;
  signal?.throwIfAborted();
  const previous = pendingInteractions.get(ui) ?? Promise.resolve();
  let release = () => {};
  const finished = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => finished);
  pendingInteractions.set(ui, tail);
  let onAbort: (() => void) | undefined;
  try {
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new Error("Permission interaction aborted"));
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
    await Promise.race([previous, aborted]);
    signal?.throwIfAborted();
    return await run({ ctx: withCancellableCustom({ ctx, signal }) });
  } finally {
    if (onAbort) signal?.removeEventListener("abort", onAbort);
    release();
    // A cancelled queued request must not let a later request bypass the owner.
    void tail.then(() => {
      if (pendingInteractions.get(ui) === tail) pendingInteractions.delete(ui);
    });
  }
}
