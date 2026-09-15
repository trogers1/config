import {
  createSyntheticSourceInfo,
  type BeforeAgentStartEvent,
  type BeforeAgentStartEventResult,
  type CustomEntry,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type ExtensionHandler,
  type RegisteredCommand,
  type SessionEntry as SdkSessionEntry,
  type SessionShutdownEvent,
  type SessionStartEvent,
  type ToolCallEvent,
  type ToolCallEventResult,
  type ToolDefinition,
  type UserBashEvent,
  type UserBashEventResult,
} from "@earendil-works/pi-coding-agent";
import { afterEach, expect, vi, type Mock } from "vitest";
import {
  KeybindingsManager,
  TUI_KEYBINDINGS,
  TuiMainScreen,
  isFocusable,
  type Component,
  type Terminal,
} from "@earendil-works/pi-tui";
import permissionsExtension from "../../extensions/guard";
import {
  ProfileAuthoringOverview,
  type ProfileAuthoringOverviewSelection,
} from "../../modules/profileAuthoringOverview";
import { askPermissionChoices } from "../../modules/profileUpdate";

const harnessViewport = { columns: 160, rows: 50 } as const;
type AskPermissionChoice = (typeof askPermissionChoices)[number];

class HarnessTerminal implements Terminal {
  readonly columns = harnessViewport.columns;
  readonly rows = harnessViewport.rows;
  readonly kittyProtocolActive = false;
  private onInput: (data: string) => void = () => undefined;
  stopCount = 0;

  start(onInput: (data: string) => void): void {
    this.onInput = onInput;
  }
  feed(data: string): void {
    this.onInput(data);
  }
  stop(): void {
    this.stopCount++;
  }
  async drainInput(): Promise<void> {}
  write(): void {}
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
}

type CommandRegistration = Omit<RegisteredCommand, "name" | "sourceInfo">;
type ShortcutRegistration = Parameters<ExtensionAPI["registerShortcut"]>[1];

type SessionEntryInput =
  | SdkSessionEntry
  | (Partial<CustomEntry> & {
      type: "custom";
      customType: string;
    });

type SelectArguments = Parameters<ExtensionContext["ui"]["select"]>;
type ConfirmArguments = Parameters<ExtensionContext["ui"]["confirm"]>;
type InputArguments = Parameters<ExtensionContext["ui"]["input"]>;
type EditorArguments = Parameters<ExtensionContext["ui"]["editor"]>;
type SelectResponse = Awaited<ReturnType<ExtensionContext["ui"]["select"]>>;
type ConfirmResponse = Awaited<ReturnType<ExtensionContext["ui"]["confirm"]>>;
type InputResponse = Awaited<ReturnType<ExtensionContext["ui"]["input"]>>;
type EditorResponse = Awaited<ReturnType<ExtensionContext["ui"]["editor"]>>;

type PromptFingerprint = string | RegExp;
type TerminalInputHandler = Parameters<
  ExtensionContext["ui"]["onTerminalInput"]
>[0];

export type ScriptedInteraction =
  | {
      kind: "confirm";
      title?: PromptFingerprint;
      message?: PromptFingerprint;
      response: ConfirmResponse;
      repeat?: number;
    }
  | {
      kind: "select";
      title?: PromptFingerprint;
      options?: SelectArguments[1];
      response: SelectResponse;
      repeat?: number;
    }
  | {
      kind: "input";
      title?: PromptFingerprint;
      prompt?: PromptFingerprint;
      response: InputResponse;
      repeat?: number;
    }
  | {
      kind: "editor";
      title?: PromptFingerprint;
      prompt?: PromptFingerprint;
      response: EditorResponse;
      repeat?: number;
    }
  | {
      kind: "custom";
      prompt?: PromptFingerprint;
      response: Awaited<ReturnType<ExtensionContext["ui"]["custom"]>>;
      repeat?: number;
    };

type PendingInteraction = {
  reject: (reason: HarnessDisposedError) => void;
  resolved: boolean;
  removeAbortListener?: () => void;
};

type InteractiveSelection = PendingInteraction & {
  title: string;
  options: string[];
  resolve: (value: string | undefined) => void;
};

type InteractiveInput = PendingInteraction & {
  title: string;
  prompt: string | undefined;
  resolve: (value: string | undefined) => void;
};

type InteractiveConfirmation = PendingInteraction & {
  title: string;
  message: string;
  resolve: (value: boolean) => void;
};

type InteractiveCustom = PendingInteraction & {
  component: Component;
  resolve: (value: unknown) => void;
};

type MountedCustom = {
  component: Component;
  tui?: TuiMainScreen;
};

export class HarnessDisposedError extends Error {
  constructor() {
    super("Extension harness was disposed while waiting for an interaction");
    this.name = "HarnessDisposedError";
  }
}

/** A strict-script interaction's repeat count was not a positive integer. */
export class InvalidInteractionRepeatError extends Error {
  constructor(repeat: unknown) {
    super(
      `Strict interaction repeat must be a positive integer; received ${String(repeat)}`,
    );
    this.name = "InvalidInteractionRepeatError";
  }
}

type QueuedInteraction = ScriptedInteraction & { remaining: number };

type RegisteredHarness = {
  dispose(): Promise<void>;
  owner: string | undefined;
};

const liveHarnesses = new Set<RegisteredHarness>();

function currentTestOwner(): string | undefined {
  const state = expect.getState();
  return state.currentTestName === undefined
    ? undefined
    : `${state.testPath}:${state.currentTestName}`;
}

afterEach(async () => {
  const owner = currentTestOwner();
  const harnesses = [...liveHarnesses].filter(
    (harness) => harness.owner === owner,
  );
  for (const harness of harnesses) liveHarnesses.delete(harness);
  const results = await Promise.allSettled(
    harnesses.map((harness) => harness.dispose()),
  );
  const errors: unknown[] = [];
  for (const result of results) {
    if (result.status === "rejected") {
      const reason: unknown = result.reason;
      errors.push(reason);
    }
  }
  if (errors.length > 0)
    throw new AggregateError(errors, "Extension harness cleanup failed");
});

