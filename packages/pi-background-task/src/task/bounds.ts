/** Shared admission and output-contract limits for task and session metadata. */
export const BACKGROUND_TASK_FIELD_BOUNDS = Object.freeze({
  maxCommandChars: 2_048,
  maxCwdChars: 1_024,
  maxNameChars: 256,
  maxIdChars: 256,
  maxSessionIdChars: 256,
  maxContainsChars: 256,
  maxTailLines: 2_000,
  maxWaitSeconds: 120,
  maxSignalChars: 256,
  maxErrorChars: 2_048,
  maxFailureLineChars: 64,
  maxSnapshots: 600,
});
