/**
 * Human messages for runtime diagnostics, built from the facts the runtime records rather than
 * its wording. The raw diagnostic stays in the result.
 */
import * as Predicate from "effect/Predicate";
import type { CodeModeDiagnosticFacts } from "../boundary/codemode-runtime.ts";
import { nestedToolLabel } from "./compact-subject.ts";
import { failureMessage, type FailureEvidence } from "./failure-evidence.ts";
import { formatDuration, firstLineMessage } from "pi-cosmic-core";

/** A diagnostic as presentation reads it: its kind, own message, and recorded facts. */
interface Diagnostic {
  readonly kind: string;
  readonly message: string;
  readonly facts?: CodeModeDiagnosticFacts;
}

/** The failure itself, without the guidance that follows it for the agent. */
const lead = (text: string) =>
  firstLineMessage(text, "")
    .split(/; | - /u)[0]!
    .trim();

/** Path segments such as `["edits", 0, "oldText"]`, shown as `edits[0].oldText`. */
const fieldPath = (field: ReadonlyArray<string | number>) =>
  field
    .map((segment, position) =>
      Predicate.isNumber(segment) ? `[${segment}]` : `${position > 0 ? "." : ""}${segment}`,
    )
    .join("");

/** What was wrong with a tool's input, from the schema issue's facts. */
const inputProblem = (facts: CodeModeDiagnosticFacts, message: string): string => {
  const field = facts.field?.length ? fieldPath(facts.field) : undefined;
  if (facts.fieldIssue === "unexpected" && field) return `unexpected field "${field}"`;
  if (facts.fieldIssue === "missing" && field) return `missing field "${field}"`;
  const expected = facts.expected === undefined ? undefined : lead(facts.expected);
  if (expected) return field ? `${expected} at ${field}` : expected;
  return lead(message) || "the value does not match its schema";
};

/** An unknown or uncallable tool path, named as the program wrote it. */
const toolProblem = (facts: CodeModeDiagnosticFacts): string | undefined =>
  facts.tool === undefined
    ? undefined
    : facts.toolIssue === "namespace"
      ? `No tool namespace named ${facts.tool}`
      : facts.toolIssue === "not-callable"
        ? `${facts.tool} is not a callable tool`
        : `No tool named ${facts.tool}`;

const describe = ({ kind, message, facts = {} }: Diagnostic): string => {
  const tool = facts.tool === undefined ? undefined : nestedToolLabel(facts.tool);
  switch (kind) {
    case "ParseError":
      return `Syntax error: ${lead(facts.reason ?? "") || "the program could not be parsed"}`;
    case "UnsupportedSyntax":
      return facts.syntax
        ? `Unsupported syntax: ${facts.syntax.replace(/([a-z])([A-Z])/gu, "$1 $2").toLowerCase()}`
        : lead(message);
    case "UnknownTool":
      return toolProblem(facts) ?? lead(message);
    case "InvalidToolInput":
      if (tool === undefined) return lead(message);
      return facts.toolIssue === "arity"
        ? `${tool} expects one input object`
        : `Invalid ${tool} input: ${inputProblem(facts, message)}`;
    case "InvalidToolOutput":
      return tool ? `${tool} returned invalid output` : lead(message);
    case "InvalidDataValue":
      return facts.owner ? `${facts.owner} must be plain data` : lead(message);
    case "ToolCallLimitExceeded":
      return facts.limit === undefined ? lead(message) : `Stopped at the ${facts.limit}-call limit`;
    case "TimeoutExceeded":
      return facts.timeoutMs === undefined
        ? lead(message)
        : `Timed out after ${formatDuration(facts.timeoutMs)}`;
    case "ToolFailure":
      return tool ? `Stopped after a ${tool} call failed` : lead(message);
    default:
      return lead(message);
  }
};

const refusalReason = (failure: Diagnostic): string => {
  const { kind, facts = {} } = failure;
  if (kind === "InvalidToolInput")
    return facts.toolIssue === "arity"
      ? "expects one input object"
      : inputProblem(facts, failure.message);
  if (kind === "UnknownTool")
    return facts.toolIssue === "not-callable" ? "not a callable tool" : "no such tool";
  if (kind === "ToolCallLimitExceeded")
    return facts.limit === undefined ? "over the call limit" : `over the ${facts.limit}-call limit`;
  return describe(failure);
};

/** The reason on the row of a call refused before its tool ran. */
export const describeRefusal = (failure: Diagnostic) => {
  const reason = refusalReason(failure);
  return firstLineMessage(
    `Not sent: ${reason.charAt(0).toLowerCase()}${reason.slice(1)}`,
    "Not sent",
  );
};

/** One human line naming what stopped the program and, when known, where. */
export const describeProgramFailure = (failure: FailureEvidence, resultText: string): string => {
  const described = describe({
    kind: failure.kind,
    message: failureMessage(failure, resultText),
    ...(failure.facts !== undefined && { facts: failure.facts }),
  });
  return firstLineMessage(
    `${described || "The program failed"}${failure.line === undefined ? "" : ` (line ${failure.line})`}`,
    "The program failed",
  );
};
