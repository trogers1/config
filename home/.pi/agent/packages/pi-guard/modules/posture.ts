/**
 * A session posture resolves the ASKs left after profile composition:
 * `deny` refuses every one without prompting (autopilot), `allow` approves
 * every one. Composition still decides everything else, including any
 * allow or deny produced by profile transforms.
 */
export const postureNames = ["deny", "allow"] as const;
export type Posture = (typeof postureNames)[number];

/**
 * Reads the session posture when a decision is made, not when evaluation
 * starts, so a `/posture` change during earlier awaits still applies.
 */
export type PostureReader = () => Posture | undefined;

/** Launch-time posture. Subagent launchers forward it to children. */
export const postureEnvironmentVariable = "PI_GUARD_POSTURE";

/** Spelling that clears a posture so remaining ASKs prompt again. */
export const postureOff = "off";

class InvalidPostureError extends Error {
  constructor({ value }: { readonly value: string }) {
    super(
      `Invalid ${postureEnvironmentVariable} '${value}'. Use ${[...postureNames, postureOff].join(", ")}.`,
    );
    this.name = "InvalidPostureError";
  }
}

/** Parse a posture spelling; empty or `off` means no posture. */
export function parsePosture({
  value,
}: {
  readonly value: string | undefined;
}): Posture | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === postureOff) return undefined;
  const posture = postureNames.find((name) => name === trimmed);
  if (!posture) throw new InvalidPostureError({ value: trimmed });
  return posture;
}
