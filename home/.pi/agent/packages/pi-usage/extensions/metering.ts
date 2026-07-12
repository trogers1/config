export type TokenUsage = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
};

export type TokenRates = TokenUsage;

export type TieredTokenRates = TokenRates & {
	tiers?: Array<TokenRates & { inputTokensAbove: number }>;
};

export type MeterAmounts = TokenUsage & { total: number };

export function calculateTokenMeter({
	usage,
	configuredRates,
}: {
	usage: TokenUsage;
	configuredRates: TieredTokenRates;
}): MeterAmounts {
	const rates = selectRates({ usage, configuredRates });
	const input = perMillion({ tokens: usage.input, rate: rates.input });
	const output = perMillion({ tokens: usage.output, rate: rates.output });
	const cacheRead = perMillion({
		tokens: usage.cacheRead,
		rate: rates.cacheRead,
	});
	const cacheWrite = perMillion({
		tokens: usage.cacheWrite,
		rate: rates.cacheWrite,
	});
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		total: input + output + cacheRead + cacheWrite,
	};
}

export function selectRates({
	usage,
	configuredRates,
}: {
	usage: TokenUsage;
	configuredRates: TieredTokenRates;
}): TokenRates {
	const inputTokens = usage.input + usage.cacheRead + usage.cacheWrite;
	let selected: TokenRates = configuredRates;
	let threshold = -1;
	for (const tier of configuredRates.tiers ?? []) {
		if (inputTokens > tier.inputTokensAbove && tier.inputTokensAbove > threshold) {
			selected = tier;
			threshold = tier.inputTokensAbove;
		}
	}
	return selected;
}

function perMillion({ tokens, rate }: { tokens: number; rate: number }): number {
	return (finite({ value: tokens }) * finite({ value: rate })) / 1_000_000;
}

function finite({ value }: { value: number }): number {
	return Number.isFinite(value) ? value : 0;
}
