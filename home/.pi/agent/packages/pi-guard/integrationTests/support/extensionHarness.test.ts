import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { TuiMainScreen, type Component } from "@earendil-works/pi-tui";
import {
  createExtensionHarness,
  getLiveExtensionHarnessCountForTesting,
  HarnessDisposedError,
  InvalidInteractionRepeatError,
} from "./extensionHarness";

async function expectNoUnhandledRejection(operation: () => Promise<void>) {
  const unhandled = vi.fn();
  process.on("unhandledRejection", unhandled);
  try {
    await operation();
    // Node reports unhandled rejections on a later turn.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(unhandled).not.toHaveBeenCalled();
  } finally {
    process.off("unhandledRejection", unhandled);
  }
}

const component = (): Component => ({
  render: () => [],
  invalidate: () => undefined,
});

const confirmed: Awaited<ReturnType<ExtensionContext["ui"]["confirm"]>> = true;

function createUnhandledRejectionListener() {
  return vi.fn<(reason: unknown, promise: Promise<unknown>) => void>();
}

let automaticCleanupUnhandled:
  ReturnType<typeof createUnhandledRejectionListener> | undefined;

describe("extension harness lifecycle and strict interactions", () => {
  it("fails immediately when a strict confirmation script is exhausted", async () => {
    const harness = createExtensionHarness({
      interactionScript: [
        { kind: "confirm", title: "first", response: confirmed },
      ],
    });

    await expect(harness.ui.confirm("first", "message")).resolves.toBe(
      confirmed,
    );
    expect(() => {
      harness.ui.confirm("second", "message");
    }).toThrow(/script exhausted.*Consumed/s);
  });

  it("reports the expected and received prompt on a strict mismatch", () => {
    const harness = createExtensionHarness({
      interactionScript: [
        { kind: "select", title: "expected picker", response: "allow" },
      ],
    });

    expect(() => {
      harness.ui.select("received picker", ["allow"]);
    }).toThrow(/Expected select\(expected picker\).*received picker.*Pending/s);
  });

  it("reuses a single repeated item with a stateful fingerprint", async () => {
    const harness = createExtensionHarness({
      interactionScript: [
        {
          kind: "confirm",
          title: /Repeat/g,
          response: confirmed,
          repeat: 2,
        },
      ],
    });

    await expect(harness.ui.confirm("Repeat", "first")).resolves.toBe(
      confirmed,
    );
    await expect(harness.ui.confirm("Repeat", "second")).resolves.toBe(
      confirmed,
    );
    expect(() => harness.assertInteractionsDrained()).not.toThrow();
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid strict interaction repeat %s",
    (repeat) => {
      expect(() =>
        createExtensionHarness({
          interactionScript: [{ kind: "confirm", response: true, repeat }],
        }),
      ).toThrow(InvalidInteractionRepeatError);
    },
  );

  it("reports undrained strict interactions", () => {
    const harness = createExtensionHarness({
      interactionScript: [{ kind: "confirm", response: true }],
    });

    expect(() => harness.assertInteractionsDrained()).toThrow(/not drained/);
  });

  it("delivers raw terminal input to ordered listeners, honoring transforms and consumption", () => {
    const harness = createExtensionHarness();
    const seen: string[] = [];
    harness.context.ui.onTerminalInput((data) => {
      seen.push(`first:${data}`);
      return { data: "transformed" };
    });
    harness.context.ui.onTerminalInput((data) => {
      seen.push(`second:${data}`);
      return { consume: true };
    });
    harness.context.ui.onTerminalInput((data) => {
      seen.push(`third:${data}`);
      return undefined;
    });

    harness.ui.sendTerminalInput({ data: "raw" });

    expect(seen).toEqual(["first:raw", "second:transformed"]);
  });

  it("models stock-dialog abort settlement and removes its abort listeners", async () => {
    const harness = createExtensionHarness({ pendingStockUi: true });
    const controller = new AbortController();
    const input = harness.ui.input("Name", "profile", {
      signal: controller.signal,
    }) as ReturnType<ExtensionContext["ui"]["input"]>;
    const select = harness.ui.select("Choose", ["one"], {
      signal: controller.signal,
    }) as ReturnType<ExtensionContext["ui"]["select"]>;
    const confirm = harness.ui.confirm("Confirm", "Continue?", {
      signal: controller.signal,
    }) as ReturnType<ExtensionContext["ui"]["confirm"]>;
    await Promise.all([
      harness.ui.waitForInput(),
      harness.ui.waitForSelection(),
      harness.ui.waitForConfirmation(),
    ]);

    controller.abort();

    await expect(input).resolves.toBeUndefined();
    await expect(select).resolves.toBeUndefined();
    await expect(confirm).resolves.toBe(false);
    await expect(harness.dispose()).resolves.toBeUndefined();
  });

  it("rejects an abandoned real select promise without an unhandled rejection", async () => {
    const harness = createExtensionHarness({ interactiveUi: true });
    const pending = harness.ui.select("Choose", ["one"]) as Promise<
      string | undefined
    >;

    await expectNoUnhandledRejection(() => harness.dispose());
    await expect(pending).rejects.toBeInstanceOf(HarnessDisposedError);
  });

  it("rejects an abandoned real custom promise without an unhandled rejection", async () => {
    const harness = createExtensionHarness({ interactiveUi: true });
    const pending = harness.ui.custom(component) as Promise<unknown>;

    await expectNoUnhandledRejection(() => harness.dispose());
    await expect(pending).rejects.toBeInstanceOf(HarnessDisposedError);
  });

  it("shares concurrent shutdown and disposal, dispatching all handlers once", async () => {
    const harness = createExtensionHarness();
    const calls: string[] = [];
    let releaseFirst: () => void = () => undefined;
    let signalFirstStarted: () => void = () => undefined;
    const firstStarted = new Promise<void>((resolve) => {
      signalFirstStarted = resolve;
    });
    const firstComplete = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    harness.onSessionShutdown(async () => {
      calls.push("first:start");
      signalFirstStarted();
      await firstComplete;
      calls.push("first:end");
    });
    harness.onSessionShutdown(() => {
      calls.push("second");
    });
    await harness.start();

    const shutdown = harness.shutdown();
    const disposal = harness.dispose();
    expect(disposal).toBe(shutdown);
    await firstStarted;
    expect(calls).toEqual(["first:start"]);
    releaseFirst();
    await Promise.all([shutdown, disposal, harness.shutdown()]);

    expect(calls).toEqual(["first:start", "first:end", "second"]);
  });

  it("continues TUI and component cleanup after every individual failure", async () => {
    const harness = createExtensionHarness({ tuiMode: true });
    const disposed: ReturnType<typeof vi.fn>[] = [];
    const componentError = new Error("component cleanup failed");
    let shouldThrowComponentError = true;
    const factory = () => {
      const dispose = vi.fn(() => {
        if (shouldThrowComponentError) {
          shouldThrowComponentError = false;
          throw componentError;
        }
      });
      disposed.push(dispose);
      return { ...component(), dispose };
    };
    const stopError = new Error("TUI stop failed");
    const throwingStop = vi.fn(() => {
      throw stopError;
    });
    vi.spyOn(TuiMainScreen.prototype, "stop").mockImplementationOnce(
      throwingStop,
    );

    await harness.ui.custom(factory);
    await harness.ui.custom(factory);
    let disposalFailure: unknown;
    try {
      await harness.dispose();
    } catch (error) {
      disposalFailure = error;
    }
    expect(disposalFailure).toBeInstanceOf(AggregateError);
    const aggregate = disposalFailure as AggregateError;
    expect(aggregate.errors).toEqual(
      expect.arrayContaining([stopError, componentError]),
    );

    expect(throwingStop).toHaveBeenCalledTimes(1);
    expect(harness.tuiStopCount).toBe(1);
    expect(disposed).toHaveLength(4);
    expect(disposed.every((dispose) => dispose.mock.calls.length === 1)).toBe(
      true,
    );
    vi.restoreAllMocks();
  });

  it("stops mounted regular-screen TUI terminals during disposal", async () => {
    const harness = createExtensionHarness({ tuiMode: true });

    await harness.ui.custom(component);
    await harness.dispose();

    expect(harness.tuiStopCount).toBe(1);
  });

  it("automatically disposes an abandoned real select without unhandled rejection", () => {
    automaticCleanupUnhandled = createUnhandledRejectionListener();
    process.on("unhandledRejection", automaticCleanupUnhandled);
    createExtensionHarness({ interactiveUi: true }).ui.select("Choose", [
      "one",
    ]);
  });

  it("finishes automatic pending-promise cleanup without an unhandled event", async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(automaticCleanupUnhandled).toBeDefined();
    expect(automaticCleanupUnhandled).not.toHaveBeenCalled();
    process.off("unhandledRejection", automaticCleanupUnhandled!);
    automaticCleanupUnhandled = undefined;
    expect(getLiveExtensionHarnessCountForTesting()).toBe(0);
  });

  it("registers a harness for automatic cleanup", () => {
    createExtensionHarness();
    expect(getLiveExtensionHarnessCountForTesting()).toBeGreaterThan(0);
  });

  it("automatically disposes the preceding test's harness", () => {
    expect(getLiveExtensionHarnessCountForTesting()).toBe(0);
  });
});
