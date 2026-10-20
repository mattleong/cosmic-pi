export const MAX_RETAINED_RUNS = 50;
export const MAX_TARGET_RUNS = 12;
export const MAX_START_BATCH = 32;
/** Bounds every model-facing tool result, so it bounds the parent's context. */
export const MAX_TOOL_OUTPUT_CHARS = 48_000;
/** Bounds each root completion or question notice. */
export const MAX_NOTIFICATION_CHARS = 32 * 1024;
export const MAX_PARENT_MESSAGE_CHARS = 64 * 1024;
export const MAX_PROTOCOL_ID_CHARS = 1_024;
export const MAX_UNRESOLVED_REPORT_GENERATIONS = 64;
export const MAX_COMPLETION_DELIVERY_BATCH = 12;
export const COMPLETION_RETRY_INITIAL_MILLIS = 100;
export const COMPLETION_RETRY_MAX_MILLIS = 30_000;
/**
 * The retained text of a child's progress, warning, or question. A question notice delivers a
 * question whole, and agent_read returns a question or warning whole; progress shows only as a
 * bounded card field.
 */
export const MAX_CONTACT_TEXT_CHARS = 16 * 1024;
/**
 * Multi-run output shows at most this much of a failure, question, or unsaved report. A longer
 * failure is saved to the session's report directory, and its preview names the file.
 */
export const MAX_OUTCOME_PREVIEW_CHARS = 240;
/** The longest outcome file path the archive saves; a longer one saves nothing. */
export const MAX_OUTCOME_FILE_PATH_CHARS = 384;
