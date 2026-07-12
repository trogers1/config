import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { buildUsageRecord, type ModelLookup } from './accounting';
import type { UsageConfig } from './config';
import { getAgentDir, recordUsage, type UsageEvent, type UsageRecord } from './db';

export type ImportSummary = {
	filesScanned: number;
	eventsFound: number;
	inserted: number;
	updated: number;
	unchanged: number;
	errors: number;
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
	let lineCount = 0;

	for await (const line of lines) {
		lineCount++;
		if (lineCount % 500 === 0) onProgress?.({ currentFileLines: lineCount });
		if (!line.trim()) continue;
		let entry: any;
		try {
			entry = JSON.parse(line);
		} catch {
			summary.errors++;
			onProgress?.({ currentFileLines: lineCount });
			continue;
		}

		if (entry?.type === 'session' && typeof entry.cwd === 'string') {
			headerCwd = entry.cwd;
			continue;
		}

		const record = usageRecordFromEntry({
			entry,
			sessionFile: file,
			accounting,
			cwd: headerCwd,
		});
		if (!record) continue;
		summary.eventsFound++;
		try {
			const result = recordUsage({ record });
			summary[result]++;
			onProgress?.({ currentFileLines: lineCount });
		} catch {
			summary.errors++;
			onProgress?.({ currentFileLines: lineCount });
		}
	}
	onProgress?.({ currentFileLines: lineCount });
}

export function usageRecordFromEntry({
	entry,
	sessionFile,
	accounting,
	cwd,
}: {
	entry: any;
	sessionFile: string;
	accounting: AccountingOptions;
	cwd?: string;
}): UsageRecord | undefined {
	if (entry?.type !== 'message') return undefined;
	const message = entry.message;
	if (message?.role !== 'assistant' || !message.usage) return undefined;
	return usageRecordFromMessage({
		message,
		accounting,
		options: {
			source: 'import',
			sessionFile,
			sessionEntryId: typeof entry.id === 'string' ? entry.id : undefined,
			entryTimestamp: typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : undefined,
			cwd,
		},
	});
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
