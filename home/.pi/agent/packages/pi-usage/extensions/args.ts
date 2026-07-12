export type Range = { label: string; startMs: number; endMs: number };
export type UsageCommand =
	| { kind: 'report'; range: Range; provider?: string; model?: string }
	| { kind: 'import' }
	| {
			kind: 'export';
			path?: string;
			range: Range;
			provider?: string;
			model?: string;
	  };

export const usageHelp = [
	'Usage commands:',
	'  /usage',
	'  /usage today|week|month|7d|30d|1 month',
	'  /usage since YYYY-MM-DD',
	'  /usage provider <provider>',
	'  /usage model <model>',
	'  /usage week provider <provider>',
	'  /usage import',
	'  /usage export [path.csv]',
].join('\n');

export function parseUsageArgs({
	raw,
	now = Date.now(),
}: {
	raw: string;
	now?: number;
}): UsageCommand {
	const tokens = raw.trim().split(/\s+/).filter(Boolean);
	let index = 0;
	if (tokens[index] === 'import') {
		if (tokens.length !== 1) throw new Error(usageHelp);
		return { kind: 'import' };
	}
	const kind = tokens[index] === 'export' ? 'export' : 'report';
	let exportPath: string | undefined;
	if (kind === 'export') index++;
	let range = lastDaysRange({ days: 7, label: 'last 7 days', now });
	let provider: string | undefined;
	let model: string | undefined;
	while (index < tokens.length) {
		const token = tokens[index++];
		if (token === 'today') range = todayRange({ now });
		else if (token === 'week' || token === '7d' || (token === '7' && tokens[index] === 'days')) {
			if (token === '7') index++;
			range = lastDaysRange({ days: 7, label: 'last 7 days', now });
		} else if (
			token === 'month' ||
			token === '30d' ||
			token === '1m' ||
			(token === '1' && tokens[index] === 'month')
		) {
			if (token === '1') index++;
			range = lastDaysRange({ days: 30, label: 'last 30 days', now });
		} else if (token === 'since') {
			const date = tokens[index++];
			if (!date) throw new Error(usageHelp);
			range = sinceRange({ dateText: date, now });
		} else if (token === 'provider') {
			provider = tokens[index++];
			if (!provider) throw new Error(usageHelp);
		} else if (token === 'model') {
			model = tokens[index++];
			if (!model) throw new Error(usageHelp);
		} else if (kind === 'export' && !exportPath) exportPath = token;
		else throw new Error(usageHelp);
	}
	return kind === 'export'
		? { kind: 'export', path: exportPath, range, provider, model }
		: { kind: 'report', range, provider, model };
}

function todayRange({ now }: { now: number }): Range {
	const start = new Date(now);
	start.setHours(0, 0, 0, 0);
	return { label: 'today', startMs: start.getTime(), endMs: now + 1 };
}
function lastDaysRange({ days, label, now }: { days: number; label: string; now: number }): Range {
	const start = new Date(now);
	start.setHours(0, 0, 0, 0);
	start.setDate(start.getDate() - (days - 1));
	return { label, startMs: start.getTime(), endMs: now + 1 };
}
function sinceRange({ dateText, now }: { dateText: string; now: number }): Range {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(dateText)) throw new Error(usageHelp);
	const start = new Date(`${dateText}T00:00:00`);
	if (Number.isNaN(start.getTime())) throw new Error(usageHelp);
	return {
		label: `since ${dateText}`,
		startMs: start.getTime(),
		endMs: now + 1,
	};
}
