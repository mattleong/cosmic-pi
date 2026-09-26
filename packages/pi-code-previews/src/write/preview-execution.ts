import { hasObjectRuntimeType } from "pi-cosmic-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { executeNativeWrite } from "../boundary/host-write";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import {
  captureCodePreviewSessionCapability,
  hasCodePreviewSessionCapability,
  rejectInactiveCodePreviewSession,
  runCodePreviewSessionEffect,
} from "../application/capability";
import { resolvePreviewPath } from "../paths/resolve";
import { getObjectValue } from "../shared/helpers";
import { readExistingFileForPreviewEffect, type ExistingFilePreview } from "./diff";
import { lookupBeforeWrite } from "./projection";
import { CodePreviewWriteService } from "./service";

const CODE_PREVIEW_BEFORE_WRITE_DETAIL = "codePreviewBeforeWrite";
export type CodePreviewBeforeWrite = ExistingFilePreview | undefined;
type RedactedCodePreviewBeforeWrite =
  | Exclude<ExistingFilePreview, { kind: "content" }>
  | { kind: "content"; byteLength: number }
  | undefined;
export interface CodePreviewWriteDetails {
  readonly codePreviewBeforeWrite: RedactedCodePreviewBeforeWrite;
}
type WithCodePreviewWriteDetails<T extends { details?: unknown }> = Omit<T, "details"> & {
  readonly details: T["details"] extends object
    ? T["details"] & CodePreviewWriteDetails
    : CodePreviewWriteDetails;
};
export class CodePreviewWriteError extends Schema.TaggedError<CodePreviewWriteError>()(
  "CodePreviewWriteError",
  { operation: Schema.String, path: Schema.String, message: Schema.String },
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
  if (before !== undefined || details === null || !hasObjectRuntimeType(details)) return false;
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
  ctx?: ExtensionContext,
) {
  const executionCwd = ctx?.cwd || cwd;
  const absolutePath = resolvePreviewPath(path, executionCwd);
  const writeService = yield* CodePreviewWriteService;
  const fs = yield* FileSystem.FileSystem;
  let before: CodePreviewBeforeWrite;
  const failure = () =>
    new CodePreviewWriteError({
      operation: "write",
      path: absolutePath,
      message: `Unable to write ${path}.`,
    });
  const result = yield* executeNativeWrite(
    toolCallId,
    path,
    content,
    executionCwd,
    {
      mkdir: (directory) =>
        fs
          .makeDirectory(directory, { recursive: true })
          .pipe(Effect.uninterruptible, Effect.mapError(failure)),
      writeFile: (target, next, signal) =>
        Effect.gen(function* () {
          // Pi already holds the canonical mutation queue. Read only after admission.
          before = yield* readExistingFileForPreviewEffect(target, executionCwd, next);
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
  ctx?: ExtensionContext,
) {
  const owner = captureCodePreviewSessionCapability();
  if (!owner) return rejectInactiveCodePreviewSession("write");
  // One native queue only: wrapping native execute in another queue deadlocks.
  // The captured runtime owns its wait and every admitted operation callback.
  return owner.run(executeWriteWithPreviewEffect(toolCallId, path, content, cwd, ctx), signal);
}

function redactedBeforeWriteDetail(before: CodePreviewBeforeWrite): RedactedCodePreviewBeforeWrite {
  if (!before || before.kind !== "content") return before;
  return { kind: "content", byteLength: Buffer.byteLength(before.content, "utf8") };
}
export function withCodePreviewBeforeWrite<T extends { details?: unknown }>(
  result: T,
  before: CodePreviewBeforeWrite,
  toolCallId?: string,
): Promise<WithCodePreviewWriteDetails<T>> {
  const details: object =
    result.details !== null && hasObjectRuntimeType(result.details) ? result.details : {};
  // SAFETY: The value is constructed by the typed owner on this path and satisfies the asserted domain contract.
  const enriched = {
    ...result,
    details: { ...details, [CODE_PREVIEW_BEFORE_WRITE_DETAIL]: redactedBeforeWriteDetail(before) },
  } as WithCodePreviewWriteDetails<T>;
  if (!toolCallId || !hasCodePreviewSessionCapability()) return Promise.resolve(enriched);
  return runCodePreviewSessionEffect(
    CodePreviewWriteService.use((service) => service.rememberBeforeWrite(toolCallId, before)),
  ).then(() => enriched);
}
