import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { createLocalBashOperations } from "@earendil-works/pi-coding-agent";

export function createSandboxedLocalOperations(): BashOperations {
  return createLocalBashOperations();
}
