import {
  ownPresentationField as own,
  presentationArrayLength as lengthOf,
  presentationOutcome as outcomeOf,
  presentationEvidence,
  presentationValidationIdentity,
  type PresentationField,
} from "./presentation-evidence.ts";
/** Pure, bounded recovery evidence. No arguments or general result bodies; issues may
 * retain bounded sanitized remote error text. Nested consumers enforce receipt limits.
 */
import * as Predicate from "effect/Predicate";
import { createBoundedCompactIssuesSchema, type CompactIssue } from "pi-code-previews";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import { projectMcpIssues, readMcpNotices, type McpIssueProjection } from "./issues.ts";
import { invokeHostCallback } from "pi-cosmic-core";
import { mcpIssueMessages } from "../ui/compact-descriptions.ts";
import { normalizeMcpCodeModeError } from "./protocol.ts";

const BoundedIssues = createBoundedCompactIssuesSchema({ maxTextLength: 2048, maxEntries: 32 });

export interface McpPresentation {
  readonly outcome: "completed" | "unknown" | "not-sent";
  readonly isError: boolean;
  readonly incomplete: boolean;
  readonly truncated: boolean;
  readonly issues: readonly CompactIssue[];
  readonly resultId?: string;
}
const object = <Value>(value: Value): boolean =>
  invokeHostCallback(() => Predicate.isObjectOrArray(value) && !Array.isArray(value), false);

const incompleteEvidence: CompactIssue = {
  severity: "warning",
  code: "evidence-incomplete",
  message: mcpIssueMessages["evidence-incomplete"],
  detail:
    "MCP presentation evidence is incomplete. Some recovery information is unavailable.\nDo not replay operations to recover output.",
};
const overflowEvidence: CompactIssue = {
  severity: "warning",
  code: "evidence-overflow",
  message: mcpIssueMessages["evidence-overflow"],
  detail:
    "MCP presentation evidence exceeded its bounds.\nInspect retained output; do not replay operations to recover output.",
};

/** The card decoder shares this projection's failure evidence and boundary view. */
export interface McpEvidence extends Pick<McpIssueProjection, "failure" | "boundary"> {
  readonly presentation: McpPresentation;
}

export const projectMcpEvidence = <Reply>(reply: Reply): McpEvidence => {
  let incomplete = false;
  const field = <Value>(value: Value, key: string): PresentationField => {
    const read = own(value, key);
    if (read.unreadable) incomplete = true;
    return read;
  };
  const action = field(reply, "action").value;
  const envelopeOutcome = outcomeOf(field(reply, "outcome").value);
  let outcome: McpPresentation["outcome"] = envelopeOutcome ?? "unknown";
  const rawError = field(reply, "isError").value;
  let isError = rawError === true;
  incomplete ||=
    envelopeOutcome === undefined || !Predicate.isBoolean(rawError) || !Predicate.isString(action);
  const { data, payload, origin, undiscovered, payloadTruncation } = presentationEvidence(
    reply,
    field,
  );
  if (data !== null && !object(data)) incomplete = true;
  const kind = field(data, "kind").value;
  const message = field(data, "message").value;
  if (kind !== undefined && !Predicate.isString(kind)) incomplete = true;
  if (message !== undefined && (!Predicate.isString(message) || message.length > 512))
    incomplete = true;
  for (const source of [data, payloadTruncation ? payload : undefined]) {
    for (const key of ["truncated", "omitted"]) {
      const flag = field(source, key).value;
      if (flag !== undefined && !Predicate.isBoolean(flag)) incomplete = true;
    }
  }
  const truncated =
    field(data, "truncated").value === true ||
    field(data, "omitted").value === true ||
    kind === "output-limit" ||
    (payloadTruncation && field(payload, "truncated").value === true);
  if (action === "result.read" || origin !== undefined) {
    const originOutcome = outcomeOf(field(origin, "outcome").value);
    const originError = field(origin, "isError").value;
    const validation = field(origin, "outputValidation").value;
    if (
      !originOutcome ||
      !Predicate.isBoolean(originError) ||
      (validation !== undefined &&
        validation !== "passed" &&
        validation !== "failed" &&
        validation !== "unavailable")
    )
      incomplete = true;
    if (originOutcome === "unknown" || outcome === "unknown") outcome = "unknown";
    else if (originOutcome === "not-sent") outcome = "not-sent";
    isError ||= originError === true || validation === "failed";
  }
  if (undiscovered !== undefined && lengthOf(undiscovered) === undefined) incomplete = true;
  const rawId = field(reply, "resultId").value;
  const resultId =
    Predicate.isString(rawId) && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(rawId)
      ? rawId
      : undefined;
  if (rawId !== undefined && resultId === undefined) incomplete = true;
  const notices = readMcpNotices(field, reply, {
    action,
    outcome: envelopeOutcome ?? "unknown",
    isError: rawError !== false,
    validation: presentationValidationIdentity(reply, origin, field),
  });
  incomplete ||= notices.incomplete;
  const evidence: Omit<McpPresentation, "issues"> = {
    outcome,
    isError,
    incomplete,
    truncated,
    ...(resultId && { resultId }),
  };
  const projection = projectMcpIssues(field, reply, evidence, notices);
  // Checked after projection: its own reads can reveal unreadable evidence too. A validated
  // boundary view states its own certainty; fields a failed read lacks, like an origin, are expected.
  const complete = projection.boundary !== undefined || (!incomplete && !projection.lost);
  const issues = Option.getOrUndefined(
    Schema.decodeOption(BoundedIssues)(
      complete ? projection.issues : [...projection.issues, incompleteEvidence],
    ),
  );
  incomplete ||= issues === undefined;
  return {
    failure: projection.failure,
    // The view's issues lead presentation.issues; expose it only when they survived the bounds.
    boundary: issues && projection.boundary,
    presentation: { ...evidence, incomplete, issues: issues ?? [overflowEvidence] },
  };
};

export const projectMcpPresentation = <Reply>(reply: Reply): McpPresentation =>
  projectMcpEvidence(reply).presentation;

export const projectMcpFailurePresentation = <Error>(error: Error): McpPresentation => {
  const failure = normalizeMcpCodeModeError({
    _tag: own(error, "_tag").value,
    kind: own(error, "kind").value,
    outcome: own(error, "outcome").value,
  });
  return projectMcpPresentation({
    action: "MCP request",
    outcome: failure.outcome,
    isError: true,
    data: { kind: failure.kind, message: failure.message },
    notices: [],
  });
};
