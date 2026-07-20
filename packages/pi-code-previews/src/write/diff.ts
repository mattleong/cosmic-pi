import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import { runPlatformEffect } from "../boundary/platform";
import { codePreviewPerformanceConfig } from "../config/env";
import { resolvePreviewPath } from "../paths/resolve";
import { formatBytes } from "../shared/format";

export type ExistingFilePreview =
  | { kind: "content"; content: string }
  | {
      kind: "skipped";
      reason: string;
      byteLength?: number;
      maxBytes: number;
      sizeExceeded?: boolean;
    };

/** Stable documented defaults retained for public/test compatibility. */
export const MAX_WRITE_DIFF_BYTES = 200_000;
export const MAX_WRITE_DIFF_CHANGED_LINE_CELLS = 1_000_000;
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
  return runPlatformEffect(readExistingFileForPreviewEffect(path, cwd, nextContent));
}

export function getWriteDiffSkipReason(before: unknown, nextContent: string): string | undefined {
  if (!before || typeof before !== "object") return undefined;
  const nextBytes = Buffer.byteLength(nextContent, "utf8");
  if (nextBytes > currentMaxWriteDiffBytes())
    return formatSkipReason("new content too large", nextBytes, true);
  const record = before as Record<string, unknown>;
  if (record.kind !== "skipped") return undefined;
  const reason = typeof record.reason === "string" ? record.reason : "preview unavailable";
  const byteLength = typeof record.byteLength === "number" ? record.byteLength : undefined;
  const maxBytes =
    typeof record.maxBytes === "number" ? record.maxBytes : currentMaxWriteDiffBytes();
  const sizeExceeded = record.sizeExceeded === true;
  return formatSkipReason(reason, byteLength, sizeExceeded, maxBytes);
}

export function shouldSkipWriteDiffBytes(...texts: string[]): boolean {
  let total = 0;
  for (const text of texts) {
    total += Buffer.byteLength(text, "utf8");
    if (total > currentMaxWriteDiffBytes()) return true;
  }
  return false;
}

export function shouldSkipWriteDiffComplexity(before: string, after: string): boolean {
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
  return changedBefore * changedAfter > currentMaxChangedLineCells();
}

function skippedExistingFile(
  reason: string,
  byteLength: number | undefined,
  sizeExceeded = false,
  maxBytes = currentMaxWriteDiffBytes(),
): ExistingFilePreview {
  return {
    kind: "skipped",
    reason,
    ...(byteLength === undefined ? {} : { byteLength }),
    maxBytes,
    sizeExceeded,
  };
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
