import { Type, type Static, type TSchema } from 'typebox';
import { Check, Errors } from 'typebox/value';

const callable = Type.Function([], Type.Unknown());
const ui = Type.Object({
	notify: Type.Function([Type.String(), Type.Optional(Type.String())], Type.Unknown()),
	setStatus: Type.Function([Type.String(), Type.Optional(Type.String())], Type.Unknown()),
});

const baseContext = {
	cwd: Type.String(),
	ui,
};

export const sessionStartContextSchema = Type.Object({
	...baseContext,
	modelRegistry: Type.Object({ refresh: callable }),
});

export const liveMessageContextSchema = Type.Object({
	...baseContext,
	modelRegistry: Type.Object({
		find: Type.Function([Type.String(), Type.String()], Type.Unknown()),
	}),
	sessionManager: Type.Object({
		getEntries: callable,
		getSessionFile: callable,
	}),
});

export const usageCommandContextSchema = Type.Object({
	...baseContext,
	modelRegistry: Type.Object({
		refresh: callable,
		find: Type.Function([Type.String(), Type.String()], Type.Unknown()),
	}),
});

export const shutdownContextSchema = Type.Object({ ui });

const finiteNumber = Type.Number({ finite: true });
const storedCostSchema = Type.Object({
	input: finiteNumber,
	output: finiteNumber,
	cacheRead: finiteNumber,
	cacheWrite: finiteNumber,
	total: finiteNumber,
});

export const assistantUsageMessageSchema = Type.Object({
	role: Type.Literal('assistant'),
	provider: Type.String({ minLength: 1 }),
	model: Type.String({ minLength: 1 }),
	timestamp: finiteNumber,
	usage: Type.Object({
		input: finiteNumber,
		output: finiteNumber,
		cacheRead: finiteNumber,
		cacheWrite: finiteNumber,
		totalTokens: finiteNumber,
		cost: storedCostSchema,
	}),
});

export function assertPiShape<Schema extends TSchema, TValue>({
	value,
	schema,
	boundary,
}: {
	value: TValue;
	schema: Schema;
	boundary: string;
}): TValue & Static<Schema> {
	if (!Check(schema, value)) {
		const issue = [...Errors(schema, value)][0];
		const location = issue?.instancePath || 'value';
		throw new Error(
			`pi-usage is incompatible with this Pi runtime: ${boundary} requires ${location} ${issue?.message ?? 'to match the supported shape'}`
		);
	}

	// Check above proves that this runtime value has TypeBox's declared shape.
	return value as TValue & Static<Schema>;
}

export function notifyCompatibilityError({
	value,
	error,
}: {
	value: unknown;
	error: unknown;
}): void {
	if (!(error instanceof Error)) return;
	if (!error.message.startsWith('pi-usage is incompatible with this Pi runtime:')) return;
	const notify =
		value &&
		typeof value === 'object' &&
		typeof (value as { ui?: { notify?: unknown } }).ui?.notify === 'function'
			? (value as { ui: { notify: (message: string, type: 'error') => void } }).ui.notify
			: undefined;
	notify?.(error.message, 'error');
}
