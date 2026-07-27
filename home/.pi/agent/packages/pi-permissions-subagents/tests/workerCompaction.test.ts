import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CompactOptions } from "@earendil-works/pi-coding-agent";
import subagentExtension, { workerCompactionThreshold } from "../extensions/index.ts";
import { createExtensionRegistrationRecorder, createFakeCompactionContext } from "./helpers.ts";

describe("worker auto-compaction", () => {
	const originalDepth = process.env.PI_SUBAGENT_DEPTH;

	beforeEach(() => {
		process.env.PI_SUBAGENT_DEPTH = "1";
	});

	afterEach(() => {
		if (originalDepth === undefined) delete process.env.PI_SUBAGENT_DEPTH;
		else process.env.PI_SUBAGENT_DEPTH = originalDepth;
	});

	/** Registers the extension and returns a fire() that emits a turn_end with the given usage. */
	function setup() {
		const recorder = createExtensionRegistrationRecorder();
		subagentExtension(recorder.api);
		const handlers = recorder.getEventHandlers("turn_end");
		expect(handlers).toHaveLength(1);

		const compactCalls: CompactOptions[] = [];
		const fire = (tokens: number | null, contextWindow = 200_000) =>
			handlers[0]({}, createFakeCompactionContext({ tokens, contextWindow }, compactCalls));
		return { compactCalls, fire };
	}

	it("computes the threshold as 40% of the context window, capped at 150k tokens", () => {
		expect(workerCompactionThreshold(200_000)).toBe(80_000);
		expect(workerCompactionThreshold(375_000)).toBe(150_000);
		expect(workerCompactionThreshold(1_000_000)).toBe(150_000);
		expect(workerCompactionThreshold(100_000)).toBe(40_000);
	});

	it("compacts when a worker's context crosses the threshold", () => {
		const { compactCalls, fire } = setup();
		fire(70_000); // 200k window → threshold 80k
		expect(compactCalls).toHaveLength(0);
		fire(90_000);
		expect(compactCalls).toHaveLength(1);
		expect(compactCalls[0].customInstructions).toContain("subagent worker");
	});

	it("applies the 150k cap for large context windows", () => {
		const { compactCalls, fire } = setup();
		fire(140_000, 1_000_000);
		expect(compactCalls).toHaveLength(0);
		fire(160_000, 1_000_000);
		expect(compactCalls).toHaveLength(1);
	});

	it("does not refire while the context stays above the threshold", () => {
		const { compactCalls, fire } = setup();
		fire(90_000);
		fire(95_000);
		fire(100_000);
		expect(compactCalls).toHaveLength(1);
	});

	it("re-arms after the context drops back below the threshold", () => {
		const { compactCalls, fire } = setup();
		fire(90_000);
		expect(compactCalls).toHaveLength(1);
		fire(30_000); // compaction shrank the context
		fire(85_000);
		expect(compactCalls).toHaveLength(2);
	});

	it("compacts on the first turn of a warm-resumed session already above the threshold", () => {
		const { compactCalls, fire } = setup();
		fire(120_000);
		expect(compactCalls).toHaveLength(1);
	});

	it("ignores turns with unknown token counts", () => {
		const { compactCalls, fire } = setup();
		fire(null);
		expect(compactCalls).toHaveLength(0);
	});

	it("does not compact outside worker sessions", () => {
		const { compactCalls, fire } = setup();
		delete process.env.PI_SUBAGENT_DEPTH;
		fire(190_000);
		expect(compactCalls).toHaveLength(0);
	});
});
