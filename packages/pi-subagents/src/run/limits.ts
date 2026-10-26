export const MAX_RETAINED_RUNS = 50;
/** Await targets: each gets a full run block, so a whole batch fits one result. */
export const MAX_TARGET_RUNS = 12;
export const MAX_START_BATCH = 32;
/** Interrupt and stop targets: their blocks carry no outcome lines, so a start batch's worth fits. */
export const MAX_LIFECYCLE_TARGET_RUNS = MAX_START_BATCH;
/** Bounds every model-facing tool result, so it bounds the parent's context. */
export const MAX_TOOL_OUTPUT_CHARS = 48_000;
/** Bounds each root completion or question notice. */
export const MAX_NOTIFICATION_CHARS = 32 * 1024;
/**
 * Bounds parent-channel text on the wire, such as contact messages, replies, nested notices, and
 * the guidance or answers a user or agent sends. A message that resumes a run is a new assignment,
 * bounded like a task instead.
 */
export const MAX_PARENT_MESSAGE_CHARS = 64 * 1024;
export const MAX_PROTOCOL_ID_CHARS = 1_024;
export const MAX_UNRESOLVED_REPORT_GENERATIONS = 64;
export const MAX_COMPLETION_DELIVERY_BATCH = 12;
/** Reports one ancestor run may take and still hand on if its assignment fails or stops. */
export const MAX_TAKEN_REPORTS_PER_RUN = 64;
export const COMPLETION_RETRY_INITIAL_MILLIS = 100;
export const COMPLETION_RETRY_MAX_MILLIS = 30_000;
/**
 * The retained text of a child's progress, warning, or question. The root accepts contact
 * messages of up to `MAX_PARENT_MESSAGE_CHARS` and keeps a longer one's start with a marker naming
 * its size. A question notice delivers the retained question whole, and agent_read returns a
 * question or warning whole; progress shows only as a bounded card field.
 */
export const MAX_CONTACT_TEXT_CHARS = 16 * 1024;
/**
 * Multi-run output shows at most this much of a failure, question, or unsaved report. A longer
 * failure is saved to the session's report directory, and its preview names the file.
 */
export const MAX_OUTCOME_PREVIEW_CHARS = 240;
/**
 * How long a settlement holds the run lock for its report file. A slower save settles without the
 * file, so the parent gets the report inline, and the save removes its file once it finishes.
 */
export const REPORT_SAVE_DEADLINE_MILLIS = 5_000;
/** The longest outcome file path the archive saves; a longer one saves nothing. */
export const MAX_OUTCOME_FILE_PATH_CHARS = 384;
