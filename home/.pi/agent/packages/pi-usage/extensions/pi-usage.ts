import crypto from 'node:crypto';
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { closeDb, getDbPath, recordUsage } from './db';
import { parseUsageArgs, usageHelp } from './args';
import { importSessions, usageRecordFromMessage, type AccountingOptions } from './importer';
import { exportCsv, renderReport } from './reporting';
import { renderLimitsStatus } from './limits';
import { readUsageConfig } from './config';
import {
	assertPiShape,
	assistantUsageMessageSchema,
	liveMessageContextSchema,
	notifyCompatibilityError,
	sessionStartContextSchema,
	shutdownContextSchema,
	usageCommandContextSchema,
} from './pi-context';

export default function piUsageExtension(pi: ExtensionAPI) {
	let liveInsertCount = 0;
	const processInstanceId = crypto.randomUUID();

	pi.on('session_start', async (_event, ctx: ExtensionContext) => {
		try {
			const sessionContext = assertPiShape({
				value: ctx,
				schema: sessionStartContextSchema,
				boundary: 'session_start context',
			});
			await sessionContext.modelRegistry.refresh();
			updateLimitsStatus(sessionContext);
		} catch (error) {
			notifyCompatibilityError({ value: ctx, error });
			if (ctx.hasUI === false) {
				const errorMessage = error instanceof Error ? error.message : String(error);
				process.stderr.write(`pi-usage: ${errorMessage}\n`);
			}
			throw error;
		}
	});

	pi.on('message_end', async (event: unknown, ctx: ExtensionContext) => {
		const message =
			event && typeof event === 'object' ? (event as { message?: unknown }).message : undefined;
		if (
			!message ||
			typeof message !== 'object' ||
			(message as { role?: unknown }).role !== 'assistant'
		)
			return;

		try {
			const usageMessage = assertPiShape({
				value: message,
				schema: assistantUsageMessageSchema,
				boundary: 'assistant message',
			});
			const liveContext = assertPiShape({
				value: ctx,
				schema: liveMessageContextSchema,
				boundary: 'message_end context',
			});
			const sessionFile = liveContext.sessionManager.getSessionFile();
			const sessionId = readSessionId(ctx);
			const entryId = findEntryIdForMessage(liveContext, usageMessage);
			const usageRecord = usageRecordFromMessage({
				message: usageMessage,
				accounting: accountingFor(liveContext),
				options: {
					source: 'live',
					sessionFile,
					sessionEntryId: entryId,
					cwd: liveContext.cwd,
					sessionId,
					processInstanceId,
				},
			});
			if (!usageRecord) return;
			const result = recordUsage({ record: usageRecord });
			if (result === 'inserted') liveInsertCount++;
			updateLimitsStatus(liveContext);
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`pi-usage failed to record usage: ${errorMessage}`, 'error');
			if (ctx.hasUI === false) {
				process.stderr.write(`pi-usage: failed to record usage: ${errorMessage}\n`);
			}
		}
	});

	pi.on('session_shutdown', async (_event, ctx: ExtensionContext) => {
		const shutdownContext = assertPiShape({
			value: ctx,
			schema: shutdownContextSchema,
			boundary: 'session_shutdown context',
		});
		shutdownContext.ui.setStatus('usage-limits', undefined);
		closeDb();
	});

	pi.registerCommand('usage', {
		description: 'Show token usage and cost reports, import history, or export CSV',
		getArgumentCompletions: (prefix: string) => {
			const values = [
				'today',
				'week',
				'month',
				'7d',
				'30d',
				'1 month',
				'since ',
				'provider ',
				'model ',
				'import',
				'export ',
			];
			return values
				.filter((value) => value.startsWith(prefix))
				.map((value) => ({ value, label: value.trim() }));
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			let command;
			try {
				command = parseUsageArgs({ raw: args });
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : usageHelp, 'error');
				return;
			}

			try {
				const commandContext = assertPiShape({
					value: ctx,
					schema: usageCommandContextSchema,
					boundary: '/usage command context',
				});
				if (command.kind === 'import') {
					await commandContext.modelRegistry.refresh();
					let latestProgress = 'Finding session files... Do not close this window.';
					const notifyProgress = () => commandContext.ui.notify(latestProgress, 'info');
					notifyProgress();
					const reminder = setInterval(notifyProgress, 5000);

					try {
						let lastProgressNotifyMs = 0;
						let lastNotifiedFilesScanned = -1;
						const summary = await importSessions({
							accounting: accountingFor(commandContext),
							onProgress: ({ progress }) => {
								const lines = [
									'Importing usage history... Do not close this window.',
									`Files scanned: ${progress.filesScanned}/${progress.totalFiles}`,
									`Assistant usage events found: ${progress.eventsFound}`,
									`Inserted: ${progress.inserted}`,
									`Updated: ${progress.updated}`,
									`Unchanged: ${progress.unchanged}`,
									`Errors: ${progress.errors}`,
								];
								if (progress.currentFile) {
									lines.push(`Current file: ${basename(progress.currentFile)}`);
								}
								latestProgress = lines.join('\n');

								const now = Date.now();
								const shouldNotify =
									lastProgressNotifyMs === 0 ||
									progress.filesScanned !== lastNotifiedFilesScanned ||
									now - lastProgressNotifyMs >= 5000;
								if (shouldNotify) {
									lastProgressNotifyMs = now;
									lastNotifiedFilesScanned = progress.filesScanned;
									notifyProgress();
								}
							},
						});
						commandContext.ui.notify(
							[
								'Usage import complete',
								`Files scanned: ${summary.filesScanned}`,
								`Assistant usage events found: ${summary.eventsFound}`,
								`Inserted: ${summary.inserted}`,
								`Updated: ${summary.updated}`,
								`Unchanged: ${summary.unchanged}`,
								`Errors: ${summary.errors}`,
								`DB: ${getDbPath()}`,
							].join('\n'),
							summary.errors > 0 ? 'warning' : 'info'
						);
						updateLimitsStatus(ctx);
					} finally {
						clearInterval(reminder);
					}
					return;
				}

				if (command.kind === 'export') {
					const outputPath = exportCsv(command, command.path, commandContext.cwd ?? process.cwd());
					commandContext.ui.notify(`Usage CSV exported: ${outputPath}`, 'info');
					return;
				}

				const report = renderReport(command, {
					limitResetColor: themeFgStart(commandContext.ui?.theme, 'dim'),
				});
				const footer =
					liveInsertCount > 0 ? `\n\nLive events recorded this runtime: ${liveInsertCount}` : '';
				commandContext.ui.notify(`${report}${footer}\n\nDB: ${getDbPath()}`, 'info');
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Usage command failed: ${message}`, 'error');
			}
		},
	});
}

function accountingFor(ctx: ExtensionContext): AccountingOptions {
	return {
		config: readUsageConfig(),
		modelLookup: ({ provider, model }) => ctx.modelRegistry.find(provider, model),
	};
}

function findEntryIdForMessage(ctx: ExtensionContext, message: any): string | undefined {
	const entries = ctx.sessionManager.getEntries?.() ?? [];
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i] as any;
		if (entry?.type !== 'message') continue;
		if (entry.message?.role !== 'assistant') continue;
		if (entry.message === message) return string(entry.id);
		if (messagesMatch(entry.message, message)) return string(entry.id);
	}
	return undefined;
}

function messagesMatch(a: any, b: any): boolean {
	if (!a || !b) return false;
	return (
		a.role === b.role &&
		a.provider === b.provider &&
		a.model === b.model &&
		number(a.timestamp) === number(b.timestamp) &&
		usageSignature(a.usage) === usageSignature(b.usage)
	);
}

function usageSignature(usage: any): string {
	const cost = usage?.cost ?? {};
	return [
		number(usage?.input),
		number(usage?.output),
		number(usage?.cacheRead),
		number(usage?.cacheWrite),
		number(usage?.totalTokens),
		number(cost.total),
	].join(':');
}

function updateLimitsStatus(ctx: ExtensionContext): void {
	try {
		ctx.ui.setStatus(
			'usage-limits',
			renderLimitsStatus(Date.now(), themeFgStart(ctx.ui?.theme, 'dim'))
		);
	} catch {
		ctx.ui.setStatus('usage-limits', undefined);
	}
}

function themeFgStart(theme: any, color: string): string {
	const marker = '__pi_usage_marker__';
	if (!theme?.fg) return '\x1b[39m';
	try {
		const text = String(theme.fg(color, marker));
		const index = text.indexOf(marker);
		return index >= 0 ? text.slice(0, index) : '\x1b[39m';
	} catch {
		return '\x1b[39m';
	}
}

function number(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function string(value: unknown): string | undefined {
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function basename(file: string): string {
	return file.split(/[\\/]/).pop() || file;
}

function readSessionId(ctx: ExtensionContext): string | undefined {
	const sessionManager = (ctx as any).sessionManager;
	if (sessionManager && typeof sessionManager.getSessionId === 'function') {
		try {
			return sessionManager.getSessionId();
		} catch {
			return undefined;
		}
	}
	return undefined;
}
