import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { runCodePreviewSessionEffect } from "../application/capability";
import { codePreviewPerformanceConfig } from "../config/env";
import { resolvePreviewPath } from "../paths/resolve";
import { formatBytes } from "../shared/helpers";

export type ExistingFilePreview =
  | { kind: "content"; content: string }
  | {
      kind: "skipped";
      reason: string;
      byteLength?: number;
      maxBytes: number;
      sizeExceeded?: boolean;
    };

const PreviewByteLength = Schema.Natural;
const SkippedExistingFilePreview = Schema.Struct({
  kind: Schema.Literal("skipped"),
  reason: Schema.String,
  byteLength: Schema.optional(PreviewByteLength),
  maxBytes: PreviewByteLength,
  sizeExceeded: Schema.optional(Schema.Boolean),
});

const currentMaxWriteDiffBytes = () => codePreviewPerformanceConfig.maxWriteDiffBytes;
const currentMaxChangedLineCells = () => codePreviewPerformanceConfig.maxWriteDiffChangedLineCells;

export const readExistingFileForPreviewEffect = Effect.fn("CodePreviewWrite.readExisting")(
  function* (path: string, cwd: string, nextContent = "") {
    if (!path) return undefined;
    const resolved = resolvePreviewPath(path, cwd);
    const nextBytes = Buffer.byteLength(nextContent, "utf8");
    const maxBytes = currentMaxWriteDiffBytes();
    if (nextBytes > maxBytes)
      return skippedExistingFile("new content too large", nextBytes, true, maxBytes);
    const fs = yield* FileSystem.FileSystem;
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const file = yield* fs.open(resolved, { flag: "r" });
        const fileStat = yield* file.stat;
        if (fileStat.type !== "File")
          return skippedExistingFile("previous path is not a regular file", Number(fileStat.size));
        if (fileStat.size > BigInt(maxBytes))
          return skippedExistingFile(
            "previous file too large",
            Number(fileStat.size),
            true,
            maxBytes,
          );
        const allocation = yield* file.readAlloc(BigInt(maxBytes + 1));
        const bytes = Option.getOrUndefined(allocation);
        if (!bytes) return { kind: "content", content: "" } as const;
        if (bytes.byteLength > maxBytes)
          return skippedExistingFile("previous file too large", bytes.byteLength, true, maxBytes);
        return {
          kind: "content",
          content: new TextDecoder().decode(bytes),
        } as const;
      }).pipe(
        Effect.catch(() =>
          fs.exists(resolved).pipe(
            Effect.map((exists) =>
              exists ? skippedExistingFile("previous content unavailable", undefined) : undefined,
            ),
            Effect.catch(() =>
              Effect.succeed(skippedExistingFile("previous content unavailable", undefined)),
            ),
          ),
        ),
      ),
    );
  },
);

export function readExistingFileForPreview(
  path: string,
  cwd: string,
  nextContent = "",
): Promise<ExistingFilePreview | undefined> {
  return runCodePreviewSessionEffect(readExistingFileForPreviewEffect(path, cwd, nextContent));
}

export function getWriteDiffSkipReason<BeforeInput>(
  before: BeforeInput,
  nextContent: string,
  maxBytes = currentMaxWriteDiffBytes(),
): string | undefined {
  const decoded = Schema.decodeUnknownOption(SkippedExistingFilePreview, {
    onExcessProperty: "error",
  })(before);
  if (Option.isNone(decoded)) return undefined;
  const nextBytes = Buffer.byteLength(nextContent, "utf8");
  if (nextBytes > maxBytes)
    return formatSkipReason("new content too large", nextBytes, true, maxBytes);
  return formatSkipReason(
    decoded.value.reason,
    decoded.value.byteLength,
    decoded.value.sizeExceeded === true,
    decoded.value.maxBytes,
  );
}

export function shouldSkipWriteDiffBytes(...texts: string[]): boolean {
  return exceedsWriteDiffBytes(texts, currentMaxWriteDiffBytes());
}

export function exceedsWriteDiffBytes(texts: readonly string[], maxBytes: number): boolean {
  let total = 0;
  for (const text of texts) {
    total += Buffer.byteLength(text, "utf8");
    if (total > maxBytes) return true;
  }
  return false;
}

export function shouldSkipWriteDiffComplexity(
  before: string,
  after: string,
  maxCells = currentMaxChangedLineCells(),
): boolean {
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  const sharedLimit = Math.min(beforeLines.length, afterLines.length);
  let prefix = 0;
  while (prefix < sharedLimit && beforeLines[prefix] === afterLines[prefix]) prefix++;
  let suffix = 0;
  const suffixLimit = sharedLimit - prefix;
  while (
    suffix < suffixLimit &&
    beforeLines[beforeLines.length - suffix - 1] === afterLines[afterLines.length - suffix - 1]
  )
    suffix++;
  const changedBefore = beforeLines.length - prefix - suffix;
  const changedAfter = afterLines.length - prefix - suffix;
  return changedBefore * changedAfter > maxCells;
}

function skippedExistingFile(
  reason: string,
  byteLength: number | undefined,
  sizeExceeded = false,
  maxBytes = currentMaxWriteDiffBytes(),
): ExistingFilePreview {
  const skipped: ExistingFilePreview = { kind: "skipped", reason, maxBytes, sizeExceeded };
  return byteLength === undefined ? skipped : { ...skipped, byteLength };
}

function formatSkipReason(
  reason: string,
  byteLength: number | undefined,
  sizeExceeded: boolean,
  maxBytes = currentMaxWriteDiffBytes(),
): string {
  if (byteLength === undefined) return reason;
  if (!sizeExceeded) return `${reason} (${formatBytes(byteLength)})`;
  return `${reason} (${formatBytes(byteLength)} > ${formatBytes(maxBytes)})`;
}
