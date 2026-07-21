import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ProcessCoordinator } from "pi-cosmic-core";
import { advisorIsoNow } from "./boundary/clock.ts";
import { stringifyJson } from "./boundary/json.ts";
import { appendRotatingTextSync, nodeDirname, nodeJoin } from "./boundary/node.ts";
import { standaloneAdvisorExecutor } from "./boundary/executor.ts";
import { snapshotDataRecord } from "./boundary/safe-data.ts";
import { safeAdvisorLabel } from "./advisor-label.ts";
import { redactSensitiveText } from "./observation-protocol.ts";

const MAX_LOG_BYTES = 1_000_000;
const MAX_ERROR_MESSAGE_CHARS = 4_000;
const MAX_ERROR_STACK_CHARS = 16_000;
const SerializedErrorSchema = Schema.Struct({
  name: Schema.String,
  message: Schema.String,
  stack: Schema.optional(Schema.String),
});
const FailureRecordSchema = Schema.Struct({
  timestamp: Schema.String,
  provider: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  timeoutMs: Schema.Number,
  contextChars: Schema.Number,
  durationMs: Schema.Number,
  error: SerializedErrorSchema,
});
const FailureRecordJson = Schema.fromJsonString(FailureRecordSchema);

export interface AdvisorFailureDetails {
  contextChars: number;
  durationMs: number;
  error: unknown;
  model?: string | undefined;
  provider?: string | undefined;
  timeoutMs: number;
}
export function getAdvisorFailureLogPath(configPath: string): string {
  return nodeJoin(nodeDirname(nodeDirname(configPath)), "logs", "pi-advisor.jsonl");
}

export const logAdvisorFailureEffect = Effect.fn("AdvisorFailureLog.append")(function* (
  configPath: string,
  details: AdvisorFailureDetails,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const coordinator = yield* ProcessCoordinator;
  const logPath = path.join(path.dirname(path.dirname(configPath)), "logs", "pi-advisor.jsonl");
  return yield* coordinator
    .withLock(
      path.resolve(logPath),
      Effect.gen(function* () {
        const logDirectory = path.dirname(logPath);
        yield* fs.makeDirectory(logDirectory, { recursive: true, mode: 0o700 });
        yield* fs.chmod(logDirectory, 0o700);
        if (yield* fs.exists(logPath)) {
          const info = yield* fs.stat(logPath);
          if (info.size >= BigInt(MAX_LOG_BYTES)) {
            const previous = `${logPath}.1`;
            yield* fs.remove(previous).pipe(Effect.catch(() => Effect.void));
            yield* fs.rename(logPath, previous);
            yield* fs.chmod(previous, 0o600);
          }
        }
        const now = yield* Clock.currentTimeMillis;
        const provider = safeAdvisorLabel(details.provider);
        const model = safeAdvisorLabel(details.model);
        const record = {
          timestamp: DateTime.formatIso(DateTime.makeUnsafe(now)),
          ...(provider ? { provider } : {}),
          ...(model ? { model } : {}),
          timeoutMs: details.timeoutMs,
          contextChars: details.contextChars,
          durationMs: Math.round(details.durationMs),
          error: serializeError(details.error),
        };
        const line = yield* Schema.encodeUnknownEffect(FailureRecordJson)(record);
        yield* fs.writeFileString(logPath, `${line}\n`, { flag: "a", mode: 0o600 });
        yield* fs.chmod(logPath, 0o600);
        return logPath;
      }),
    )
    .pipe(Effect.catch(() => Effect.sync((): undefined => undefined)));
});

export function logAdvisorFailure(
  configPath: string,
  details: AdvisorFailureDetails,
): string | undefined {
  const logPath = getAdvisorFailureLogPath(configPath);
  const provider = safeAdvisorLabel(details.provider);
  const model = safeAdvisorLabel(details.model);
  const record = {
    timestamp: advisorIsoNow(standaloneAdvisorExecutor),
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    timeoutMs: details.timeoutMs,
    contextChars: details.contextChars,
    durationMs: Math.round(details.durationMs),
    error: serializeError(details.error),
  };
  return appendRotatingTextSync(logPath, `${stringifyJson(record)}\n`, MAX_LOG_BYTES)
    ? logPath
    : undefined;
}

export function logAdvisorFailureAsync(
  configPath: string,
  details: AdvisorFailureDetails,
): Promise<string | undefined> {
  return standaloneAdvisorExecutor.run(logAdvisorFailureEffect(configPath, details));
}
function serializeError(error: unknown): { name: string; message: string; stack?: string } {
  if (typeof error !== "object" || error === null) {
    const primitive =
      typeof error === "string" || typeof error === "number" || typeof error === "boolean"
        ? String(error)
        : "Unknown error.";
    return {
      name: "UnknownError",
      message: clip(redactSensitiveText(primitive), MAX_ERROR_MESSAGE_CHARS),
    };
  }
  const snapshot = snapshotDataRecord(error);
  const name = typeof snapshot?.name === "string" ? snapshot.name : "Error";
  const message = typeof snapshot?.message === "string" ? snapshot.message : "Unknown error.";
  const stack = typeof snapshot?.stack === "string" ? snapshot.stack : undefined;
  return {
    name: clip(redactSensitiveText(name), MAX_ERROR_MESSAGE_CHARS),
    message: clip(redactSensitiveText(message), MAX_ERROR_MESSAGE_CHARS),
    ...(stack ? { stack: clip(redactSensitiveText(stack), MAX_ERROR_STACK_CHARS) } : {}),
  };
}
function clip(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}…`;
}
