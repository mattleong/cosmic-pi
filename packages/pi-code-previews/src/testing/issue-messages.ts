import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Result from "effect/Result";
import * as Str from "effect/String";
import type { CompactIssue } from "../tools/compact-issues";

interface IssueMessageStyleOptions {
  readonly forbidden?: readonly string[];
  readonly maxLength?: number;
  /** A warning or info issue is not under a `✗`, so it may say what failed; errors by default. */
  readonly severity?: CompactIssue["severity"];
}

const RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\p{Cc}/u, "is not a single plain line"],
  [/^(?:\[[A-Za-z]+\]|Uncaught\b|(?:[A-Z][A-Za-z]*)?Error:)/u, "starts with an error-class prefix"],
  [
    /\b[A-Z][a-z]+(?:[A-Z][a-z]+)*(?:Error|Exception|Failure|Declaration|Expression|Statement)\b/u,
    "names an internal type",
  ],
  [/\(line \d+, col(?:umn)? \d+\)/u, "shows a raw source position"],
  [/\b\w+\(\s*\{|\bsubagent_[a-z_]+\b/u, "contains tool-call syntax"],
  [
    /(?:^|[.;:] )(?:Do not|Don't|Inspect|Retry|Please|Use subagent)\b/u,
    "contains agent instructions",
  ],
  [/^([A-Za-z][\w ]{2,}?): \1\b/iu, "repeats its label"],
  [/(?<!\.)\.$/u, "ends with a period"],
];

// Beneath its row's `✗`, an error states the cause: `OpenAI gave no reason`, not
// `Image generation failed: OpenAI gave no reason` or `The questionnaire failed, so …`.
const ERROR_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [
    /^(?:The [\w -]+? failed,|[A-Z][\w-]*(?: [\w-]+)*? failed:) /u,
    "says what failed before its cause",
  ],
];

export function issueMessageStyleProblems(
  message: string,
  options: IssueMessageStyleOptions = {},
): string[] {
  if (!Str.trim(message)) return ["is blank"];
  const rules =
    options.severity === undefined || options.severity === "error"
      ? [...RULES, ...ERROR_RULES]
      : RULES;
  const problems = Arr.filterMap(rules, ([pattern, problem]) =>
    pattern.test(message) ? Result.succeed(problem) : Result.failVoid,
  );
  const maxLength = options.maxLength ?? 120;
  if (message.length > maxLength) problems.push(`is longer than ${maxLength} characters`);
  for (const token of options.forbidden ?? [])
    if (token && Fn.pipe(message, Str.includes(token)))
      problems.push(`contains the identifier ${token}`);
  return problems;
}
