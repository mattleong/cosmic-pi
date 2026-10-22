export const BACKGROUND_TASK_FIELD_BOUNDS = Object.freeze({
  maxCommandChars: 2_048,
  maxCwdChars: 1_024,
  maxNameChars: 256,
  maxIdChars: 256,
  maxContainsChars: 256,
  maxTailLines: 2_000,
  maxWaitSeconds: 120,
  maxSignalChars: 256,
  maxErrorChars: 2_048,
  maxSnapshots: 600,
});

export const BACKGROUND_LOG_BOUNDS = Object.freeze({
  // Stored output is split into events of at most this size, so any one event fits a text
  // result. With its overhead, one event also fits the smallest per-task budget (4 KiB).
  maxEventBytes: 4_000,
  maxEventLines: 200,
  // Approximate memory each retained event costs beyond its text; budgets charge it.
  eventOverheadBytes: 96,
  // In-flight output per task, independent of retained budgets; at least one pipe read.
  minIngressBytes: 64 * 1_024,
  maxIngressBytes: 256 * 1_024,
});
