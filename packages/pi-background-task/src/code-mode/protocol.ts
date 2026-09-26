import {
  BACKGROUND_TASK_PRESENTATION_VERSION,
  normalizeBackgroundTaskPresentation,
  observeBackgroundTaskPresentation,
  type BackgroundTaskPresentationObserver,
} from "./presentation.ts";
import * as Schema from "effect/Schema";
import { makeSessionCapabilityProtocol, type SessionCapabilityQuery } from "pi-cosmic-core";
import { BACKGROUND_TASK_FIELD_BOUNDS } from "../task/bounds.ts";
import {
  BACKGROUND_TASK_ACTIONS,
  BackgroundLogMetadataSchema,
  BackgroundTaskSnapshotSchema,
  BackgroundTaskSnapshotsSchema,
  BackgroundTaskWaitResultSchema,
  MaxChars,
} from "../task/schema.ts";

export const BACKGROUND_TASK_CODE_MODE_VERSION = 1 as const;
export const BACKGROUND_TASK_CODE_MODE_QUERY = "pi-background-task:v1:code-mode:query";

/** Structural limits of the v1 Code Mode request and response codecs. */
export const BACKGROUND_TASK_CODE_MODE_BOUNDS = Object.freeze({
  minTimeoutSeconds: 0.001,
  maxContainsChars: BACKGROUND_TASK_FIELD_BOUNDS.maxContainsChars,
  maxTailLines: BACKGROUND_TASK_FIELD_BOUNDS.maxTailLines,
  maxWaitSeconds: BACKGROUND_TASK_FIELD_BOUNDS.maxWaitSeconds,
  maxTextChars: 65_536,
  maxIdChars: BACKGROUND_TASK_FIELD_BOUNDS.maxIdChars,
  maxNameChars: BACKGROUND_TASK_FIELD_BOUNDS.maxNameChars,
  maxCommandChars: BACKGROUND_TASK_FIELD_BOUNDS.maxCommandChars,
  maxPathChars: BACKGROUND_TASK_FIELD_BOUNDS.maxCwdChars,
  maxSessionIdChars: BACKGROUND_TASK_FIELD_BOUNDS.maxSessionIdChars,
  maxSignalChars: BACKGROUND_TASK_FIELD_BOUNDS.maxSignalChars,
  maxErrorChars: BACKGROUND_TASK_FIELD_BOUNDS.maxErrorChars,
  maxSnapshots: BACKGROUND_TASK_FIELD_BOUNDS.maxSnapshots,
});

const BOUNDS = BACKGROUND_TASK_CODE_MODE_BOUNDS;
const BoundedText = MaxChars(BOUNDS.maxTextChars);

/** Exact v1 input contract accepted by the Background Tasks provider. */
export const BackgroundTaskCodeModeInputSchema = Schema.Struct({
  action: Schema.Literals(BACKGROUND_TASK_ACTIONS),
  command: Schema.optionalKey(MaxChars(BOUNDS.maxCommandChars)),
  cwd: Schema.optionalKey(MaxChars(BOUNDS.maxPathChars)),
  name: Schema.optionalKey(MaxChars(BOUNDS.maxNameChars)),
  timeoutSeconds: Schema.optionalKey(
    Schema.Finite.check(Schema.isGreaterThanOrEqualTo(BOUNDS.minTimeoutSeconds)),
  ),
  id: Schema.optionalKey(MaxChars(BOUNDS.maxIdChars)),
  state: Schema.optionalKey(Schema.Literals(["active", "completed", "all"])),
  until: Schema.optionalKey(
    Schema.Literals(["exit", "output"]).annotate({
      description:
        'Required for wait. Use "exit" for process completion or "output" for a literal text match.',
    }),
  ),
  contains: Schema.optionalKey(
    Schema.String.check(
      Schema.isMinLength(1),
      Schema.isMaxLength(BOUNDS.maxContainsChars),
    ).annotate({
      description: 'Literal text required for until="output"; invalid for until="exit".',
    }),
  ),
  afterCursor: Schema.optionalKey(
    Schema.Natural.annotate({
      description: 'Read logs or match output after this cursor; invalid for until="exit".',
    }),
  ),
  tailLines: Schema.optionalKey(
    Schema.Natural.check(Schema.isBetween({ minimum: 1, maximum: BOUNDS.maxTailLines })),
  ),
  waitSeconds: Schema.optionalKey(
    Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: BOUNDS.maxWaitSeconds })),
  ),
  force: Schema.optionalKey(Schema.Boolean),
});

