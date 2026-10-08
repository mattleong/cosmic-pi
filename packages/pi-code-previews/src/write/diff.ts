import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { codePreviewPerformanceConfig } from "../config/state";
import { formatBytes } from "pi-cosmic-core";

const PreviewByteLength = Schema.Natural;
const SkippedExistingFilePreview = Schema.Struct({
  kind: Schema.Literal("skipped"),
  reason: Schema.String,
  byteLength: Schema.optional(PreviewByteLength),
  maxBytes: PreviewByteLength,
  sizeExceeded: Schema.optional(Schema.Boolean),
});
type SkippedExistingFile = typeof SkippedExistingFilePreview.Type;
export type ExistingFilePreview = { kind: "content"; content: string } | SkippedExistingFile;
const decodeSkippedExistingFilePreview = Schema.decodeUnknownOption(SkippedExistingFilePreview, {
  onExcessProperty: "error",
});

const currentMaxWriteDiffBytes = () => codePreviewPerformanceConfig.maxWriteDiffBytes;
const currentMaxChangedLineCells = () => codePreviewPerformanceConfig.maxWriteDiffChangedLineCells;
// Pi writes content verbatim, so a leading byte order mark is part of the previous text.
const utf8 = new TextDecoder("utf-8", { ignoreBOM: true });

/**
 * Reads an already resolved path. Resolving Pi's write target again would also rewrite Unicode
 * spaces in the working directory, which Pi's own resolution keeps.
 */
export const readExistingFileForPreviewEffect = Effect.fn("CodePreviewWrite.readExisting")(
  function* (absolutePath: string, nextContent: string) {
    const nextBytes = Buffer.byteLength(nextContent, "utf8");
    const maxBytes = currentMaxWriteDiffBytes();
    if (nextBytes > maxBytes)
      return skippedExistingFile("new content too large", nextBytes, true, maxBytes);
    const fs = yield* FileSystem.FileSystem;
    return yield* Effect.gen(function* () {
      // Only a regular file is opened: opening a FIFO blocks until a writer arrives.
      const info = yield* fs.stat(absolutePath);
      const size = ByteSize.toBigInt(info.size);
      if (info.type !== "File")
        return skippedExistingFile("previous path is not a regular file", Number(size));
      if (size > BigInt(maxBytes))
        return skippedExistingFile("previous file too large", Number(size), true, maxBytes);
      const file = yield* fs.open(absolutePath, { flag: "r" });
      const bytes = Option.getOrUndefined(yield* file.readAlloc(maxBytes + 1));
      if (!bytes) return { kind: "content", content: "" } as const;
      if (bytes.byteLength > maxBytes)
        return skippedExistingFile("previous file too large", bytes.byteLength, true, maxBytes);
      return { kind: "content", content: utf8.decode(bytes) } as const;
    }).pipe(
      Effect.scoped,
      Effect.catch(() =>
        fs.exists(absolutePath).pipe(
          Effect.orElseSucceed(() => true),
          Effect.map((exists) =>
            exists ? skippedExistingFile("previous content unavailable", undefined) : undefined,
          ),
        ),
      ),
    );
  },
);

export function getWriteDiffSkipReason<BeforeInput>(
  before: BeforeInput,
  nextContent: string,
  maxBytes = currentMaxWriteDiffBytes(),
): string | undefined {
  const decoded = decodeSkippedExistingFilePreview(before);
  if (Option.isNone(decoded)) return undefined;
  const nextBytes = Buffer.byteLength(nextContent, "utf8");
  return formatSkipReason(
    nextBytes > maxBytes
      ? skippedExistingFile("new content too large", nextBytes, true, maxBytes)
      : decoded.value,
  );
}

// A skipped snapshot is a quiet size guard only when its validated measurements
// establish that the previous file exceeded its recorded bound.
export function hasWriteDiffSizeEvidence<BeforeInput>(before: BeforeInput): boolean {
  const decoded = decodeSkippedExistingFilePreview(before);
  if (Option.isNone(decoded)) return false;
  const { reason, sizeExceeded, byteLength, maxBytes } = decoded.value;
  return (
    reason.trim().length > 0 &&
    sizeExceeded === true &&
    byteLength !== undefined &&
    byteLength > maxBytes
  );
}

export function getWriteDiffGuard(
  before: string,
  after: string,
  maxBytes = currentMaxWriteDiffBytes(),
  maxCells = currentMaxChangedLineCells(),
): "size" | "complexity" | undefined {
  // UTF-16 length is a cheap lower bound on UTF-8 bytes; avoid scanning huge inputs.
  if (before.length + after.length > maxBytes || exceedsWriteDiffBytes([before, after], maxBytes))
    return "size";
  if (before !== after && shouldSkipWriteDiffComplexity(before, after, maxCells))
    return "complexity";
  return undefined;
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
): SkippedExistingFile {
  const skipped: SkippedExistingFile = { kind: "skipped", reason, maxBytes, sizeExceeded };
  return byteLength === undefined ? skipped : { ...skipped, byteLength };
}

function formatSkipReason({ reason, byteLength, sizeExceeded, maxBytes }: SkippedExistingFile) {
  if (byteLength === undefined) return reason;
  return `${reason} (${formatBytes(byteLength)}${sizeExceeded ? ` > ${formatBytes(maxBytes)}` : ""})`;
}
