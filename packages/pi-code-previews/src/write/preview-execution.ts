import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import {
  hasCodePreviewSessionCapability,
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

export function getCodePreviewBeforeWrite(
  toolCallId: string | undefined,
  details: unknown,
): unknown {
  if (toolCallId) {
    const before = lookupBeforeWrite(toolCallId);
    if (before !== undefined) return before;
  }
  return getObjectValue(details, CODE_PREVIEW_BEFORE_WRITE_DETAIL);
}

export const executeWriteWithPreviewEffect = Effect.fn("CodePreviewWrite.execute")(function* (
  toolCallId: string,
  path: string,
  content: string,
  cwd: string,
) {
  const absolutePath = resolvePreviewPath(path, cwd);
  const writeService = yield* CodePreviewWriteService;
  return yield* writeService.withPathLock(
    absolutePath,
    Effect.gen(function* () {
      const before = yield* readExistingFileForPreviewEffect(path, cwd, content);
      const fs = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      yield* Effect.uninterruptible(
        Effect.gen(function* () {
          // Match Pi's write semantics: only create the requested path's parent.
          // A dangling link whose target parent is absent must still fail.
          yield* fs.makeDirectory(pathService.dirname(absolutePath), { recursive: true });
          // Delegate symlink traversal to the operating system, matching Pi's writeFile
          // semantics even when a relative final link sits below symlinked directories.
          // Direct truncation also preserves hard-link aliases, open descriptors, inode
          // identity, modes, and normal umask-derived creation modes.
          yield* fs.writeFileString(absolutePath, content);
          // Once the mutation commits, publish its correlation before honoring a pending
          // interruption so renderers can always explain the applied write deterministically.
          yield* writeService.rememberBeforeWrite(toolCallId, before);
        }).pipe(
          Effect.mapError(
            () =>
              new CodePreviewWriteError({
                operation: "write",
                path: absolutePath,
                message: `Unable to write ${path}.`,
              }),
          ),
        ),
      );
      return {
        content: [
          {
            type: "text" as const,
            text: `Successfully wrote ${Buffer.byteLength(content, "utf8")} bytes to ${path}`,
          },
        ],
        details: { codePreviewBeforeWrite: redactedBeforeWriteDetail(before) },
      };
    }),
  );
});

export function executeWriteWithPreview(
  toolCallId: string,
  path: string,
  content: string,
  cwd: string,
  signal: AbortSignal | undefined,
) {
  const absolutePath = resolvePreviewPath(path, cwd);
  return withFileMutationQueue(absolutePath, () =>
    runCodePreviewSessionEffect(
      executeWriteWithPreviewEffect(toolCallId, path, content, cwd),
      signal,
    ),
  );
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
    result.details !== null && typeof result.details === "object" ? result.details : {};
  const enriched = {
    ...result,
    details: { ...details, [CODE_PREVIEW_BEFORE_WRITE_DETAIL]: redactedBeforeWriteDetail(before) },
  } as WithCodePreviewWriteDetails<T>;
  if (!toolCallId || !hasCodePreviewSessionCapability()) return Promise.resolve(enriched);
  return runCodePreviewSessionEffect(
    CodePreviewWriteService.use((service) => service.rememberBeforeWrite(toolCallId, before)),
  ).then(() => enriched);
}
