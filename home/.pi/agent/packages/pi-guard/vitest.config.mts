import { defineConfig } from "vitest/config";
import { postureEnvironmentVariable } from "./modules/posture";

export default defineConfig({
  test: {
    // A session posture is inherited by every child process, including a
    // test run started from a postured session; tests must start without one.
    env: { [postureEnvironmentVariable]: "" },
  },
});
