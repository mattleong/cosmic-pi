import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Str from "effect/String";
import * as Rec from "effect/Record";
import { normalizeShellCommandWhitespace } from "../tools/shell-command";

const BASH_WARNINGS = {
  "Deletes files recursively":
    /(?<![\w-])rm(?=\s)(?=[^;&|]*\s(?:-[a-z]*r[a-z]*|--recursive)(?=$|[\s;&|]))(?=[^;&|]*\s(?:-[a-z]*f[a-z]*|--force)(?=$|[\s;&|]))/i,
  "Runs with elevated privileges": /(^|[;&|]\s*)sudo\b/,
  "Changes permissions recursively": /\bchmod\s+(?:-[\w-]*R|--recursive)\b/,
  "Changes ownership recursively": /\bchown\s+(?:-[\w-]*R|--recursive)\b/,
  "Discards uncommitted git changes": /\bgit\s+reset\s+--hard\b/,
  "Removes untracked files":
    /\bgit\s+clean(?=\s)(?![^;&|]*\s(?:-[a-zA-Z]*n[a-zA-Z]*|--dry-run)(?=$|[\s;&|]))(?=[^;&|]*\s(?:-[a-zA-Z]*[fd][a-zA-Z]*|--force)(?=$|[\s;&|]))/,
  "Removes Docker data": /\bdocker\s+system\s+prune\b/,
  "Writes to a system path":
    />{1,2}\s*["']?\/(?:etc|bin|sbin|usr|var|System|Library)(?=$|[/\s"';&|)])/,
};

export function getBashWarnings(command: string): string[] {
  const compact = normalizeShellCommandWhitespace(
    Fn.pipe(command, Str.replace(/\\\n/g, " "), Str.replace(/\n/g, ";")),
  );
  return Arr.map(
    Arr.filter(Rec.toEntries(BASH_WARNINGS), ([, pattern]) => pattern.test(compact)),
    ([label]) => label,
  );
}
