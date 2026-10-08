import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import {
  captureCodePreviewSessionCapability,
  rejectInactiveCodePreviewSession,
} from "../application/capability";
import { executeNativeWrite } from "../boundary/host-write";
import { getObjectValue } from "../shared/helpers";
import { readExistingFileForPreviewEffect, type ExistingFilePreview } from "./diff";
import { lookupBeforeWrite, type CodePreviewBeforeWrite } from "./projection";
import { CodePreviewWriteService } from "./service";

const CODE_PREVIEW_BEFORE_WRITE_DETAIL = "codePreviewBeforeWrite";
type RedactedCodePreviewBeforeWrite =
  | Exclude<ExistingFilePreview, { kind: "content" }>
  | { kind: "content"; byteLength: number }
  | undefined;
/** Pi reads only the message of a rejected tool call. */
class CodePreviewWriteError extends Schema.TaggedError<CodePreviewWriteError>()(
  "CodePreviewWriteError",
  { message: Schema.String },
) {}

export function getCodePreviewBeforeWrite<DetailsInput>(
  toolCallId: string | undefined,
  details: DetailsInput,
) {
  if (toolCallId) {
    const before = lookupBeforeWrite(toolCallId);
    if (before !== undefined) return before;
  }
  return getObjectValue(details, CODE_PREVIEW_BEFORE_WRITE_DETAIL);
}

/** Only an own data property with explicit undefined records an observed absent file.
 * JSON replay drops that property, so missing history must remain unknown.
 */
export function isKnownNewWrite<Before, Details>(before: Before, details: Details): boolean {
  if (before !== undefined || !Predicate.isObjectOrArray(details)) return false;
  try {
    const field = Object.getOwnPropertyDescriptor(details, CODE_PREVIEW_BEFORE_WRITE_DETAIL);
    return field !== undefined && "value" in field && field.value === undefined;
  } catch {
    return false;
  }
}

export const executeWriteWithPreviewEffect = Effect.fn("CodePreviewWrite.execute")(function* (
  toolCallId: string,
  path: string,
  content: string,
  cwd: string,
  ctx?: ExtensionToolContext,
) {
  const writeService = yield* CodePreviewWriteService;
  const fs = yield* FileSystem.FileSystem;
  let before: CodePreviewBeforeWrite;
  // Pi reports the error its own write would: the agent reads it and failures are classified by it.
  const failure = <Cause>(cause: Cause) =>
    cause instanceof CodePreviewWriteError
      ? cause
      : new CodePreviewWriteError({ message: nativeErrorMessage(cause) });
  const result = yield* executeNativeWrite(
    toolCallId,
    path,
    content,
    cwd,
    {
      mkdir: (directory) =>
        fs
          .makeDirectory(directory, { recursive: true })
          .pipe(Effect.uninterruptible, Effect.mapError(failure)),
      writeFile: (target, next, signal) =>
        Effect.gen(function* () {
          // Pi already holds the canonical mutation queue. Read only after admission.
          before = yield* readExistingFileForPreviewEffect(target, next);
          yield* Effect.uninterruptible(
            Effect.gen(function* () {
              if (signal.aborted) return yield* Effect.interrupt;
              // Direct truncation retains native symlink, inode, hard-link and mode semantics.
              yield* fs.writeFileString(target, next);
              // Commit evidence before Pi observes cancellation after writeFile settles.
              yield* writeService.rememberBeforeWrite(toolCallId, before);
            }),
          );
        }).pipe(Effect.mapError(failure)),
    },
    failure,
    ctx,
  );
  return { ...result, details: { codePreviewBeforeWrite: redactedBeforeWriteDetail(before) } };
});

export function executeWriteWithPreview(
  toolCallId: string,
  path: string,
  content: string,
  cwd: string,
  signal: AbortSignal | undefined,
  ctx?: ExtensionToolContext,
) {
  const owner = captureCodePreviewSessionCapability();
  if (!owner) return rejectInactiveCodePreviewSession("write");
  // One native queue only: wrapping native execute in another queue deadlocks.
  // The captured runtime owns its wait and every admitted operation callback.
  return owner.run(executeWriteWithPreviewEffect(toolCallId, path, content, cwd, ctx), signal);
}

/** The Node error Pi's default operations would throw, which Effect's platform error wraps. */
function nativeErrorMessage<Failure>(error: Failure): string {
  const source =
    error instanceof PlatformError.PlatformError && "cause" in error.reason
      ? error.reason.cause
      : error;
  return source instanceof Error ? source.message : String(source);
}

/** Result details keep the previous content's size, not the content itself. */
function redactedBeforeWriteDetail(before: CodePreviewBeforeWrite): RedactedCodePreviewBeforeWrite {
  if (!before || before.kind !== "content") return before;
  return { kind: "content", byteLength: Buffer.byteLength(before.content, "utf8") };
}
