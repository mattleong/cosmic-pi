import {
  normalizeBackgroundTaskPresentation,
  observeBackgroundTaskPresentation,
  type BackgroundTaskPresentationObserver,
} from "./presentation.ts";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { BACKGROUND_TASK_FIELD_BOUNDS } from "../task/bounds.ts";

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
  maxSignalChars: 256,
  maxErrorChars: 2_048,
  maxSnapshots: 600,
});

const PositiveFinite = Schema.Finite.check(
  Schema.isGreaterThanOrEqualTo(BACKGROUND_TASK_CODE_MODE_BOUNDS.minTimeoutSeconds),
);
const NonNegativeInteger = Schema.Natural;
const PositiveInteger = NonNegativeInteger.check(Schema.isGreaterThan(0));
const BackgroundTaskStateSchema = Schema.Literals([
  "starting",
  "running",
  "stopping",
  "exited",
  "failed",
  "stopped",
  "timed_out",
]);
const BackgroundTaskSnapshotSchema = Schema.Struct({
  id: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(BACKGROUND_TASK_CODE_MODE_BOUNDS.maxIdChars),
  ),
  name: Schema.optionalKey(
    Schema.String.check(Schema.isMaxLength(BACKGROUND_TASK_CODE_MODE_BOUNDS.maxNameChars)),
  ),
  command: Schema.String.check(
    Schema.isMaxLength(BACKGROUND_TASK_CODE_MODE_BOUNDS.maxCommandChars),
  ),
  cwd: Schema.String.check(Schema.isMaxLength(BACKGROUND_TASK_CODE_MODE_BOUNDS.maxPathChars)),
  state: BackgroundTaskStateSchema,
  pid: Schema.optionalKey(PositiveInteger),
  startedAt: NonNegativeInteger,
  endedAt: Schema.optionalKey(NonNegativeInteger),
  exitCode: Schema.optionalKey(Schema.NullOr(Schema.Int)),
  signal: Schema.optionalKey(
    Schema.String.check(Schema.isMaxLength(BACKGROUND_TASK_CODE_MODE_BOUNDS.maxSignalChars)),
  ),
  error: Schema.optionalKey(
    Schema.String.check(Schema.isMaxLength(BACKGROUND_TASK_CODE_MODE_BOUNDS.maxErrorChars)),
  ),
  logCursor: NonNegativeInteger,
  droppedLogBytes: NonNegativeInteger,
});
const BackgroundTaskCodeModeLogMetadataSchema = Schema.Struct({
  id: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(BACKGROUND_TASK_CODE_MODE_BOUNDS.maxIdChars),
  ),
  nextCursor: NonNegativeInteger,
  earliestAvailableCursor: NonNegativeInteger,
  droppedBytes: NonNegativeInteger,
  state: BackgroundTaskStateSchema,
});
const BackgroundTaskWaitSchema = Schema.Struct({
  id: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(BACKGROUND_TASK_CODE_MODE_BOUNDS.maxIdChars),
  ),
  outcome: Schema.Literals(["matched", "completed", "timeout"]),
  snapshot: BackgroundTaskSnapshotSchema,
  nextCursor: NonNegativeInteger,
  earliestAvailableCursor: NonNegativeInteger,
  droppedBytes: NonNegativeInteger,
  matchCursor: Schema.optionalKey(NonNegativeInteger),
});
const BoundedText = Schema.String.check(
  Schema.isMaxLength(BACKGROUND_TASK_CODE_MODE_BOUNDS.maxTextChars),
);

/** Exact v1 input contract accepted by the Background Tasks provider. */
export const BackgroundTaskCodeModeInputSchema = Schema.Struct({
  action: Schema.Literals(["start", "list", "status", "logs", "wait", "stop", "stop_all", "clear"]),
  command: Schema.optionalKey(
    Schema.String.check(Schema.isMaxLength(BACKGROUND_TASK_CODE_MODE_BOUNDS.maxCommandChars)),
  ),
  cwd: Schema.optionalKey(
    Schema.String.check(Schema.isMaxLength(BACKGROUND_TASK_CODE_MODE_BOUNDS.maxPathChars)),
  ),
  name: Schema.optionalKey(
    Schema.String.check(Schema.isMaxLength(BACKGROUND_TASK_CODE_MODE_BOUNDS.maxNameChars)),
  ),
  timeoutSeconds: Schema.optionalKey(PositiveFinite),
  id: Schema.optionalKey(
    Schema.String.check(Schema.isMaxLength(BACKGROUND_TASK_CODE_MODE_BOUNDS.maxIdChars)),
  ),
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
      Schema.isMaxLength(BACKGROUND_TASK_CODE_MODE_BOUNDS.maxContainsChars),
    ).annotate({
      description: 'Literal text required for until="output"; invalid for until="exit".',
    }),
  ),
  afterCursor: Schema.optionalKey(
    NonNegativeInteger.annotate({
      description: 'Read logs or match output after this cursor; invalid for until="exit".',
    }),
  ),
  tailLines: Schema.optionalKey(
    NonNegativeInteger.check(
      Schema.isBetween({
        minimum: 1,
        maximum: BACKGROUND_TASK_CODE_MODE_BOUNDS.maxTailLines,
      }),
    ),
  ),
  waitSeconds: Schema.optionalKey(
    Schema.Finite.check(
      Schema.isBetween({
        minimum: 0,
        maximum: BACKGROUND_TASK_CODE_MODE_BOUNDS.maxWaitSeconds,
      }),
    ),
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
    tasks: Schema.Array(BackgroundTaskSnapshotSchema).check(
      Schema.isMaxLength(BACKGROUND_TASK_CODE_MODE_BOUNDS.maxSnapshots),
    ),
  }),
  Schema.Struct({
    action: Schema.Literal("logs"),
    text: BoundedText,
    logs: BackgroundTaskCodeModeLogMetadataSchema,
  }),
  Schema.Struct({
    action: Schema.Literal("wait"),
    text: BoundedText,
    wait: BackgroundTaskWaitSchema,
  }),
  Schema.Struct({
    action: Schema.Literal("clear"),
    text: BoundedText,
    removed: NonNegativeInteger,
  }),
]);

