// Node hashing is intentionally isolated at this deterministic platform boundary.
// @effect-diagnostics effect/nodeBuiltinImport:off
import { createHash } from "node:crypto";

const MAX_SLUG_CHARS = 48;
const HASH_CHARS = 12;

export function readableDirectorySlug(basename: string): string {
  const normalized = basename
    .normalize("NFKC")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "")
    .slice(0, MAX_SLUG_CHARS)
    .replace(/[-._]+$/g, "");
  return normalized || "directory";
}

export function shortPathHash(canonicalCwd: string): string {
  return createHash("sha256").update(canonicalCwd).digest("hex").slice(0, HASH_CHARS);
}

export function preferenceFilename(canonicalCwd: string, basename: string): string {
  return `${readableDirectorySlug(basename)}--${shortPathHash(canonicalCwd)}.json`;
}
