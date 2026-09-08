import * as fs from "node:fs";

const marker = process.env.PI_GUARD_TEST_INIT_MARKER;
if (marker) fs.writeFileSync(marker, "initialized\n", { mode: 0o600 });

export default function markerExtension() {
	// Loading the module is the observable fixture initialization.
}
