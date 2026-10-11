import { sanitizeDiagnosticContent, firstLineMessage } from "pi-cosmic-core";

const CAUSE_WORD = /\b(?:error|errors|fail|failed|failure|failures|fatal|panic|panicked)\b/iu;
const CAUSE_CLASS = /[a-z](?:Error|Exception)\b/u;
const NO_CAUSE = /\b0 (?:errors?|fail(?:ed|ures?)?)\b/iu;
const WRAPPER =
  /^(?:npm (?:ERR!|error)|ELIFECYCLE\b|ERR_PNPM_|error Command failed|make(?:\[\d+\])?: \*\*\*|at |\[Showing )/u;
export const OUTPUT_FAILURE_LINE_LIMIT = 50;
const LOCATION = /^(\S+?)(?:\((\d+),\d+\)|:(\d+)(?::\d+)?):\s+/u;
const SEVERITY_CODE = /^(?:error|fatal)(?:\[[\w-]+\]| TS\d+)?:\s*/iu;

const shortenCause = (line: string): string => {
  const location = LOCATION.exec(line);
  const rest = (location ? line.slice(location[0].length) : line).replace(SEVERITY_CODE, "");
  if (!location) return rest;
  const [, path = "", parenLine, colonLine] = location;
  const file = path.split(/[\\/]/u).at(-1);
  return `${file}:${parenLine ?? colonLine} ${rest}`;
};

export function outputFailureLine(output: readonly string[]): string | undefined {
  for (const raw of output) {
    const line = raw.trim();
    if (!line || WRAPPER.test(line) || NO_CAUSE.test(line)) continue;
    if (!CAUSE_WORD.test(line) && !CAUSE_CLASS.test(line)) continue;
    const cause = firstLineMessage(
      shortenCause(sanitizeDiagnosticContent(line)),
      "",
      OUTPUT_FAILURE_LINE_LIMIT,
    );
    if (cause) return cause;
  }
  return undefined;
}

const EXIT_MEANINGS = new Map([
  [126, "not executable"],
  [127, "command not found"],
  [130, "interrupted"],
  [137, "killed (possibly out of memory)"],
  [139, "crashed"],
  [143, "terminated"],
]);
const SIGNAL_MEANINGS = new Map([
  ["SIGABRT", "aborted"],
  ["SIGINT", "interrupted"],
  ["SIGKILL", "killed (possibly out of memory)"],
  ["SIGSEGV", "crashed"],
  ["SIGTERM", "terminated"],
]);

export function exitStatusMeaning(
  exitCode: number | null | undefined,
  signal?: string,
): string | undefined {
  return (
    (signal === undefined ? undefined : SIGNAL_MEANINGS.get(signal)) ??
    (exitCode === null || exitCode === undefined ? undefined : EXIT_MEANINGS.get(exitCode))
  );
}
