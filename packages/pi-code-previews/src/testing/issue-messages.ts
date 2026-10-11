interface IssueMessageStyleOptions {
  readonly forbidden?: readonly string[];
  readonly maxLength?: number;
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

export function issueMessageStyleProblems(
  message: string,
  options: IssueMessageStyleOptions = {},
): string[] {
  if (!message.trim()) return ["is blank"];
  const problems = RULES.flatMap(([pattern, problem]) => (pattern.test(message) ? [problem] : []));
  const maxLength = options.maxLength ?? 120;
  if (message.length > maxLength) problems.push(`is longer than ${maxLength} characters`);
  for (const token of options.forbidden ?? [])
    if (token && message.includes(token)) problems.push(`contains the identifier ${token}`);
  return problems;
}
