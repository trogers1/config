import type { UsageConfig } from './config';
import {
	calculateTokenMeter,
	selectRates,
	type MeterAmounts,
	type TieredTokenRates,
	type TokenUsage,
} from './metering';
import type { UsageCharge, UsageEvent, UsageRecord } from './db';

export type PricedModel = { cost: TieredTokenRates };
export type ModelLookup = (args: { provider: string; model: string }) => PricedModel | undefined;
export type StoredCost = MeterAmounts;

export function buildUsageRecord({
	event,
	storedCost,
	modelLookup,
	config,
}: {
	event: UsageEvent;
	storedCost: StoredCost;
	modelLookup: ModelLookup;
	config: UsageConfig;
}): UsageRecord {
	return {
		event,
		charges: resolveCharges({ event, storedCost, modelLookup, config }),
	};
}

export function resolveCharges({
	event,
	storedCost,
	modelLookup,
	config,
}: {
	event: UsageEvent;
	storedCost: StoredCost;
	modelLookup: ModelLookup;
	config: UsageConfig;
}): UsageCharge[] {
	const usage = tokenUsage({ event });
	const charges: UsageCharge[] = [];
	const pricedModel = modelLookup({
		provider: event.provider,
		model: event.model,
	});

	if (pricedModel) {
		const rates = selectRates({ usage, configuredRates: pricedModel.cost });
		charges.push(
			charge({
				meter: 'cost',
				unit: 'USD',
				rateCard: 'model-registry',
				rates,
				amounts: calculateTokenMeter({
					usage,
					configuredRates: pricedModel.cost,
				}),
			})
		);
	} else if (storedCost.total !== 0) {
		charges.push({
			meter: 'cost',
			unit: 'USD',
			rateCard: 'session',
			rates: undefined,
			...storedCost,
		});
	}

	for (const [name, rateCard] of Object.entries(config.rateCards)) {
		if (
			rateCard.provider &&
			lower({ value: rateCard.provider }) !== lower({ value: event.provider })
		)
			continue;
		const rates = rateCard.models[event.model];
		if (!rates) continue;
		charges.push(
			charge({
				meter: name,
				unit: rateCard.unit,
				rateCard: name,
				rates,
				amounts: calculateTokenMeter({ usage, configuredRates: rates }),
			})
		);
	}
	return charges;
}

function tokenUsage({ event }: { event: UsageEvent }): TokenUsage {
	return {
		input: event.inputTokens,
		output: event.outputTokens,
		cacheRead: event.cacheReadTokens,
		cacheWrite: event.cacheWriteTokens,
	};
}

function charge({
	meter,
	unit,
	rateCard,
	rates,
	amounts,
}: {
	meter: string;
	unit: string;
	rateCard: string;
	rates: TieredTokenRates;
	amounts: MeterAmounts;
}): UsageCharge {
	return { meter, unit, rateCard, rates, ...amounts };
}

function lower({ value }: { value: string }): string {
	return value.toLowerCase();
}
