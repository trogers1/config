import { describe, expect, it } from 'vitest';
import { calculateTokenMeter } from '../extensions/metering';
const usage = {
	input: 50_000,
	output: 25_000,
	cacheRead: 1_000_000,
	cacheWrite: 0,
};
describe('calculateTokenMeter', () => {
	it('calculates amounts from per-million-token rates', () => {
		const result = calculateTokenMeter({
			usage,
			configuredRates: {
				input: 1.4,
				output: 4.4,
				cacheRead: 0.26,
				cacheWrite: 0,
			},
		});
		expect(result.input).toBeCloseTo(0.07);
		expect(result.output).toBeCloseTo(0.11);
		expect(result.cacheRead).toBeCloseTo(0.26);
		expect(result.total).toBeCloseTo(0.44);
	});
	it('selects the highest matching request-wide pricing tier', () => {
		const result = calculateTokenMeter({
			usage,
			configuredRates: {
				input: 1,
				output: 2,
				cacheRead: 0.1,
				cacheWrite: 0,
				tiers: [
					{
						inputTokensAbove: 100_000,
						input: 2,
						output: 4,
						cacheRead: 0.2,
						cacheWrite: 0,
					},
					{
						inputTokensAbove: 1_000_000,
						input: 3,
						output: 6,
						cacheRead: 0.3,
						cacheWrite: 0,
					},
				],
			},
		});
		expect(result.input).toBeCloseTo(0.15);
		expect(result.output).toBeCloseTo(0.15);
		expect(result.cacheRead).toBeCloseTo(0.3);
	});
});
