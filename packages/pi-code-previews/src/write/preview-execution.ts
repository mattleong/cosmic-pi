import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as MutableRef from "effect/MutableRef";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { runPlatformEffect } from "../boundary/platform";
import { resolvePreviewPath } from "../paths/resolve";
import { getObjectValue } from "../shared/objects";
import { readExistingFileForPreviewEffect, type ExistingFilePreview } from "./diff";

const CODE_PREVIEW_BEFORE_WRITE_DETAIL = "codePreviewBeforeWrite";
const MAX_BEFORE_WRITE_CACHE_ENTRIES = 64;
export type CodePreviewBeforeWrite = ExistingFilePreview | undefined;
type RedactedCodePreviewBeforeWrite =
  | Exclude<ExistingFilePreview, { kind: "content" }>
  | { kind: "content"; byteLength: number }
  | undefined;
export type CodePreviewBeforeWriteDetails = {
  codePreviewBeforeWrite: RedactedCodePreviewBeforeWrite;
};

export class CodePreviewWriteError extends Schema.TaggedErrorClass<CodePreviewWriteError>()(
  "CodePreviewWriteError",
  { operation: Schema.String, path: Schema.String, message: Schema.String },
) {}

const beforeWriteCache = new Map<string, CodePreviewBeforeWrite>();
type PathLock = { readonly semaphore: Semaphore.Semaphore; users: number };
const pathLocks = MutableRef.make(new Map<string, PathLock>());

const acquirePathLock = (path: string): PathLock => {
  const locks = MutableRef.get(pathLocks);
  const existing = locks.get(path);
  if (existing) {
    existing.users++;
    return existing;
  }
  const created = { semaphore: Semaphore.makeUnsafe(1), users: 1 };
  locks.set(path, created);
  return created;
};

const releasePathLock = (path: string, lock: PathLock): void => {
  lock.users--;
  const locks = MutableRef.get(pathLocks);
  if (lock.users === 0 && locks.get(path) === lock) locks.delete(path);
};

export function getCodePreviewBeforeWrite(
  toolCallId: string | undefined,
  details: unknown,
): unknown {
  if (toolCallId && beforeWriteCache.has(toolCallId)) {
    const before = beforeWriteCache.get(toolCallId);
    beforeWriteCache.delete(toolCallId);
    return before;
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
  const lock = acquirePathLock(absolutePath);
  return yield* lock.semaphore
    .withPermits(1)(
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
        rememberCodePreviewBeforeWrite(toolCallId, before);
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
    )
    .pipe(Effect.ensuring(Effect.sync(() => releasePathLock(absolutePath, lock))));
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
    runPlatformEffect(executeWriteWithPreviewEffect(toolCallId, path, content, cwd), signal),
  );
}

function rememberCodePreviewBeforeWrite(toolCallId: string, before: CodePreviewBeforeWrite): void {
  beforeWriteCache.delete(toolCallId);
  if (before !== undefined) beforeWriteCache.set(toolCallId, before);
  while (beforeWriteCache.size > MAX_BEFORE_WRITE_CACHE_ENTRIES) {
    const oldest = beforeWriteCache.keys().next().value;
    if (oldest === undefined) break;
    beforeWriteCache.delete(oldest);
  }
}
function redactedBeforeWriteDetail(before: CodePreviewBeforeWrite): RedactedCodePreviewBeforeWrite {
  if (!before || before.kind !== "content") return before;
  return { kind: "content", byteLength: Buffer.byteLength(before.content, "utf8") };
}
export function withCodePreviewBeforeWrite<T extends { details?: unknown }>(
  result: T,
  before: CodePreviewBeforeWrite,
  toolCallId?: string,
): T & { details: Record<string, unknown> } {
  if (toolCallId) rememberCodePreviewBeforeWrite(toolCallId, before);
  const details = result.details && typeof result.details === "object" ? result.details : {};
  return {
    ...result,
    details: { ...details, [CODE_PREVIEW_BEFORE_WRITE_DETAIL]: redactedBeforeWriteDetail(before) },
  };
}
