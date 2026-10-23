import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import {
  captureCodePreviewSessionCapability,
  rejectInactiveCodePreviewSession,
} from "../application/capability";
import { executeNativeWrite } from "../boundary/host-write";
import { ownObject, type HostContainer, type HostObject } from "../shared/untrusted-value";
import { readExistingFileForPreviewEffect, type ExistingFilePreview } from "./diff";
import { lookupBeforeWrite, type CodePreviewBeforeWrite } from "./projection";
import { CodePreviewWriteService } from "./service";

const CODE_PREVIEW_BEFORE_WRITE_DETAIL = "codePreviewBeforeWrite";
type RedactedCodePreviewBeforeWrite =
  | Exclude<ExistingFilePreview, { kind: "content" }>
  | { kind: "content"; byteLength: number }
  | undefined;
class CodePreviewWriteError extends Schema.TaggedError<
  CodePreviewWriteError,
  { readonly brand: unique symbol }
>()("CodePreviewWriteError", { message: Schema.String }) {}
const isWriteError = Schema.is(CodePreviewWriteError);

export function getCodePreviewBeforeWrite(
  toolCallId: string | undefined,
  details: HostObject | undefined,
): HostObject | undefined {
  if (toolCallId) {
    const before = lookupBeforeWrite(toolCallId);
    if (before !== undefined) return before;
  }
  return ownObject(details, CODE_PREVIEW_BEFORE_WRITE_DETAIL);
}

export function isKnownNewWrite(
  before: HostObject | undefined,
  details: HostContainer | undefined,
): boolean {
  if (before !== undefined || details === undefined) return false;
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
  const failure = (cause: unknown) =>
    isWriteError(cause) ? cause : new CodePreviewWriteError({ message: nativeErrorMessage(cause) });
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
      writeFile: Effect.fn("CodePreviewWrite.writeFile")(function* (
        target: string,
        next: string,
        signal: AbortSignal,
      ) {
        before = yield* readExistingFileForPreviewEffect(target, next);
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            if (signal.aborted) return yield* Effect.interrupt;
            yield* fs.writeFileString(target, next);
            return yield* writeService.rememberBeforeWrite(toolCallId, before);
          }),
        );
      }, Effect.mapError(failure)),
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
  return owner.run(executeWriteWithPreviewEffect(toolCallId, path, content, cwd, ctx), signal);
}

function nativeErrorMessage(cause: unknown): string {
  const source =
    cause instanceof PlatformError.PlatformError && "cause" in cause.reason
      ? cause.reason.cause
      : cause;
  return source instanceof Error ? source.message : String(source);
}

function redactedBeforeWriteDetail(before: CodePreviewBeforeWrite): RedactedCodePreviewBeforeWrite {
  if (before?.kind !== "content") return before;
  return { kind: "content", byteLength: Buffer.byteLength(before.content, "utf8") };
}
