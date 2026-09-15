import { describe, expect, it } from "vitest";
import { createExtensionHarness } from "../integrationTests/support/extensionHarness";
import {
  createProfileAuthoringFlow,
  isProfileAuthoringAbort,
} from "./profileAuthoringFlow";

describe("profile authoring flow", () => {
  it("consumes literal Ctrl+C, aborts pending stock dialogs, and passes the shared signal", async () => {
    const harness = createExtensionHarness({ pendingStockUi: true });
    const flow = createProfileAuthoringFlow({ ctx: harness.context });

    const input = flow.input({ title: "Name", placeholder: "profile" });
    await harness.ui.waitForInput();
    harness.ui.sendTerminalInput({ data: "\x03" });

    const result = await input;
    expect(isProfileAuthoringAbort(result)).toBe(true);
    expect(harness.ui.input).toHaveBeenCalledWith("Name", "profile", {
      signal: flow.signal,
    });
    await expect(
      flow.confirm({ title: "Discard", message: "Discard?" }),
    ).resolves.toSatisfy(isProfileAuthoringAbort);
    expect(harness.ui.confirm).not.toHaveBeenCalled();
  });

  it("settles a custom component once when Ctrl+C races its normal completion", async () => {
    const harness = createExtensionHarness({ interactiveUi: true });
    const flow = createProfileAuthoringFlow({ ctx: harness.context });
    const pending = flow.custom({
      factory: (_tui, _theme, _keybindings, done) => ({
        invalidate: () => undefined,
        render: () => ["Authoring component"],
        handleInput: (data) => {
          if (data === "\n") done("completed");
        },
      }),
    });
    const modal = await harness.ui.waitForCustomModal();

    harness.ui.sendTerminalInput({ data: "\x03" });
    modal.press("Enter");

    await expect(pending).resolves.toSatisfy(isProfileAuthoringAbort);
    expect(flow.signal.aborted).toBe(true);
  });

  it("does not remap Escape, unsubscribes idempotently, and leaves later raw input alone", async () => {
    const harness = createExtensionHarness({ inputResults: ["continues"] });
    const flow = createProfileAuthoringFlow({ ctx: harness.context });
    harness.ui.sendTerminalInput({ data: "\x1b" });
    expect(flow.signal.aborted).toBe(false);

    flow.dispose();
    flow.dispose();
    expect(harness.ui.onTerminalInput).toHaveBeenCalledTimes(1);

    const input = flow.input({ title: "Still local" });
    harness.ui.sendTerminalInput({ data: "\x03" });
    await expect(input).resolves.toBe("continues");
  });
});
