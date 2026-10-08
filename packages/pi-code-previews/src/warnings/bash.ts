import { normalizeShellCommandWhitespace } from "../tools/shell-command";

/** Option rules need standalone tokens in the same command, so `rm notes-rf.md` is not one. */
const BASH_WARNINGS = {
  // Recursive and forced: -rf, -fr, -r -f, --recursive --force. An option such as docker's --rm
  // is not the command.
  "Deletes files recursively":
    /(?<![\w-])rm(?=\s)(?=[^;&|]*\s(?:-[a-z]*r[a-z]*|--recursive)(?=$|[\s;&|]))(?=[^;&|]*\s(?:-[a-z]*f[a-z]*|--force)(?=$|[\s;&|]))/i,
  "Runs with elevated privileges": /(^|[;&|]\s*)sudo\b/,
  "Changes permissions recursively": /\bchmod\s+(?:-[\w-]*R|--recursive)\b/,
  "Changes ownership recursively": /\bchown\s+(?:-[\w-]*R|--recursive)\b/,
  "Discards uncommitted git changes": /\bgit\s+reset\s+--hard\b/,
  // Forced or directory cleaning in any option position; a dry run (-n, --dry-run) removes nothing.
  "Removes untracked files":
    /\bgit\s+clean(?=\s)(?![^;&|]*\s(?:-[a-zA-Z]*n[a-zA-Z]*|--dry-run)(?=$|[\s;&|]))(?=[^;&|]*\s(?:-[a-zA-Z]*[fd][a-zA-Z]*|--force)(?=$|[\s;&|]))/,
  "Removes Docker data": /\bdocker\s+system\s+prune\b/,
  // Only an absolute system directory; relative paths such as bin/build.log are local.
  "Writes to a system path":
    />{1,2}\s*["']?\/(?:etc|bin|sbin|usr|var|System|Library)(?=$|[/\s"';&|)])/,
};

export function getBashWarnings(command: string): string[] {
  // A line break ends a command, so one line's options never apply to another line's command.
  const compact = normalizeShellCommandWhitespace(
    command.replace(/\\\n/g, " ").replace(/\n/g, ";"),
  );
  return Object.entries(BASH_WARNINGS)
    .filter(([, pattern]) => pattern.test(compact))
    .map(([label]) => label);
}
