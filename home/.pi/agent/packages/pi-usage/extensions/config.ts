import fs from 'node:fs';
import path from 'node:path';
import { getAgentDir } from './db';
import type { TokenRates } from './metering';
export type UsagePeriod = 'day' | 'week' | 'month' | '7d' | '30d';
export type RateCardConfig = {
	unit: string;
	provider?: string;
	models: Record<string, TokenRates>;
};
export type UsageLimit = {
	name?: string;
	provider?: string;
	model?: string;
	meter: string;
	maximum: number;
	period?: UsagePeriod;
	startDate?: string;
	yellowAt?: number;
	redAt?: number;
	shouldAlwaysDisplay?: boolean;
};
export type UsageConfig = {
	limits: UsageLimit[];
	rateCards: Record<string, RateCardConfig>;
	yellowAt?: number;
	redAt?: number;
};
export function getUsageConfigPath(): string {
	return path.join(getAgentDir(), 'usage', 'usage.json');
}
export function readUsageConfig(): UsageConfig {
	const configPath = getUsageConfigPath();
	if (!fs.existsSync(configPath)) return { limits: [], rateCards: {} };
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
	} catch (error) {
		throw new Error(`Invalid ${path.basename(configPath)}: ${errorMessage({ error })}`);
	}
	if (!isObject({ value: parsed }))
		throw new Error(`${path.basename(configPath)} must contain a JSON object`);
	const config = parsed as Record<string, unknown>;
	const rateCards = parseRateCards({ value: config.rateCards });
	const limits = parseLimits({ value: config.limits, rateCards });
	return {
		limits,
		rateCards,
		yellowAt: optionalFiniteNumber({ value: config.yellowAt, at: 'yellowAt' }),
		redAt: optionalFiniteNumber({ value: config.redAt, at: 'redAt' }),
	};
}
function parseRateCards({ value }: { value: unknown }): Record<string, RateCardConfig> {
	if (value === undefined) return {};
	if (!isObject({ value })) throw new Error('usage.json rateCards must be an object');
	const result: Record<string, RateCardConfig> = {};
	for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
		if (name === 'cost' || name === 'tokens')
			throw new Error(`usage.json rate card name is reserved: ${name}`);
		if (!isObject({ value: raw }))
			throw new Error(`usage.json rateCards.${name} must be an object`);
		const rateCard = raw as Record<string, unknown>;
		const unit = requiredString({
			value: rateCard.unit,
			at: `rateCards.${name}.unit`,
		});
		if (!isObject({ value: rateCard.models }))
			throw new Error(`usage.json rateCards.${name}.models must be an object`);
		const models: Record<string, TokenRates> = {};
		for (const [model, rates] of Object.entries(rateCard.models as Record<string, unknown>)) {
			models[model] = parseRates({
				value: rates,
				at: `rateCards.${name}.models.${model}`,
			});
		}
		result[name] = {
			unit,
			provider: optionalString({
				value: rateCard.provider,
				at: `rateCards.${name}.provider`,
			}),
			models,
		};
	}
	return result;
}
function parseLimits({
	value,
	rateCards,
}: {
	value: unknown;
	rateCards: Record<string, RateCardConfig>;
}): UsageLimit[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new Error('usage.json limits must be an array');
	return value.map((raw, index) => {
		const at = `limits[${index}]`;
		if (!isObject({ value: raw })) throw new Error(`usage.json ${at} must be an object`);
		const limit = raw as Record<string, unknown>;
		const meter = requiredString({ value: limit.meter, at: `${at}.meter` });
		if (meter !== 'cost' && meter !== 'tokens' && !rateCards[meter])
			throw new Error(`usage.json ${at}.meter references unknown meter: ${meter}`);
		return {
			name: optionalString({ value: limit.name, at: `${at}.name` }),
			provider: optionalString({ value: limit.provider, at: `${at}.provider` }),
			model: optionalString({ value: limit.model, at: `${at}.model` }),
			meter,
			maximum: requiredPositiveNumber({
				value: limit.maximum,
				at: `${at}.maximum`,
			}),
			period:
				limit.period === undefined
					? undefined
					: parsePeriod({ value: limit.period, at: `${at}.period` }),
			startDate: optionalString({
				value: limit.startDate,
				at: `${at}.startDate`,
			}),
			yellowAt: optionalFiniteNumber({
				value: limit.yellowAt,
				at: `${at}.yellowAt`,
			}),
			redAt: optionalFiniteNumber({ value: limit.redAt, at: `${at}.redAt` }),
			shouldAlwaysDisplay: limit.shouldAlwaysDisplay === true,
		};
	});
}
function parseRates({ value, at }: { value: unknown; at: string }): TokenRates {
	if (!isObject({ value })) throw new Error(`usage.json ${at} must be an object`);
	const rates = value as Record<string, unknown>;
	return {
		input: requiredNonnegativeNumber({ value: rates.input, at: `${at}.input` }),
		output: requiredNonnegativeNumber({
			value: rates.output,
			at: `${at}.output`,
		}),
		cacheRead: requiredNonnegativeNumber({
			value: rates.cacheRead,
			at: `${at}.cacheRead`,
		}),
		cacheWrite: requiredNonnegativeNumber({
			value: rates.cacheWrite,
			at: `${at}.cacheWrite`,
		}),
	};
}
function parsePeriod({ value, at }: { value: unknown; at: string }): UsagePeriod {
	if (value === 'day' || value === 'week' || value === 'month' || value === '7d' || value === '30d')
		return value;
	throw new Error(`usage.json ${at} must be day, week, month, 7d, or 30d`);
}
function requiredString({ value, at }: { value: unknown; at: string }): string {
	if (typeof value === 'string' && value.length > 0) return value;
	throw new Error(`usage.json ${at} must be a non-empty string`);
}
function optionalString({ value, at }: { value: unknown; at: string }): string | undefined {
	return value === undefined ? undefined : requiredString({ value, at });
}
function requiredPositiveNumber({ value, at }: { value: unknown; at: string }): number {
	if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
	throw new Error(`usage.json ${at} must be a positive number`);
}
function requiredNonnegativeNumber({ value, at }: { value: unknown; at: string }): number {
	if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
	throw new Error(`usage.json ${at} must be a nonnegative number`);
}
function optionalFiniteNumber({ value, at }: { value: unknown; at: string }): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	throw new Error(`usage.json ${at} must be a finite number`);
}
function isObject({ value }: { value: unknown }): boolean {
	return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
function errorMessage({ error }: { error: unknown }): string {
	return error instanceof Error ? error.message : String(error);
}