export type BackgroundTaskCodeModeInput = typeof BackgroundTaskCodeModeInputSchema.Type;
export type BackgroundTaskCodeModeLogMetadata = typeof BackgroundTaskCodeModeLogMetadataSchema.Type;
export type BackgroundTaskCodeModeOutput = typeof BackgroundTaskCodeModeOutputSchema.Type;

export interface BackgroundTaskCodeModeCapability {
  readonly version: typeof BACKGROUND_TASK_CODE_MODE_VERSION;
  readonly sessionId: string;
  readonly presentationVersion?: 1;
  readonly execute: (
    callId: string,
    input: BackgroundTaskCodeModeInput,
    signal: AbortSignal,
    maxOutputBytes: number,
    observePresentation?: BackgroundTaskPresentationObserver,
  ) => Promise<BackgroundTaskCodeModeOutput>;
}

export interface BackgroundTaskCodeModeQuery {
  readonly version: typeof BACKGROUND_TASK_CODE_MODE_VERSION;
  readonly sessionId: string;
  readonly respond: <Candidate>(candidate: Candidate) => void;
}

const BoundedSessionId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(BACKGROUND_TASK_CODE_MODE_BOUNDS.maxSessionIdChars),
);
const QuerySchema = Schema.Struct({
  version: Schema.Literal(BACKGROUND_TASK_CODE_MODE_VERSION),
  sessionId: BoundedSessionId,
  respond: Schema.Unknown,
});
const CapabilitySchema = Schema.Struct({
  version: Schema.Literal(BACKGROUND_TASK_CODE_MODE_VERSION),
  sessionId: BoundedSessionId,
  execute: Schema.Unknown,
});

const decodeSafely = <S extends Schema.ConstraintDecoder<unknown>, Value>(
  schema: S,
  value: Value,
): S["Type"] | undefined => {
  try {
    return Option.getOrUndefined(Schema.decodeUnknownOption(schema)(value));
  } catch {
    return undefined;
  }
};

const containThenable = <Value>(value: Value): void => {
  try {
    if (!Predicate.isObjectOrArray(value) && !Predicate.isFunction(value)) return;
    // SAFETY: The value is narrowed to an object or function before the optional then field is read.
    const then = (value as { readonly then?: unknown }).then;
    if (!Predicate.isFunction(then)) return;
    then.call(
      value,
      () => undefined,
      () => undefined,
    );
  } catch {
    // A response callback cannot escape this best-effort protocol boundary.
  }
};

/** Reads a hostile event payload once and retains only the checked response capability. */
export const normalizeBackgroundTaskCodeModeQuery = <Value>(
  value: Value,
): BackgroundTaskCodeModeQuery | undefined => {
  const decoded = decodeSafely(QuerySchema, value);
  if (!decoded || !Predicate.isFunction(decoded.respond)) return undefined;
  const respond = decoded.respond;
  return Object.freeze({
    version: decoded.version,
    sessionId: decoded.sessionId,
    respond: <Candidate>(candidate: Candidate): void => {
      try {
        const outcome: unknown = respond(candidate);
        containThenable(outcome);
      } catch {
        // A response callback cannot escape this best-effort protocol boundary.
      }
    },
  });
};

/** Reads a hostile provider response once and retains only the checked execution capability. */
export const normalizeBackgroundTaskCodeModeCapability = <Value>(
  value: Value,
): BackgroundTaskCodeModeCapability | undefined => {
  const decoded = decodeSafely(CapabilitySchema, value);
  if (!decoded || !Predicate.isFunction(decoded.execute)) return undefined;
  const execute = decoded.execute;
  let presentationVersion: 1 | undefined;
  try {
    const field = Object.getOwnPropertyDescriptor(value, "presentationVersion");
    if (field && "value" in field && field.value === 1) presentationVersion = 1;
  } catch {
    /* Optional observation is unavailable. */
  }
  return Object.freeze({
    version: decoded.version,
    sessionId: decoded.sessionId,
    ...(presentationVersion === 1 && { presentationVersion }),
    execute: (
      callId: string,
      input: BackgroundTaskCodeModeInput,
      signal: AbortSignal,
      maxOutputBytes: number,
      observePresentation?: BackgroundTaskPresentationObserver,
    ) =>
      presentationVersion === 1 && observePresentation
        ? execute(callId, input, signal, maxOutputBytes, <Value>(value: Value) => {
            const receipt = normalizeBackgroundTaskPresentation(value);
            if (receipt) observeBackgroundTaskPresentation(observePresentation, receipt);
          })
        : execute(callId, input, signal, maxOutputBytes),
  });
};
