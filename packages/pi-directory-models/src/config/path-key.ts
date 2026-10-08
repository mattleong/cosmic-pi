/** Deterministic, readable preference filenames derived from the canonical working directory. */
import { sha256Text } from "pi-cosmic-core";

const MAX_SLUG_CHARS = 48;
const HASH_CHARS = 12;

function readableDirectorySlug(basename: string): string {
  const normalized = basename
    .normalize("NFKC")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "")
    .slice(0, MAX_SLUG_CHARS)
    .replace(/[-._]+$/g, "");
  return normalized || "directory";
}

export function preferenceFilename(canonicalCwd: string, basename: string): string {
  return `${readableDirectorySlug(basename)}--${sha256Text(canonicalCwd).slice(0, HASH_CHARS)}.json`;
}
