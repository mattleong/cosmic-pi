import * as Predicate from "effect/Predicate";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { hasObjectRuntimeType } from "pi-cosmic-core";
import type {
  BackgroundLogSlice,
  BackgroundTaskSnapshot,
  BackgroundTaskWaitResult,
} from "../task/model.ts";
import type { BackgroundTaskToolInput } from "../tools/schema.ts";

export const BACKGROUND_TASK_CODE_MODE_VERSION = 1 as const;
export const BACKGROUND_TASK_CODE_MODE_QUERY = "pi-background-task:v1:code-mode:query";

export type BackgroundTaskCodeModeLogMetadata = Omit<BackgroundLogSlice, "events">;

/** Detached plain result returned to one Code Mode program. */
export type BackgroundTaskCodeModeOutput =
  | {
      readonly action: "start" | "status" | "stop";
      readonly text: string;
      readonly snapshot: BackgroundTaskSnapshot;
    }
  | {
      readonly action: "list" | "stop_all";
      readonly text: string;
      readonly tasks: ReadonlyArray<BackgroundTaskSnapshot>;
    }
  | {
      readonly action: "logs";
      readonly text: string;
      readonly logs: BackgroundTaskCodeModeLogMetadata;
    }
  | {
      readonly action: "wait";
      readonly text: string;
      readonly wait: BackgroundTaskWaitResult;
    }
  | {
      readonly action: "clear";
      readonly text: string;
      readonly removed: number;
    };

export interface BackgroundTaskCodeModeCapability {
  readonly version: typeof BACKGROUND_TASK_CODE_MODE_VERSION;
  readonly sessionId: string;
  readonly execute: (
    callId: string,
    input: BackgroundTaskToolInput,
    signal: AbortSignal,
    maxOutputBytes: number,
  ) => Promise<BackgroundTaskCodeModeOutput>;
}

export interface BackgroundTaskCodeModeQuery {
  readonly version: typeof BACKGROUND_TASK_CODE_MODE_VERSION;
  readonly sessionId: string;
  readonly respond: <Candidate>(candidate: Candidate) => void;
}

const NonEmptyString = Schema.String.check(Schema.isNonEmpty());
const QuerySchema = Schema.Struct({
  version: Schema.Literal(BACKGROUND_TASK_CODE_MODE_VERSION),
  sessionId: NonEmptyString,
  respond: Schema.Unknown,
});
const CapabilitySchema = Schema.Struct({
  version: Schema.Literal(BACKGROUND_TASK_CODE_MODE_VERSION),
  sessionId: NonEmptyString,
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
    if ((!hasObjectRuntimeType(value) && !Predicate.isFunction(value)) || value === null) return;
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
  return Object.freeze({
    version: decoded.version,
    sessionId: decoded.sessionId,
    execute: (
      callId: string,
      input: BackgroundTaskToolInput,
      signal: AbortSignal,
      maxOutputBytes: number,
    ) => execute(callId, input, signal, maxOutputBytes),
  });
};
