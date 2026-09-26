import { normalizeShellCommandWhitespace } from "../tools/shell-command";

interface BashWarning {
  label: string;
  pattern: RegExp;
}

const BASH_WARNINGS: BashWarning[] = [
  {
    label: "Deletes files recursively",
    pattern:
      /\brm\b(?=[^;&|]*(?:-[\w-]*r[\w-]*|--recursive)\b)(?=[^;&|]*(?:-[\w-]*f[\w-]*|--force)\b)/i,
  },
  { label: "Runs with elevated privileges", pattern: /(^|[;&|]\s*)sudo\b/ },
  { label: "Changes permissions recursively", pattern: /\bchmod\s+(?:-[\w-]*R|--recursive)\b/ },
  { label: "Changes ownership recursively", pattern: /\bchown\s+(?:-[\w-]*R|--recursive)\b/ },
  { label: "Discards uncommitted git changes", pattern: /\bgit\s+reset\s+--hard\b/ },
  { label: "Removes untracked files", pattern: /\bgit\s+clean\s+-[\w-]*[fd][\w-]*\b/ },
  { label: "Removes Docker data", pattern: /\bdocker\s+system\s+prune\b/ },
  {
    label: "Writes to a system path",
    pattern: />{1,2}\s*\/?(?:etc|bin|sbin|usr|var|System|Library)\b/,
  },
];

export function getBashWarnings(command: string): string[] {
  const compact = normalizeShellCommandWhitespace(command);
  return BASH_WARNINGS.filter((warning) => warning.pattern.test(compact)).map(
    (warning) => warning.label,
  );
}
