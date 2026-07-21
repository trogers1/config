import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { vi } from 'vitest';

type Handler = (...args: unknown[]) => unknown;
type RegisteredCommand = { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> };

export function createPiUsageHarness({
	cwd,
	model,
	selectedModel,
	sessionFile,
	entries = [],
}: {
	cwd: string;
	model?: unknown;
	selectedModel?: unknown;
	sessionFile?: string;
	entries?: unknown[];
}) {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, RegisteredCommand>();
	const notifications: Array<{ message: string; type: string | undefined }> = [];
	const statuses: Array<{ key: string; text: string | undefined }> = [];
	const modelRegistry = {
		refresh: vi.fn(),
		find: vi.fn(() => model),
	};
	const ui = {
		notify: vi.fn((message: string, type?: string) => notifications.push({ message, type })),
		setStatus: vi.fn((key: string, text: string | undefined) => statuses.push({ key, text })),
		theme: { fg: (_color: string, text: string) => text },
	};
	const context = {
		cwd,
		model: selectedModel,
		modelRegistry,
		sessionManager: {
			getSessionFile: vi.fn(() => sessionFile),
			getEntries: vi.fn(() => entries),
		},
		ui,
	};
	const api = {
		on: vi.fn((event: string, handler: Handler) => {
			const registered = handlers.get(event) ?? [];
			registered.push(handler);
			handlers.set(event, registered);
		}),
		registerCommand: vi.fn((name: string, command: RegisteredCommand) =>
			commands.set(name, command)
		),
	} as unknown as ExtensionAPI;

	return {
		api,
		context,
		modelRegistry,
		notifications,
		statuses,
		async emit(event: string, payload: unknown): Promise<void> {
			for (const handler of handlers.get(event) ?? []) {
				await handler(payload, context as unknown as ExtensionContext);
			}
		},
		async command(name: string, args: string): Promise<void> {
			const command = commands.get(name);
			if (!command) throw new Error(`No command registered: ${name}`);
			await command.handler(args, context as unknown as ExtensionCommandContext);
		},
	};
}
