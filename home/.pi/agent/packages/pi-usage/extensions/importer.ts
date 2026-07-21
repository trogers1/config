import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { buildUsageRecord, type ModelLookup } from './accounting';
import type { UsageConfig } from './config';
import { getAgentDir, getDbPath, recordUsage, type UsageEvent, type UsageRecord } from './db';

export type ImportErrorDetail = {
	file: string;
	line: number;
	message: string;
};

export type ImportSummary = {
	filesScanned: number;
	eventsFound: number;
	inserted: number;
	updated: number;
	unchanged: number;
	errors: number;
	errorDetails: ImportErrorDetail[];
	errorLogPath?: string;
};

export type ImportProgress = ImportSummary & {
	totalFiles: number;
	currentFile?: string;
	currentFileLines?: number;
};

export type AccountingOptions = {
	modelLookup: ModelLookup;
	config: UsageConfig;
};

export async function importSessions({
	accounting,
	sessionRoot = path.join(getAgentDir(), 'sessions'),
	onProgress,
}: {
	accounting: AccountingOptions;
	sessionRoot?: string;
	onProgress?: (args: { progress: ImportProgress }) => void;
}): Promise<ImportSummary> {
	const summary: ImportSummary = {
		filesScanned: 0,
		eventsFound: 0,
		inserted: 0,
		updated: 0,
		unchanged: 0,
		errors: 0,
		errorDetails: [],
	};

	if (!fs.existsSync(sessionRoot)) return summary;

	const files = Array.from(walkJsonl({ dir: sessionRoot }));
	const emitProgress = ({
		currentFile,
		currentFileLines,
	}: { currentFile?: string; currentFileLines?: number } = {}) => {
		onProgress?.({
			progress: {
				...summary,
				totalFiles: files.length,
				currentFile,
				currentFileLines,
			},
		});
	};
	emitProgress({});

	for (const file of files) {
		emitProgress({ currentFile: file, currentFileLines: 0 });
		await importFile({
			file,
			accounting,
			summary,
			onProgress: ({ currentFileLines }) => emitProgress({ currentFile: file, currentFileLines }),
		});
		summary.filesScanned++;
		emitProgress({ currentFile: file });
	}

	return summary;
}

async function importFile({
	file,
	accounting,
	summary,
	onProgress,
}: {
	file: string;
	accounting: AccountingOptions;
	summary: ImportSummary;
	onProgress?: (args: { currentFileLines: number }) => void;
}): Promise<void> {
	const stream = fs.createReadStream(file, { encoding: 'utf8' });
	const lines = readline.createInterface({
		input: stream,
		crlfDelay: Infinity,
	});
	let headerCwd: string | undefined;
	let activeModel: UsageModel | undefined;
	let lineCount = 0;

	for await (const line of lines) {
		lineCount++;
		if (lineCount % 500 === 0) onProgress?.({ currentFileLines: lineCount });
		if (!line.trim()) continue;
		let entry: any;
		try {
			entry = JSON.parse(line);
		} catch (error) {
			recordImportError({
				summary,
				file,
				line: lineCount,
				message: `Invalid JSON: ${errorMessage(error)}`,
			});
			onProgress?.({ currentFileLines: lineCount });
			continue;
		}

		if (entry?.type === 'session' && typeof entry.cwd === 'string') {
			headerCwd = entry.cwd;
			continue;
		}

		activeModel = modelForEntry({ entry, previous: activeModel });
		const record = usageRecordFromEntry({
			entry,
			sessionFile: file,
			accounting,
			cwd: headerCwd,
			model: activeModel,
		});
		if (!record) continue;
		summary.eventsFound++;
		try {
			const result = recordUsage({ record });
			summary[result]++;
			onProgress?.({ currentFileLines: lineCount });
		} catch (error) {
			recordImportError({
				summary,
				file,
				line: lineCount,
				message: `Could not store usage event: ${errorMessage(error)}`,
			});
			onProgress?.({ currentFileLines: lineCount });
		}
	}
	onProgress?.({ currentFileLines: lineCount });
}

function recordImportError({
	summary,
	file,
	line,
	message,
}: {
	summary: ImportSummary;
	file: string;
	line: number;
	message: string;
}): void {
	summary.errors++;
	const detail = { file, line, message };
	const errorLogPath = appendImportError({
		detail,
		errorLogPath: summary.errorLogPath ?? getImportErrorLogPath({ timestamp: new Date() }),
	});
	if (errorLogPath) summary.errorLogPath = errorLogPath;
	if (summary.errorDetails.length >= 20) return;
	summary.errorDetails.push(detail);
}

export function getImportErrorLogPath({ timestamp }: { timestamp: Date }): string {
	const suffix = timestamp.toISOString().replace(/[:.]/g, '-');
	return path.join(path.dirname(getDbPath()), `import-errors-${suffix}.jsonl`);
}

