/** Shared character limits for task and session metadata at public and service boundaries. */
export const BACKGROUND_TASK_FIELD_BOUNDS = Object.freeze({
  maxCommandChars: 2_048,
  maxCwdChars: 1_024,
  maxNameChars: 256,
  maxIdChars: 256,
  maxSessionIdChars: 256,
});