/** Exact v1 detached result contract returned to one Code Mode program. */
export const BackgroundTaskCodeModeOutputSchema = Schema.Union([
  Schema.Struct({
    action: Schema.Literals(["start", "status", "stop"]),
    text: BoundedText,
    snapshot: BackgroundTaskSnapshotSchema,
  }),
  Schema.Struct({
    action: Schema.Literals(["list", "stop_all"]),
    text: BoundedText,
    tasks: BackgroundTaskSnapshotsSchema,
  }),
  Schema.Struct({
    action: Schema.Literal("logs"),
    text: BoundedText,
    logs: BackgroundLogMetadataSchema,
  }),
  Schema.Struct({
    action: Schema.Literal("wait"),
    text: BoundedText,
    wait: BackgroundTaskWaitResultSchema,
  }),
  Schema.Struct({
    action: Schema.Literal("clear"),
    text: BoundedText,
    removed: Schema.Natural,
  }),
]);

export type BackgroundTaskCodeModeInput = typeof BackgroundTaskCodeModeInputSchema.Type;
export type BackgroundTaskCodeModeLogMetadata = typeof BackgroundLogMetadataSchema.Type;
export type BackgroundTaskCodeModeOutput = typeof BackgroundTaskCodeModeOutputSchema.Type;

export interface BackgroundTaskCodeModeCapability {
  readonly version: typeof BACKGROUND_TASK_CODE_MODE_VERSION;
  readonly sessionId: string;
  /** Acknowledges the current presentation receipt; older receipt versions are not observed. */
  readonly presentationVersion?: typeof BACKGROUND_TASK_PRESENTATION_VERSION;
  readonly execute: (
    callId: string,
    input: BackgroundTaskCodeModeInput,
    signal: AbortSignal,
    maxOutputBytes: number,
    observePresentation?: BackgroundTaskPresentationObserver,
  ) => Promise<BackgroundTaskCodeModeOutput>;
}

const codeModeProtocol = makeSessionCapabilityProtocol({
  version: BACKGROUND_TASK_CODE_MODE_VERSION,
  maxSessionIdChars: BACKGROUND_TASK_CODE_MODE_BOUNDS.maxSessionIdChars,
});

export type BackgroundTaskCodeModeQuery = SessionCapabilityQuery<
  typeof BACKGROUND_TASK_CODE_MODE_VERSION
>;

/** Reads a hostile event payload once and retains only the checked response capability. */
export const normalizeBackgroundTaskCodeModeQuery = codeModeProtocol.normalizeQuery;

/** Reads a hostile provider response once and retains only the checked execution capability. */
export const normalizeBackgroundTaskCodeModeCapability = <Value>(
  value: Value,
): BackgroundTaskCodeModeCapability | undefined => {
  const decoded = codeModeProtocol.decodeCapability(value);
  if (!decoded) return undefined;
  const execute = decoded.execute;
  let observes = false;
  try {
    const field = Object.getOwnPropertyDescriptor(value, "presentationVersion");
    observes =
      field !== undefined &&
      "value" in field &&
      field.value === BACKGROUND_TASK_PRESENTATION_VERSION;
  } catch {
    /* Optional observation is unavailable. */
  }
  return Object.freeze({
    version: decoded.version,
    sessionId: decoded.sessionId,
    ...(observes && { presentationVersion: BACKGROUND_TASK_PRESENTATION_VERSION }),
    execute: (
      callId: string,
      input: BackgroundTaskCodeModeInput,
      signal: AbortSignal,
      maxOutputBytes: number,
      observePresentation?: BackgroundTaskPresentationObserver,
    ) =>
      observes && observePresentation
        ? execute(callId, input, signal, maxOutputBytes, <Value>(value: Value) => {
            const receipt = normalizeBackgroundTaskPresentation(value);
            if (receipt) observeBackgroundTaskPresentation(observePresentation, receipt);
          })
        : execute(callId, input, signal, maxOutputBytes),
  });
};
