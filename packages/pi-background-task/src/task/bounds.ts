export const BACKGROUND_TASK_FIELD_BOUNDS = Object.freeze({
  // The shell receives the command as one argument (`sh -c <command>`). Linux caps one argument
  // at 128 KiB and every platform caps arguments plus environment together, so commands stay
  // well below both.
  maxCommandBytes: 64 * 1_024,
  // Snapshots, results, and UI keep a clipped copy of the command for display only.
  maxCommandDisplayChars: 2_048,
  maxCwdChars: 1_024,
  maxNameChars: 256,
  maxIdChars: 256,
  maxContainsChars: 256,
  // An output wait matches any of a few literal alternatives.
  maxContainsAlternatives: 8,
  // The output line around a match that a wait reports.
  maxMatchedLineChars: 400,
  maxTailLines: 2_000,
  maxWaitSeconds: 3_600,
  maxSignalChars: 256,
  maxErrorChars: 2_048,
  maxSnapshots: 600,
  // The argument names a rejected request's details keep.
  maxFailureFields: 16,
  maxFieldNameChars: 32,
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
  // The newest output a wait result or an exit notice repeats, so the agent rarely needs logs.
  recentOutputLines: 20,
  recentOutputBytes: 4_096,
});
