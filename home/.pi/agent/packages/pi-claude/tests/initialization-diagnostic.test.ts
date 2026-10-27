import { test } from "vitest";
import {
  diagnosticJson,
  runInitializationDiagnostic,
} from "./fixtures/initialization-diagnostic.ts";

// PARENT/OPERATOR ONLY: a separately authorized one-turn identity diagnostic.
// Neither the no-input probe nor the write/read acceptance opt-in enables it.
// No fake SDK: real Pi provider/guard, installed executable resolver and SDK.
test.skipIf(process.env.PI_CLAUDE_INIT_DIAGNOSTIC !== "1")(
  "live: one-turn initialization identity diagnostic (NOT acceptance)",
  async () => {
    const report = await runInitializationDiagnostic({ live: true });
    console.log(diagnosticJson({ report }));
    if (!report.diagnosticSuccess)
      throw new Error(`Initialization identity diagnostic failed: ${report.category}`);
  },
  25_000,
);
