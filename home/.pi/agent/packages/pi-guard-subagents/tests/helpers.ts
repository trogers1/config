import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function makeTmpDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}
