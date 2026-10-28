import { Type, type Static } from "typebox";
import { parseOrThrow } from "../../extensions/interactive/types.ts";
import { MessageDiagnosticSchema, unavailableMessageDiagnostic } from "./message-observer.ts";

const phases = {
	execution: "execution",
	shutdown: "shutdown",
	finalValidation: "finalValidation",
	acceptance: "acceptance",
	deletion: "deletion",
	reporting: "reporting",
} as const;
const StatusSchema = Type.Union([
	Type.Literal("pending"),
	Type.Literal("passed"),
	Type.Literal("failed"),
	Type.Literal("blocked"),
]);
const DiagnosticsSchema = Type.Array(MessageDiagnosticSchema, { maxItems: 2 });
export const MessageOutcomeSchema = Type.Object(
	{
		primary: Type.Union([Type.Null(), Type.Enum(phases)]),
		execution: StatusSchema,
		acceptance: StatusSchema,
		shutdown: StatusSchema,
		finalValidation: StatusSchema,
		deletion: StatusSchema,
		reporting: StatusSchema,
		diagnostics: DiagnosticsSchema,
	},
	{ additionalProperties: false },
);
type Outcome = Static<typeof MessageOutcomeSchema>;

/** Run strict lifecycle gates without exposing or replacing the primary failure. */
export async function runMessageOutcome({
	execute,
	shutdown,
	validate,
	accept,
	remove,
	diagnostics,
	emit,
}: {
	execute: () => Promise<void>;
	shutdown: () => Promise<void>;
	validate: () => void;
	accept: () => void;
	remove: () => Promise<void>;
	diagnostics: () => unknown;
	emit: (report: Outcome) => void;
}) {
	const outcome: Outcome = {
		primary: null,
		execution: "pending",
		acceptance: "pending",
		shutdown: "pending",
		finalValidation: "pending",
		deletion: "pending",
		reporting: "pending",
		diagnostics: [],
	};
	const fail = ({ phase }: { phase: keyof typeof phases }) => {
		outcome[phase] = "failed";
		outcome.primary ??= phase;
	};
	let captured = false;
	const report = () => {
		if (!captured) {
			captured = true;
			try {
				outcome.diagnostics = parseOrThrow(DiagnosticsSchema, structuredClone(diagnostics()), "bounded diagnostics");
			} catch {
				outcome.diagnostics = [unavailableMessageDiagnostic()];
				fail({ phase: "reporting" });
			}
		}
		try {
			if (outcome.reporting !== "failed") outcome.reporting = "passed";
			emit(parseOrThrow(MessageOutcomeSchema, structuredClone(outcome), "message outcome"));
		} catch {
			fail({ phase: "reporting" });
		}
	};
	try {
		await execute();
		outcome.execution = "passed";
	} catch {
		fail({ phase: "execution" });
	}
	try {
		await shutdown();
		outcome.shutdown = "passed";
	} catch {
		fail({ phase: "shutdown" });
	}
	if (outcome.shutdown === "passed") {
		try {
			validate();
			outcome.finalValidation = "passed";
		} catch {
			fail({ phase: "finalValidation" });
		}
		if (outcome.finalValidation === "passed") {
			if (outcome.execution === "passed") {
				try {
					accept();
					outcome.acceptance = "passed";
				} catch {
					fail({ phase: "acceptance" });
				}
			} else outcome.acceptance = "blocked";
		} else outcome.acceptance = "blocked";
	} else {
		outcome.finalValidation = "blocked";
		outcome.acceptance = "blocked";
	}
	const canDelete =
		outcome.shutdown === "passed" && outcome.finalValidation === "passed" && outcome.acceptance !== "failed";
	if (!canDelete) outcome.deletion = "blocked";
	// Report while owned evidence still exists, including refused shutdown/validation.
	if (outcome.primary !== null) report();
	if (canDelete && outcome.reporting !== "failed") {
		try {
			await remove();
			outcome.deletion = "passed";
		} catch {
			fail({ phase: "deletion" });
		}
	} else if (outcome.deletion === "pending") outcome.deletion = "blocked";
	if (outcome.primary !== null) {
		report();
		throw new Error(
			`Messaging lifecycle failed: ${outcome.primary}; ${JSON.stringify(parseOrThrow(MessageOutcomeSchema, outcome, "final message outcome"))}`,
		);
	}
	return parseOrThrow(MessageOutcomeSchema, outcome, "message outcome");
}
