import * as Fn from "effect/Function";
import * as Str from "effect/String";
import { sha256Text } from "pi-cosmic-core/security/sha256";

const MAX_SLUG_CHARS = 48;
const HASH_CHARS = 12;

function readableDirectorySlug(basename: string): string {
  const normalized = Fn.pipe(
    basename,
    Str.normalize("NFKC"),
    Str.replace(/[^A-Za-z0-9._-]+/g, "-"),
    Str.replace(/^[-._]+|[-._]+$/g, ""),
    Str.slice(0, MAX_SLUG_CHARS),
    Str.replace(/[-._]+$/g, ""),
  );
  return normalized || "directory";
}

export function preferenceFilename(canonicalCwd: string, basename: string): string {
  return `${readableDirectorySlug(basename)}--${Fn.pipe(sha256Text(canonicalCwd), Str.slice(0, HASH_CHARS))}.json`;
}