function appendImportError({
	detail,
	errorLogPath,
}: {
	detail: ImportErrorDetail;
	errorLogPath: string;
}): string | undefined {
	try {
		fs.mkdirSync(path.dirname(errorLogPath), { recursive: true });
		fs.appendFileSync(
			errorLogPath,
			JSON.stringify({ timestamp: new Date().toISOString(), ...detail }) + '\n',
			'utf8'
		);
		return errorLogPath;
	} catch {
		return undefined;
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export type UsageModel = { provider: string; model: string };

export function usageRecordFromEntry({
	entry,
	sessionFile,
	accounting,
	cwd,
	model,
	source = 'import',
}: {
	entry: any;
	sessionFile?: string;
	accounting: AccountingOptions;
	cwd?: string;
	model?: UsageModel;
	source?: 'live' | 'import';
}): UsageRecord | undefined {
	const message = messageWithUsage({ entry, model });
	if (!message) return undefined;
	return usageRecordFromMessage({
		message,
		accounting,
		options: {
			source,
			sessionFile,
			sessionEntryId: typeof entry?.id === 'string' ? entry.id : undefined,
			entryTimestamp:
				typeof entry?.timestamp === 'string' ? Date.parse(entry.timestamp) : undefined,
			cwd,
		},
	});
}

function messageWithUsage({ entry, model }: { entry: any; model?: UsageModel }): any | undefined {
	if (entry?.type === 'message') {
		const message = entry.message;
		return message?.role === 'assistant' && message.usage ? message : undefined;
	}
	if (entry?.type !== 'compaction' && entry?.type !== 'branch_summary') return undefined;
	if (!entry.usage) return undefined;
	return {
		role: 'assistant',
		provider: model?.provider ?? 'unknown',
		model: model?.model ?? 'unknown',
		timestamp: typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : undefined,
		usage: entry.usage,
	};
}

function modelForEntry({
	entry,
	previous,
}: {
	entry: any;
	previous?: UsageModel;
}): UsageModel | undefined {
	if (
		entry?.type === 'model_change' &&
		typeof entry.provider === 'string' &&
		typeof entry.modelId === 'string'
	) {
		return { provider: entry.provider, model: entry.modelId };
	}
	const message = entry?.type === 'message' ? entry.message : undefined;
	if (
		message?.role === 'assistant' &&
		typeof message.provider === 'string' &&
		typeof message.model === 'string'
	) {
		return { provider: message.provider, model: message.model };
	}
	return previous;
}

export function usageRecordFromMessage({
	message,
	accounting,
	options,
}: {
	message: any;
	accounting: AccountingOptions;
	options: {
		source: 'live' | 'import';
		sessionFile?: string;
		sessionEntryId?: string;
		entryTimestamp?: number;
		cwd?: string;
		sessionId?: string;
		processInstanceId?: string;
	};
}): UsageRecord | undefined {
	const usage = message?.usage;
	if (!usage) return undefined;
	const input = number({ value: usage.input });
	const output = number({ value: usage.output });
	const cacheRead = number({ value: usage.cacheRead });
	const cacheWrite = number({ value: usage.cacheWrite });
	const event: UsageEvent = {
		source: options.source,
		timestampMs: number({ value: message.timestamp }) || options.entryTimestamp || Date.now(),
		provider: string({ value: message.provider }) || 'unknown',
		model: string({ value: message.model }) || 'unknown',
		api: string({ value: message.api }) || null,
		inputTokens: input,
		outputTokens: output,
		cacheReadTokens: cacheRead,
		cacheWriteTokens: cacheWrite,
		totalTokens: number({ value: usage.totalTokens }) || input + output + cacheRead + cacheWrite,
		cwd: options.cwd,
		sessionFile: options.sessionFile,
		sessionEntryId: options.sessionEntryId,
		sessionId: options.sessionId,
		processInstanceId: options.processInstanceId,
	};
	const cost = usage.cost ?? {};
	const storedCost = {
		input: number({ value: cost.input }),
		output: number({ value: cost.output }),
		cacheRead: number({ value: cost.cacheRead }),
		cacheWrite: number({ value: cost.cacheWrite }),
		total: number({ value: cost.total }),
	};
	if (storedCost.total === 0) {
		storedCost.total =
			storedCost.input + storedCost.output + storedCost.cacheRead + storedCost.cacheWrite;
	}
	return buildUsageRecord({
		event,
		storedCost,
		modelLookup: accounting.modelLookup,
		config: accounting.config,
	});
}

function* walkJsonl({ dir }: { dir: string }): Generator<string> {
	const entries = fs.readdirSync(dir, { withFileTypes: true });
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) yield* walkJsonl({ dir: full });
		else if (entry.isFile() && entry.name.endsWith('.jsonl')) yield full;
	}
}

function number({ value }: { value: unknown }): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function string({ value }: { value: unknown }): string | undefined {
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}
