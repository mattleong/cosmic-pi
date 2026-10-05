import { normalizeShellCommandWhitespace } from "../tools/shell-command";

interface BashWarning {
  label: string;
  pattern: RegExp;
}

const BASH_WARNINGS: BashWarning[] = [
  {
    label: "Deletes files recursively",
    // Recursive and forced, as standalone option tokens in the same command: -rf, -fr, -r -f,
    // --recursive --force. Option-like text inside an operand, as in notes-rf.md, is not one.
    pattern:
      /\brm(?=\s)(?=[^;&|]*\s(?:-[a-z]*r[a-z]*|--recursive)(?=$|[\s;&|]))(?=[^;&|]*\s(?:-[a-z]*f[a-z]*|--force)(?=$|[\s;&|]))/i,
  },
  { label: "Runs with elevated privileges", pattern: /(^|[;&|]\s*)sudo\b/ },
  { label: "Changes permissions recursively", pattern: /\bchmod\s+(?:-[\w-]*R|--recursive)\b/ },
  { label: "Changes ownership recursively", pattern: /\bchown\s+(?:-[\w-]*R|--recursive)\b/ },
  { label: "Discards uncommitted git changes", pattern: /\bgit\s+reset\s+--hard\b/ },
  { label: "Removes untracked files", pattern: /\bgit\s+clean\s+-[\w-]*[fd][\w-]*\b/ },
  { label: "Removes Docker data", pattern: /\bdocker\s+system\s+prune\b/ },
  {
    label: "Writes to a system path",
    // Only an absolute system directory; relative paths such as bin/build.log are local.
    pattern: />{1,2}\s*["']?\/(?:etc|bin|sbin|usr|var|System|Library)(?=$|[/\s"';&|)])/,
  },
];

export function getBashWarnings(command: string): string[] {
  // A line break ends a command, so one line's options never apply to another line's command.
  const compact = normalizeShellCommandWhitespace(
    command.replace(/\\\n/g, " ").replace(/\n/g, ";"),
  );
  return BASH_WARNINGS.filter((warning) => warning.pattern.test(compact)).map(
    (warning) => warning.label,
  );
}