type HarnessError =
  | { event: "session_start"; error: unknown }
  | { event: "session_shutdown"; error: unknown }
  | { event: "before_agent_start"; error: unknown };

type HandledEvents = {
  session_start: SessionStartEvent;
  session_shutdown: SessionShutdownEvent;
  before_agent_start: BeforeAgentStartEvent;
  tool_call: ToolCallEvent;
  user_bash: UserBashEvent;
};

type HandlerStore = {
  [K in keyof HandledEvents]: Array<
    ExtensionHandler<
      HandledEvents[K],
      K extends "before_agent_start"
        ? BeforeAgentStartEventResult
        : K extends "tool_call"
          ? ToolCallEventResult
          : K extends "user_bash"
            ? UserBashEventResult
            : void
    >
  >;
};

type ToolRegistration = ToolDefinition & {
  sourceInfo?: ReturnType<typeof createSyntheticSourceInfo>;
};

const inheritedSubagentProfile = process.env.PI_SUBAGENT_PROFILE;
const inheritedSubagentPermissibleGlobs =
  process.env.PI_SUBAGENT_PERMISSIBLE_GLOBS;

export function createExtensionHarness(
  options: {
    contextCwd?: string;
    hasUI?: boolean;
    confirm?: boolean;
    editorResult?: string;
    inputResults?: Array<string | undefined>;
    selectResults?: Array<string | undefined>;
    customResults?: Array<unknown>;
    entries?: SessionEntryInput[];
    registeredTools?: string[];
    activeTools?: string[];
    /**
     * When true, UI prompts wait for the typed drivers on `harness.ui`.
     * The default fixture mode remains deterministic and queue-driven.
     */
    interactiveUi?: boolean;
    /**
     * Make stock input/select/confirm prompts pending and signal-aware, like
     * Pi's real UI. Legacy queues and strict scripts intentionally stay
     * immediate unless this is explicitly requested.
     */
    pendingStockUi?: boolean;
    /** Mount custom components in pi-tui's real regular-screen TUI. */
    tuiMode?: boolean;
    /** SDK keybinding manager injected into custom component factories. */
    keybindings?: KeybindingsManager;
    /**
     * Opt-in ordered UI script. Unlike legacy fixture queues, every prompt
     * must match and every cancellation must be stated explicitly.
     */
    interactionScript?: ScriptedInteraction[];
  } = {},
) {
  const contextCwd = options.contextCwd ?? process.cwd();
  const builtInToolNames = [
    "read",
    "bash",
    "edit",
    "write",
    "grep",
    "find",
    "ls",
  ];
  const registeredToolNames = new Set(
    options.registeredTools ?? builtInToolNames,
  );
  const activeToolNames = new Set(
    (options.activeTools ?? ["read", "bash", "edit", "write"]).filter((name) =>
      registeredToolNames.has(name),
    ),
  );
  const entries = normalizeEntries(options.entries ?? []);
  const errors: HarnessError[] = [];
  const handlers: HandlerStore = {
    session_start: [],
    session_shutdown: [],
    before_agent_start: [],
    tool_call: [],
    user_bash: [],
  };
  const commands = new Map<string, CommandRegistration>();
  const shortcuts = new Map<string, ShortcutRegistration>();
  const tools = new Map<string, ToolRegistration>();
  let started = false;
  let shutdownDispatched = false;
  let disposed = false;
  let disposalPromise: Promise<void> | undefined;
  let nextEntryId = entries.length + 1;

  function repeatCount(interaction: ScriptedInteraction): number {
    const repeat = interaction.repeat ?? 1;
    if (!Number.isInteger(repeat) || repeat <= 0)
      throw new InvalidInteractionRepeatError(repeat);
    return repeat;
  }

  const interactionScript: QueuedInteraction[] = (
    options.interactionScript ?? []
  ).map((interaction) => ({
    ...interaction,
    remaining: repeatCount(interaction),
  }));
  const consumedInteractions: string[] = [];
  const strictInteractions = options.interactionScript !== undefined;
  const inputResults = [...(options.inputResults ?? [])];
  const selectResults = [...(options.selectResults ?? [])];
  const customResults = [...(options.customResults ?? [])];
  const customComponents: Component[] = [];
  const mountedCustom: MountedCustom[] = [];
  const terminals: HarnessTerminal[] = [];
  const pendingSelections: InteractiveSelection[] = [];
  const pendingInputs: InteractiveInput[] = [];
  const pendingConfirmations: InteractiveConfirmation[] = [];
  const pendingCustom: InteractiveCustom[] = [];
  const selectionWaiters: Array<{
    resolve: (selection: InteractiveSelection) => void;
    reject: (reason: HarnessDisposedError) => void;
  }> = [];
  const customWaiters: Array<{
    resolve: (custom: InteractiveCustom) => void;
    reject: (reason: HarnessDisposedError) => void;
  }> = [];
  const inputWaiters: Array<{
    resolve: (input: InteractiveInput) => void;
    reject: (reason: HarnessDisposedError) => void;
  }> = [];
  const confirmationWaiters: Array<{
    resolve: (confirmation: InteractiveConfirmation) => void;
    reject: (reason: HarnessDisposedError) => void;
  }> = [];
  let inputDrivers = new WeakMap<Component, (data: string) => void>();
  const terminalInputListeners = new Set<TerminalInputHandler>();

  function interactionDescription(interaction: ScriptedInteraction): string {
    const title = "title" in interaction ? interaction.title : undefined;
    const message = "message" in interaction ? interaction.message : undefined;
    const prompt = "prompt" in interaction ? interaction.prompt : undefined;
    return `${interaction.kind}(${[title, message, prompt]
      .filter((value) => value !== undefined)
      .map(String)
      .join(", ")})`;
  }

  function matchesFingerprint(
    actual: string | undefined,
    expected: PromptFingerprint | undefined,
  ): boolean {
    if (expected === undefined) return true;
    if (actual === undefined) return false;
    if (typeof expected === "string") return actual.includes(expected);
    // `/g` and `/y` regexes retain state across calls, unlike a prompt
    // fingerprint. Reset it for every match, including repeated scripts.
    expected.lastIndex = 0;
    return expected.test(actual);
  }

  function consumeInteraction(
    kind: ScriptedInteraction["kind"],
    details: {
      title?: string;
      message?: string;
      options?: string[];
      prompt?: string;
    },
  ): QueuedInteraction {
    const expected = interactionScript.find(
      (interaction) => interaction.remaining > 0,
    );
    const actual = `${kind}(${JSON.stringify(details)})`;
    if (!expected) {
      throw new Error(
        `Strict interaction script exhausted by ${actual}. Consumed: ${consumedInteractions.join(" → ") || "none"}. Pending: none.`,
      );
    }
    // Validate again at use time so an invalid count cannot silently affect
    // consumption even if this internal queue is changed in the future.
    repeatCount(expected);
    const expectedTitle = "title" in expected ? expected.title : undefined;
    const expectedMessage =
      "message" in expected ? expected.message : undefined;
    const expectedPrompt = "prompt" in expected ? expected.prompt : undefined;
    const expectedOptions =
      "options" in expected ? expected.options : undefined;
    const matches =
      expected.kind === kind &&
      matchesFingerprint(details.title, expectedTitle) &&
      matchesFingerprint(details.message, expectedMessage) &&
      matchesFingerprint(details.prompt, expectedPrompt) &&
      (expectedOptions === undefined ||
        JSON.stringify(details.options) === JSON.stringify(expectedOptions));
    if (!matches) {
      throw new Error(
        `Strict interaction mismatch. Expected ${interactionDescription(expected)}, received ${actual}. Consumed: ${consumedInteractions.join(" → ") || "none"}. Pending: ${interactionScript
          .filter((interaction) => interaction.remaining > 0)
          .map(interactionDescription)
          .join(" → ")}.`,
      );
    }
    expected.remaining--;
    consumedInteractions.push(actual);
    return expected;
  }

  function publishSelection(selection: InteractiveSelection): void {
    pendingSelections.push(selection);
    const waiter = selectionWaiters.shift();
    waiter?.resolve(selection);
  }

  function publishInput(input: InteractiveInput): void {
    pendingInputs.push(input);
    inputWaiters.shift()?.resolve(input);
  }

  function publishConfirmation(confirmation: InteractiveConfirmation): void {
    pendingConfirmations.push(confirmation);
    confirmationWaiters.shift()?.resolve(confirmation);
  }

  function publishCustom(custom: InteractiveCustom): void {
    pendingCustom.push(custom);
    const waiter = customWaiters.shift();
    waiter?.resolve(custom);
  }

  function nextSelection(
    predicate: (selection: InteractiveSelection) => boolean,
  ): Promise<InteractiveSelection> {
    const existing = pendingSelections.find(
      (selection) => !selection.resolved && predicate(selection),
    );
    if (existing) return Promise.resolve(existing);
    if (disposed) return Promise.reject(new HarnessDisposedError());
    return new Promise((resolve, reject) =>
      selectionWaiters.push({ resolve, reject }),
    );
  }

  function nextCustom(): Promise<InteractiveCustom> {
    const existing = pendingCustom.find((custom) => !custom.resolved);
    if (existing) return Promise.resolve(existing);
    if (disposed) return Promise.reject(new HarnessDisposedError());
    return new Promise((resolve, reject) =>
      customWaiters.push({ resolve, reject }),
    );
  }
  function sendTerminalInput({
    data: initialData,
    component,
  }: {
    readonly data: string;
    readonly component?: Component;
  }): void {
    let data = initialData;
    for (const listener of terminalInputListeners) {
      const result = listener(data);
      if (result?.consume) return;
      if (result?.data !== undefined) data = result.data;
    }
    if (!component) return;
    const driver = inputDrivers.get(component);
    if (driver) driver(data);
    else component.handleInput?.(data);
  }

  function pressKey(component: Component, key: string): void {
    const keys: Record<string, string> = {
      Tab: "\t",
      Enter: "\n",
      Escape: "\x1b",
      ArrowUp: "\x1b[A",
      ArrowDown: "\x1b[B",
      ArrowLeft: "\x1b[D",
      ArrowRight: "\x1b[C",
      CtrlArrowUp: "\x1b[1;5A",
      CtrlArrowDown: "\x1b[1;5B",
      CtrlShiftR: "\x1b[114;6u",
      CtrlC: "\x03",
      CtrlN: "\x0e",
      CtrlO: "\x0f",
      CtrlD: "\x04",
      CtrlK: "\x0b",
      CtrlX: "\x18",
      CtrlU: "\x15",
      Backspace: "\x7f",
    };
    sendTerminalInput({ data: keys[key] ?? key, component });
  }

  function signalFrom({
    args,
  }: {
    readonly args: readonly unknown[];
  }): AbortSignal | undefined {
    for (const value of args) {
      if (
        typeof value === "object" &&
        value !== null &&
        "signal" in value &&
        value.signal instanceof AbortSignal
      )
        return value.signal;
    }
    return undefined;
  }

  function pendingStock<T, Interaction extends PendingInteraction>({
    signal,
    fallback,
    publish,
    create,
  }: {
    readonly signal: AbortSignal | undefined;
    readonly fallback: T;
    readonly publish: (interaction: Interaction) => void;
    readonly create: ({
      resolve,
      reject,
    }: {
      readonly resolve: (value: T) => void;
      readonly reject: (reason: HarnessDisposedError) => void;
    }) => Interaction;
  }): Promise<T> {
    return observePendingRejection(
      new Promise<T>((resolve, reject) => {
        let complete: (value: T) => void = () => undefined;
        const interaction = create({
          resolve: (value) => complete(value),
          reject,
        });
        complete = (value) => {
          if (interaction.resolved) return;
          interaction.resolved = true;
          interaction.removeAbortListener?.();
          resolve(value);
        };
        const abort = () => complete(fallback);
        if (signal?.aborted) abort();
        else if (signal) {
          signal.addEventListener("abort", abort, { once: true });
          interaction.removeAbortListener = () =>
            signal.removeEventListener("abort", abort);
        }
        if (!interaction.resolved) publish(interaction);
      }),
    );
  }
  // Prevent cleanup-time rejection of an abandoned real UI promise from being
  // reported as unhandled. This observer deliberately leaves the original
  // promise unchanged, so callers can still await its HarnessDisposedError.
  function observePendingRejection<T>(promise: Promise<T>): Promise<T> {
    void promise.catch(() => undefined);
    return promise;
  }

  // Custom UI tests only need deterministic plain text styling; Pi's runtime
  // supplies the real Theme and TUI instances.
  const testTheme = {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };
  const testTui = { requestRender: vi.fn() };
  const keybindings =
    options.keybindings ?? new KeybindingsManager(TUI_KEYBINDINGS);
  const ui = {
    confirm: vi.fn().mockImplementation((...args: ConfirmArguments) => {
      if (strictInteractions)
        return Promise.resolve(
          consumeInteraction("confirm", {
            title: args[0],
            message: args[1],
          }).response,
        );
      if (!options.pendingStockUi)
        return Promise.resolve(options.confirm ?? false);
      return pendingStock({
        signal: signalFrom({ args }),
        fallback: false,
        publish: publishConfirmation,
        create: ({ resolve, reject }) => ({
          title: args[0],
          message: args[1],
          resolve,
          reject,
          resolved: false,
        }),
      });
    }),
    editor: vi.fn().mockImplementation((...args: EditorArguments) =>
      Promise.resolve(
        strictInteractions
          ? consumeInteraction("editor", {
              title: args[0],
              prompt: args[1],
            }).response
          : options.editorResult,
      ),
    ),
    input: vi.fn().mockImplementation((...args: InputArguments) => {
      if (strictInteractions)
        return Promise.resolve(
          consumeInteraction("input", { title: args[0], prompt: args[1] })
            .response,
        );
      if (!options.pendingStockUi) return Promise.resolve(inputResults.shift());
      return pendingStock<string | undefined, InteractiveInput>({
        signal: signalFrom({ args }),
        fallback: undefined,
        publish: publishInput,
        create: ({ resolve, reject }) => ({
          title: args[0],
          prompt: args[1],
          resolve,
          reject,
          resolved: false,
        }),
      });
    }),
    select: vi.fn().mockImplementation((...args: SelectArguments) => {
      const [title, selectOptions] = args;
      if (strictInteractions)
        return Promise.resolve(
          consumeInteraction("select", {
            title,
            options: selectOptions,
          }).response,
        );
      if (options.pendingStockUi || options.interactiveUi) {
        return pendingStock<string | undefined, InteractiveSelection>({
          signal: signalFrom({ args }),
          fallback: undefined,
          publish: publishSelection,
          create: ({ resolve, reject }) => ({
            title,
            options: selectOptions,
            resolve,
            reject,
            resolved: false,
          }),
        });
      }
      if (selectResults.length > 0)
        return Promise.resolve(selectResults.shift());
      const permissionMessage =
        typeof args[2] === "string" ? args[2] : undefined;
      if (permissionMessage !== undefined) {
        ui.confirm(title.split("\n\n", 1)[0] ?? title, permissionMessage);
        return Promise.resolve(
          (options.confirm ?? false)
            ? askPermissionChoices[1]
            : askPermissionChoices[0],
        );
      }
      return Promise.resolve(undefined);
    }),
    custom: vi.fn().mockImplementation((factory: unknown) => {
      if (typeof factory !== "function") {
        if (strictInteractions)
          return Promise.resolve(consumeInteraction("custom", {}).response);
        return Promise.resolve(customResults.shift() ?? null);
      }
      let completed: unknown;
      let resolveInteractive: (value: unknown) => void = () => undefined;
      let rejectInteractive: (reason: HarnessDisposedError) => void = () =>
        undefined;
      let interactiveCustom: InteractiveCustom | undefined;
      const interactiveResult = options.interactiveUi
        ? observePendingRejection(
            new Promise<unknown>((resolve, reject) => {
              resolveInteractive = resolve;
              rejectInteractive = reject;
            }),
          )
        : undefined;
      const component = (
        factory as (
          tui: typeof testTui,
          theme: typeof testTheme,
          keybindings: KeybindingsManager,
          done: (value: unknown) => void,
        ) => Component
      )(testTui, testTheme, keybindings, (value: unknown) => {
        completed = value;
        if (options.interactiveUi) {
          if (interactiveCustom) interactiveCustom.resolved = true;
          resolveInteractive(value);
        }
      });
      customComponents.push(component);
      mountedCustom.push({ component });
      if (options.tuiMode) {
        const terminal = new HarnessTerminal();
        terminals.push(terminal);
        const tui = new TuiMainScreen(terminal);
        // Recreate the component with the real pi-tui instance so focus and
        // keyboard dispatch follow the same path as an interactive session.
        const mountedComponent = (
          factory as (
            runtimeTui: TuiMainScreen,
            theme: typeof testTheme,
            keybindings: KeybindingsManager,
            done: (value: unknown) => void,
          ) => Component
        )(tui, testTheme, keybindings, (value: unknown) => {
          completed = value;
          if (options.interactiveUi) {
            if (interactiveCustom) interactiveCustom.resolved = true;
            resolveInteractive(value);
          }
        });
        customComponents[customComponents.length - 1] = mountedComponent;
        mountedCustom.push({ component: mountedComponent, tui });
        tui.addChild(mountedComponent);
        tui.start();
        tui.setFocus(mountedComponent);
        inputDrivers.set(mountedComponent, (data) => terminal.feed(data));
        if (options.interactiveUi) {
          interactiveCustom = {
            component: mountedComponent,
            resolve: resolveInteractive,
            reject: (reason) => rejectInteractive(reason),
            resolved: false,
          };
          publishCustom(interactiveCustom);
          return interactiveResult;
        }
      }
      if (options.interactiveUi) {
        // Pi focuses an opened custom modal. Mirror that lifecycle before
        // driving its public keyboard input surface.
        if (isFocusable(component)) component.focused = true;
        interactiveCustom = {
          component,
          resolve: resolveInteractive,
          reject: (reason) => rejectInteractive(reason),
          resolved: false,
        };
        publishCustom(interactiveCustom);
        return interactiveResult;
      }
      const rendered =
        component.render?.(harnessViewport.columns).join("\n") ?? "";
      if (strictInteractions)
        return Promise.resolve(
          consumeInteraction("custom", { prompt: rendered }).response,
        );
      if (rendered.includes("permission request")) {
        const choice =
          selectResults.shift() ??
          ((options.confirm ?? false)
            ? askPermissionChoices[1]
            : askPermissionChoices[0]);
        for (const character of choice) pressKey(component, character);
        pressKey(component, "Enter");
        return Promise.resolve(completed ?? null);
      }
      return Promise.resolve(customResults.shift() ?? null);
    }),
    onTerminalInput: vi.fn((handler: TerminalInputHandler) => {
      terminalInputListeners.add(handler);
      return () => terminalInputListeners.delete(handler);
    }),
    notify: vi.fn(),
    setStatus: vi.fn(),
    setWorkingVisible: vi.fn(),
  } satisfies Pick<
    ExtensionContext["ui"],
    | "confirm"
    | "editor"
    | "input"
    | "select"
    | "custom"
    | "onTerminalInput"
    | "notify"
    | "setStatus"
    | "setWorkingVisible"
  >;

  const sessionManager = {
    getEntries: () => entries,
  } satisfies Pick<ExtensionContext["sessionManager"], "getEntries">;

  const context = {
    cwd: contextCwd,
    hasUI: options.hasUI ?? true,
    ui,
    sessionManager,
  };
  const extensionContext = context as unknown as ExtensionCommandContext;

  const setActiveToolsMock = vi.fn((toolNames: string[]) => {
    activeToolNames.clear();
    for (const name of toolNames) {
      if (registeredToolNames.has(name)) activeToolNames.add(name);
    }
  });

  const pi = {
    on<E extends keyof HandledEvents>(
      event: E,
      handler: HandlerStore[E][number],
    ) {
      handlers[event].push(handler);
    },
    registerCommand(name: string, registration: CommandRegistration) {
      commands.set(name, registration);
    },
    registerShortcut(shortcut, registration) {
      shortcuts.set(shortcut, registration);
    },
    registerTool: ((tool: Parameters<ExtensionAPI["registerTool"]>[0]) => {
      const sourceInfo = createSyntheticSourceInfo(
        `./extensions/${tool.name}.ts`,
        {
          source: "permissions-extension",
          scope: "project",
          origin: "top-level",
        },
      );
      tools.set(tool.name, { ...tool, sourceInfo });
      registeredToolNames.add(tool.name);
    }) as ExtensionAPI["registerTool"],
    appendEntry(customType: string, data: unknown) {
      entries.push(
        createCustomEntry({ customType, data, sequence: nextEntryId++ }),
      );
    },
    getActiveTools: () => [...activeToolNames],
    getAllTools: () =>
      [...registeredToolNames].map((name) => {
        const tool = tools.get(name);
        if (tool) {
          return {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
            sourceInfo: tool.sourceInfo,
          };
        }
        return {
          name,
          sourceInfo: createSyntheticSourceInfo(`./builtin/${name}.ts`, {
            source: "builtin",
            scope: "temporary",
            origin: "top-level",
          }),
        };
      }) as unknown as ReturnType<ExtensionAPI["getAllTools"]>,
    setActiveTools: setActiveToolsMock,
  } satisfies Pick<
    ExtensionAPI,
    | "on"
    | "registerCommand"
    | "registerShortcut"
    | "registerTool"
    | "appendEntry"
    | "getActiveTools"
    | "getAllTools"
    | "setActiveTools"
  >;

  const currentSubagentProfile = process.env.PI_SUBAGENT_PROFILE;
  const currentSubagentPermissibleGlobs =
    process.env.PI_SUBAGENT_PERMISSIBLE_GLOBS;
  const clearSubagentProfile =
    currentSubagentProfile === inheritedSubagentProfile;
  const clearSubagentPermissibleGlobs =
    currentSubagentPermissibleGlobs === inheritedSubagentPermissibleGlobs;
  if (clearSubagentProfile) delete process.env.PI_SUBAGENT_PROFILE;
  if (clearSubagentPermissibleGlobs)
    delete process.env.PI_SUBAGENT_PERMISSIBLE_GLOBS;
  permissionsExtension(pi as unknown as ExtensionAPI);
  if (currentSubagentProfile === undefined) {
    delete process.env.PI_SUBAGENT_PROFILE;
  } else {
    process.env.PI_SUBAGENT_PROFILE = currentSubagentProfile;
  }
  if (currentSubagentPermissibleGlobs === undefined) {
    delete process.env.PI_SUBAGENT_PERMISSIBLE_GLOBS;
  } else {
    process.env.PI_SUBAGENT_PERMISSIBLE_GLOBS = currentSubagentPermissibleGlobs;
  }

  function ensureStarted(operation: string): void {
    if (disposed) throw new HarnessDisposedError();
    if (!started) {
      throw new Error(`Harness must be started before ${operation}`);
    }
  }

  function captureError(error: HarnessError): void {
    errors.push(error);
  }

  async function dispatchSessionStart(event: SessionStartEvent): Promise<void> {
    for (const handler of handlers.session_start) {
      try {
        await handler(event, extensionContext);
      } catch (error) {
        captureError({ event: "session_start", error });
      }
    }
  }

  async function dispatchSessionShutdown(
    event: SessionShutdownEvent,
  ): Promise<void> {
    for (const handler of handlers.session_shutdown) {
      try {
        await handler(event, extensionContext);
      } catch (error) {
        captureError({ event: "session_shutdown", error });
      }
    }
  }

  async function dispatchBeforeAgentStart(
    event: BeforeAgentStartEvent,
  ): Promise<BeforeAgentStartEventResult | undefined> {
    let systemPrompt = event.systemPrompt;
    let result: BeforeAgentStartEventResult | undefined;

    for (const handler of handlers.before_agent_start) {
      try {
        const handlerResult = await handler(
          { ...event, systemPrompt },
          extensionContext,
        );
        if (handlerResult?.systemPrompt !== undefined) {
          systemPrompt = handlerResult.systemPrompt;
        }
        if (handlerResult) {
          result = { ...result, ...handlerResult, systemPrompt };
        }
      } catch (error) {
        captureError({ event: "before_agent_start", error });
      }
    }

    return result;
  }

  async function dispatchToolCall(
    event: ToolCallEvent,
  ): Promise<ToolCallEventResult | undefined> {
    let result: ToolCallEventResult | undefined;
    for (const handler of handlers.tool_call) {
      const handlerResult = await handler(event, extensionContext);
      if (handlerResult) {
        result = handlerResult;
        if (result.block) return result;
      }
    }
    return result;
  }

  async function dispatchUserBash(
    event: UserBashEvent,
  ): Promise<UserBashEventResult | undefined> {
    for (const handler of handlers.user_bash) {
      const handlerResult = await handler(event, extensionContext);
      if (handlerResult) return handlerResult;
    }
    return undefined;
  }

  async function callTool(event: Omit<ToolCallEvent, "type" | "toolCallId">) {
    ensureStarted("callTool");
    return await dispatchToolCall({
      ...event,
      type: "tool_call",
      toolCallId: "test-tool-call",
    });
  }

  async function executeRegisteredTool({
    name,
    params,
    options = {},
  }: {
    name: string;
    params: unknown;
    options?: { signal?: AbortSignal };
  }) {
    ensureStarted("executeRegisteredTool");
    const tool = tools.get(name);
    if (!tool) throw new Error(`Tool not registered: ${name}`);
    return await tool.execute(
      "test-tool-call",
      params,
      options.signal,
      undefined,
      extensionContext,
    );
  }

  /** Observe the permission modal created by an in-flight callTool. */
  async function waitForPermissionChoice(): Promise<{
    choose: (choice: AskPermissionChoice) => void;
    render: () => string[];
  }> {
    const modal = await nextCustom();
    const rendered =
      modal.component.render?.(harnessViewport.columns).join("\n") ?? "";
    if (!rendered.includes("permission request"))
      throw new Error(`Expected permission picker, received:\n${rendered}`);
    return {
      choose(choice) {
        if (!askPermissionChoices.some((option) => option === choice))
          throw new Error(`Unknown permission choice: ${choice}`);
        for (const character of choice) pressKey(modal.component, character);
        pressKey(modal.component, "Enter");
      },
      render: () => modal.component.render?.(harnessViewport.columns) ?? [],
    };
  }

  /** Observe a visible rule form and drive it with user-like key and text input. */
  /** Observe any custom modal and drive it through its public UI surface. */
  async function waitForCustomModal(): Promise<{
    render: (width?: number) => string[];
    press: (key: string) => void;
    type: (text: string) => void;
  }> {
    const custom = await nextCustom();
    return {
      render(width = 80) {
        return custom.component.render(width);
      },
      press(key) {
        pressKey(custom.component, key);
      },
      type(text) {
        for (const character of text) pressKey(custom.component, character);
      },
    };
  }

  /** Drive the shared General component through its real keyboard interface. */
  async function waitForProfileGeneralForm(): Promise<{
    render: (width?: number) => string[];
    press: (key: string) => void;
    type: (text: string) => void;
  }> {
    const modal = await waitForCustomModal();
    if (!modal.render().join("\n").includes("Name (required)"))
      throw new Error("Expected Profile General form");
    return modal;
  }

  async function waitForRuleForm(): Promise<{
    render: (width?: number) => string[];
    press: (key: string) => void;
    type: (text: string) => void;
  }> {
    return waitForCustomModal();
  }

  /**
   * Drive the public keyboard surface of the shared authoring overview using
   * its stable result IDs, rather than its rendered labels.
   */
  async function waitForProfileAuthoringOverview(): Promise<{
    render: (width?: number) => string[];
    choose: ({
      selection,
    }: {
      readonly selection: ProfileAuthoringOverviewSelection;
    }) => void;
    cancel: () => void;
  }> {
    const custom = await nextCustom();
    if (!(custom.component instanceof ProfileAuthoringOverview)) {
      const rendered =
        custom.component.render?.(harnessViewport.columns).join("\n") ?? "";
      throw new Error(
        `Expected profile authoring overview, received:\n${rendered}`,
      );
    }
    const selectable = custom.component.options.filter(
      (item) => item.kind !== "separator",
    );
    return {
      render(width = 80) {
        return custom.component.render(width);
      },
      choose({ selection }) {
        const target = selectable.findIndex(
          (item) => item.kind === selection.kind && item.id === selection.id,
        );
        if (target < 0)
          throw new Error(
            `Profile authoring overview does not offer ${selection.kind}:${selection.id}`,
          );
        for (let index = 0; index < target; index++)
          pressKey(custom.component, "ArrowDown");
        pressKey(custom.component, "Enter");
      },
      cancel() {
        pressKey(custom.component, "Escape");
      },
    };
  }

  /** Drive a pending stock input prompt. */
  async function waitForInput(): Promise<{
    title: string;
    prompt: string | undefined;
    submit: ({ value }: { readonly value: string }) => void;
    cancel: () => void;
  }> {
    const input = pendingInputs.find((item) => !item.resolved);
    const next =
      input ??
      (disposed
        ? await Promise.reject(new HarnessDisposedError())
        : await new Promise<InteractiveInput>((resolve, reject) =>
            inputWaiters.push({ resolve, reject }),
          ));
    if (!next) throw new HarnessDisposedError();
    const settle = (value: string | undefined) => {
      if (next.resolved) return;
      next.resolved = true;
      next.removeAbortListener?.();
      next.resolve(value);
    };
    return {
      title: next.title,
      prompt: next.prompt,
      submit: ({ value }) => settle(value),
      cancel: () => settle(undefined),
    };
  }

  /** Drive a pending stock confirmation prompt. */
  async function waitForConfirmation(): Promise<{
    title: string;
    message: string;
    choose: ({ value }: { readonly value: boolean }) => void;
  }> {
    const confirmation = pendingConfirmations.find((item) => !item.resolved);
    const next =
      confirmation ??
      (disposed
        ? await Promise.reject(new HarnessDisposedError())
        : await new Promise<InteractiveConfirmation>((resolve, reject) =>
            confirmationWaiters.push({ resolve, reject }),
          ));
    if (!next) throw new HarnessDisposedError();
    return {
      title: next.title,
      message: next.message,
      choose: ({ value }) => {
        if (next.resolved) return;
        next.resolved = true;
        next.removeAbortListener?.();
        next.resolve(value);
      },
    };
  }

  /** Observe a select prompt, including its title and available choices. */
  async function waitForSelection(): Promise<{
    title: string;
    options: string[];
    choose: (choice: string) => void;
    cancel: () => void;
  }> {
    const selection = await nextSelection(() => true);
    return {
      title: selection.title,
      options: selection.options,
      choose(choice) {
        if (!selection.options.includes(choice))
          throw new Error(`Unknown selection: ${choice}`);
        if (selection.resolved) return;
        selection.resolved = true;
        selection.removeAbortListener?.();
        selection.resolve(choice);
      },
      cancel() {
        if (selection.resolved) return;
        selection.resolved = true;
        selection.removeAbortListener?.();
        selection.resolve(undefined);
      },
    };
  }

  function isDisposableComponent(
    component: Component,
  ): component is Component & { dispose(): void } {
    return "dispose" in component && typeof component.dispose === "function";
  }

  function disposeResources(): Promise<void> {
    if (disposed) return Promise.resolve();
    disposed = true;
    const disposalError = new HarnessDisposedError();
    for (const interaction of [
      ...pendingSelections,
      ...pendingInputs,
      ...pendingConfirmations,
    ]) {
      if (!interaction.resolved) {
        interaction.resolved = true;
        interaction.removeAbortListener?.();
        interaction.reject(disposalError);
      }
    }
    for (const custom of pendingCustom) {
      if (!custom.resolved) {
        custom.resolved = true;
        custom.reject(disposalError);
      }
    }
    for (const waiter of selectionWaiters.splice(0))
      waiter.reject(disposalError);
    for (const waiter of inputWaiters.splice(0)) waiter.reject(disposalError);
    for (const waiter of confirmationWaiters.splice(0))
      waiter.reject(disposalError);
    for (const waiter of customWaiters.splice(0)) waiter.reject(disposalError);

    const errors: unknown[] = [];
    for (const mounted of mountedCustom.splice(0)) {
      // A failed regular-screen shutdown must not leak its component, nor
      // prevent cleanup of subsequent mounted resources.
      if (mounted.tui) {
        try {
          mounted.tui.stop();
        } catch (error) {
          errors.push(error);
        }
      }
      if (isDisposableComponent(mounted.component)) {
        try {
          mounted.component.dispose();
        } catch (error) {
          errors.push(error);
        }
      }
    }
    pendingSelections.splice(0);
    pendingInputs.splice(0);
    pendingConfirmations.splice(0);
    pendingCustom.splice(0);
    customComponents.splice(0);
    inputDrivers = new WeakMap();
    terminalInputListeners.clear();
    commands.clear();
    shortcuts.clear();
    tools.clear();
    handlers.session_start.splice(0);
    handlers.session_shutdown.splice(0);
    handlers.before_agent_start.splice(0);
    handlers.tool_call.splice(0);
    handlers.user_bash.splice(0);
    liveHarnesses.delete(registeredHarness);
    if (errors.length > 0)
      return Promise.reject(
        new AggregateError(errors, "Extension harness disposal failed"),
      );
    return Promise.resolve();
  }

  function dispose(): Promise<void> {
    // Install this synchronously, before any shutdown handler can yield, so
    // all callers await precisely one shutdown-and-resource-cleanup operation.
    if (disposalPromise) return disposalPromise;
    disposalPromise = (async () => {
      try {
        if (started && !shutdownDispatched) {
          shutdownDispatched = true;
          await dispatchSessionShutdown({
            type: "session_shutdown",
            reason: "quit",
          });
        }
      } finally {
        started = false;
        await disposeResources();
      }
    })();
    return disposalPromise;
  }

  const harness = {
    commands,
    shortcuts,
    context,
    entries,
    errors,
    ui: {
      ...ui,
      waitForPermissionChoice,
      sendTerminalInput,
      waitForConfirmation,
      waitForCustomModal,
      waitForInput,
      waitForProfileAuthoringOverview,
      waitForProfileGeneralForm,
      waitForRuleForm,
      waitForSelection,
    },
    customComponents,
    setActiveToolsMock,
    getActiveTools: () => [...activeToolNames],
    getAllTools: () => pi.getAllTools(),
    onUserBash(handler: HandlerStore["user_bash"][number]) {
      handlers.user_bash.push(handler);
    },
    onSessionShutdown(handler: HandlerStore["session_shutdown"][number]) {
      handlers.session_shutdown.push(handler);
    },
    get tuiStopCount() {
      return terminals.reduce(
        (count, terminal) => count + terminal.stopCount,
        0,
      );
    },
    /** Simulates another extension or the user deactivating a tool mid-session. */
    deactivateTool(nameOrTool: string | { name: string }) {
      const name =
        typeof nameOrTool === "string" ? nameOrTool : nameOrTool.name;
      activeToolNames.delete(name);
    },
    async start({
      reason = "startup",
    }: { reason?: SessionStartEvent["reason"] } = {}) {
      started = true;
      await dispatchSessionStart({ type: "session_start", reason });
    },
    async callTool(event: Omit<ToolCallEvent, "type" | "toolCallId">) {
      return await callTool(event);
    },
    async executeTool(
      nameOrEvent:
        | string
        | {
            name: string;
            params: unknown;
            options?: { signal?: AbortSignal };
          },
      params?: unknown,
      options: { signal?: AbortSignal } = {},
    ) {
      if (typeof nameOrEvent === "string") {
        return await executeRegisteredTool({
          name: nameOrEvent,
          params,
          options,
        });
      }
      return await executeRegisteredTool(nameOrEvent);
    },
    async callUserBash(
      event: Omit<UserBashEvent, "type">,
    ): Promise<UserBashEventResult | undefined> {
      ensureStarted("callUserBash");
      return await dispatchUserBash({ ...event, type: "user_bash" });
    },
    async callToolDecisivelyWithoutPrompt(
      event: Omit<ToolCallEvent, "type" | "toolCallId">,
    ) {
      const confirmCalls = ui.confirm.mock.calls.length;
      const selectCalls = ui.select.mock.calls.length;
      const customCalls = customComponents.length;
      const result = await callTool(event);
      if (
        ui.confirm.mock.calls.length !== confirmCalls ||
        ui.select.mock.calls.length !== selectCalls ||
        customComponents.length !== customCalls
      )
        throw new Error(
          `Expected ${event.toolName} to resolve without a permission prompt`,
        );
      return result;
    },
    async callToolWithoutPrompt(
      event: Omit<ToolCallEvent, "type" | "toolCallId">,
    ) {
      const confirmCalls = ui.confirm.mock.calls.length;
      const selectCalls = ui.select.mock.calls.length;
      const customCalls = customComponents.length;
      const result = await callTool(event);
      if (
        ui.confirm.mock.calls.length !== confirmCalls ||
        ui.select.mock.calls.length !== selectCalls ||
        customComponents.length !== customCalls
      )
        throw new Error(
          `Expected ${event.toolName} to be allowed without a permission prompt`,
        );
      if (result?.block)
        throw new Error(
          `Expected ${event.toolName} to be allowed, but it was blocked: ${result.reason}`,
        );
      return result;
    },
    async beforeAgent({
      systemPrompt = "Base system prompt",
    }: {
      systemPrompt?: string;
    } = {}) {
      ensureStarted("beforeAgent");
      return await dispatchBeforeAgentStart({
        type: "before_agent_start",
        prompt: "test prompt",
        systemPrompt,
        systemPromptOptions: { cwd: contextCwd },
      });
    },
    shutdown: dispose,
    dispose,
    assertInteractionsDrained() {
      const pending = interactionScript.filter(
        (interaction) => interaction.remaining > 0,
      );
      if (pending.length > 0)
        throw new Error(
          `Strict interaction script was not drained. Consumed: ${consumedInteractions.join(" → ") || "none"}. Pending: ${pending.map(interactionDescription).join(" → ")}.`,
        );
    },
    async runCommand(
      nameOrEvent: string | { name: string; args?: string },
      args = "",
    ) {
      ensureStarted("runCommand");
      const name =
        typeof nameOrEvent === "string" ? nameOrEvent : nameOrEvent.name;
      const commandArgs =
        typeof nameOrEvent === "string" ? args : (nameOrEvent.args ?? "");
      const command = commands.get(name);
      if (!command) throw new Error(`Command not registered: ${name}`);
      await command.handler(commandArgs, extensionContext);
    },
    replaceToolSource(name: string, source: string) {
      const tool = tools.get(name);
      if (!tool) throw new Error(`Tool not registered: ${name}`);
      tool.sourceInfo = createSyntheticSourceInfo(`./extensions/${name}.ts`, {
        source,
        scope: "project",
        origin: "top-level",
      });
    },
    command({ name }: { name: string }) {
      const command = commands.get(name);
      if (!command) throw new Error(`Command not registered: ${name}`);
      return command;
    },
  };
  const registeredHarness: RegisteredHarness = {
    dispose: () => harness.dispose(),
    owner: currentTestOwner(),
  };
  liveHarnesses.add(registeredHarness);
  return harness;
}

function normalizeEntries(entries: SessionEntryInput[]): SdkSessionEntry[] {
  return entries.map((entry, index) =>
    entry.type === "custom"
      ? createCustomEntry({
          customType: entry.customType,
          data: entry.data,
          sequence: index + 1,
          entry,
        })
      : entry,
  );
}

function createCustomEntry({
  customType,
  data,
  sequence,
  entry = {},
}: {
  customType: string;
  data: unknown;
  sequence: number;
  entry?: Partial<CustomEntry>;
}): SdkSessionEntry {
  return {
    type: "custom",
    id: entry.id ?? `custom-entry-${sequence}`,
    parentId: entry.parentId ?? null,
    timestamp: entry.timestamp ?? new Date().toISOString(),
    customType,
    data,
  };
}

export function getLiveExtensionHarnessCountForTesting(): number {
  const owner = currentTestOwner();
  return [...liveHarnesses].filter((harness) => harness.owner === owner).length;
}

export function lastCallArgument({
  mock,
  index,
}: {
  mock: Mock;
  index: number;
}): unknown {
  return mock.mock.calls.at(-1)?.[index];
}
