import {
  presentationEvidence,
  presentationArrayLength,
  type PresentationReader,
} from "./presentation-evidence.ts";
import { mcpIssueDescription } from "../ui/compact-descriptions.ts";
import type { CompactIssue, CompactIssues } from "pi-code-previews";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import { McpBoundaryError } from "../client/errors.ts";
import { mcpDiagnostic } from "../client/diagnostics.ts";
import { mcpBoundaryFailure } from "../ui/boundary-failure.ts";
import { sanitizeDiagnosticContent, sanitizeTerminalLine } from "pi-cosmic-core";
import { classifyMcpDiscoveryNotice } from "../discovery/diagnostics.ts";
import { isOwnedValidationNotice, validationNoticeIdentity } from "../ui/validation-notices.ts";
import type { McpPresentation } from "./presentation.ts";

const FailureEvidence = Schema.Struct({
  kind: McpBoundaryError.fields.kind,
  reason: McpBoundaryError.fields.reason,
});

function boundaryFailureIssues<Reply, Data, Origin>(
  field: PresentationReader,
  reply: Reply,
  data: Data,
  origin: Origin,
  actionName: string,
  presentation: Omit<McpPresentation, "issues">,
): CompactIssues | undefined {
  const evidence = Option.getOrUndefined(
    Schema.decodeUnknownOption(FailureEvidence)({
      kind: field(data, "kind").value,
      ...(field(data, "reason").value !== undefined && { reason: field(data, "reason").value }),
    }),
  );
  if (evidence && !origin && field(reply, "isError").value === true) {
    const diagnostic = mcpDiagnostic(
      { ...evidence, outcome: presentation.outcome },
      { action: actionName },
    );
    const rawNotices = field(reply, "notices").value;
    const count = field(rawNotices, "length").value;
    const notices: string[] = [];
    let noticesComplete =
      presentationArrayLength(rawNotices) !== undefined && Predicate.isNumber(count) && count <= 32;
    for (let index = 0; noticesComplete && index < Number(count); index++) {
      const notice = field(rawNotices, String(index)).value;
      if (!Predicate.isString(notice) || notice.length > 512) noticesComplete = false;
      else
        notices.push(
          sanitizeDiagnosticContent(sanitizeTerminalLine(notice), { maximumLength: 512 }),
        );
    }
    const boundary = mcpBoundaryFailure({
      known: true,
      noticesComplete,
      displayCuts: [],
      isError: true,
      diagnostic,
      failureKind: evidence.kind,
      failureReason: evidence.reason,
      outcome: presentation.outcome,
      action: actionName,
      truncated: presentation.truncated,
      notices,
      ...(presentation.resultId
        ? { recoveryHint: `/mcp result ${presentation.resultId}` }
        : diagnostic.recovery.length
          ? { recoveryHint: "Open /mcp to inspect current server details." }
          : {}),
    });
    if (boundary && notices.join("\n").length <= 2048) return boundary.issues;
  }
  return undefined;
}

function remoteErrorText<Payload, Data>(field: PresentationReader, payload: Payload, data: Data) {
  let complete =
    field(payload, "structuredContent").value === undefined &&
    field(payload, "_meta").value === undefined;
  const texts: string[] = [];
  const add = <Value>(value: Value) => {
    if (!Predicate.isString(value) || value.length > 512) {
      complete = false;
      return;
    }
    const text = sanitizeDiagnosticContent(sanitizeTerminalLine(value), { maximumLength: 512 });
    if (text) texts.push(text);
  };
  const content = field(payload, "content").value;
  const count = presentationArrayLength(content);
  if (count !== undefined && count <= 32) {
    for (let index = 0; index < count; index++) {
      const part = field(content, String(index)).value;
      if (field(part, "type").value !== "text") {
        complete = false;
        continue;
      }
      add(field(part, "text").value);
    }
  } else complete = false;
  const message = field(data, "message").value;
  if (message !== undefined) {
    add(message);
    // Adapter messages may contain recovery not owned by this text projection.
    complete = false;
  }
  return { text: texts.join("\n"), complete };
}

/** Additive display evidence. The v1 capability and its bounded notice projection are unchanged. */
export function projectMcpIssues<Reply>(
  field: <Value>(value: Value, key: string) => { readonly value: unknown },
  reply: Reply,
  presentation: Omit<McpPresentation, "issues">,
): CompactIssues {
  const entries: CompactIssue[] = [];
  // Non-completed envelopes can carry transport-specific recovery outside the bounded
  // display fields. Classify their known facts, but keep original presentation ownership.
  let complete = !presentation.incomplete && presentation.outcome === "completed";
  const isArray = <Value>(value: Value): boolean => {
    try {
      return Array.isArray(value);
    } catch {
      complete = false;
      return false;
    }
  };
  const { action, data, origin, payload, undiscovered } = presentationEvidence(reply, field);
  const actionName =
    Predicate.isString(action) && /^[a-z][a-z.]{0,63}$/.test(action) ? action : "request";
  if (actionName !== action) complete = false;
  const operation = `mcp:${actionName}`;
  const boundary = boundaryFailureIssues(field, reply, data, origin, actionName, presentation);
  if (boundary) return boundary;
  const add = (
    code: string,
    severity: CompactIssue["severity"],
    cause: string,
    recovery: CompactIssue["recovery"] = [],
  ) => {
    if (cause.length > 2048 || entries.length >= 31) {
      complete = false;
      return;
    }
    entries.push({
      operation,
      code,
      severity,
      cause,
      recovery,
      description: mcpIssueDescription(code),
    });
  };
  const noReplay = { code: "no-replay", text: "Do not replay the operation to recover output." };
  const safe = <Value>(value: Value): string | undefined => {
    if (!Predicate.isString(value) || value.length > 512) {
      complete = false;
      return undefined;
    }
    return sanitizeDiagnosticContent(sanitizeTerminalLine(value), { maximumLength: 512 });
  };
  const validation = validationNoticeIdentity({
    action,
    outcome: field(reply, "outcome").value,
    isError: field(reply, "isError").value,
    originAction: field(origin, "action").value,
    originOutcome: field(origin, "outcome").value,
    originIsError: field(origin, "isError").value,
    outputValidation: field(origin, "outputValidation").value,
  });
  if (validation)
    add(
      `validation-${validation}`,
      validation === "failed" ? "error" : "warning",
      validation === "failed"
        ? "The original operation completed but output validation failed against its captured schema."
        : "The original operation completed but local output validation was unavailable. No mismatch was established.",
      [noReplay],
    );
  if (presentation.outcome === "unknown")
    add("execution-unknown", "warning", "MCP execution is uncertain.", [
      {
        code: "inspect-before-replay",
        text: "Check its state; do not replay the operation automatically.",
      },
    ]);
  if (presentation.outcome === "not-sent")
    add("not-sent", presentation.isError ? "error" : "warning", "The MCP operation was not sent.");
  if (field(data, "kind").value === "cleanup")
    add("cleanup-unconfirmed", "warning", "MCP cleanup is unconfirmed.", [
      { code: "cleanup-gate", text: "Reconnection is not safe recovery yet." },
    ]);
  if (presentation.truncated)
    add("output-truncated", "warning", "MCP output is truncated or omitted.", [noReplay]);
  if (field(origin, "isError").value === true) {
    // A retained slice need not contain the original remote diagnostic body.
    complete = false;
    add(
      "origin-failed",
      "error",
      "The original operation reported a failure. Reading retained output does not change that outcome.",
      [noReplay],
    );
  }
  if (!validation && field(origin, "outputValidation").value === "failed")
    add(
      "output-invalid",
      "error",
      "The original operation completed but output validation failed.",
      [noReplay],
    );
  if (!validation && field(origin, "outputValidation").value === "unavailable")
    add(
      "validation-unavailable",
      "warning",
      "Original MCP output validation was unavailable. No mismatch was established.",
      [noReplay],
    );

  // Remote tool errors may have several text blocks. Preserve their complete bounded text,
  // not the first line. Unknown content cannot authorize compact failure ownership.
  if (
    field(reply, "isError").value === true &&
    !validation &&
    (field(origin, "isError").value !== true || action === "result.read")
  ) {
    const remote = remoteErrorText(field, payload, data);
    complete &&= remote.complete;
    if (remote.text)
      add(
        action === "result.read" ? "retained-read-failed" : "remote-failure",
        "error",
        remote.text,
        [noReplay],
      );
    else {
      add(
        action === "result.read" ? "retained-read-failed" : "failure",
        "error",
        action === "result.read" ? "Reading retained MCP output failed." : "MCP reported an error.",
        [noReplay],
      );
      complete = false;
    }
  }
  const notices = field(reply, "notices").value;
  const count = field(notices, "length").value;
  if (isArray(notices) && Predicate.isNumber(count) && count <= 32) {
    const unknown: string[] = [];
    for (let i = 0; i < count; i++) {
      const notice = field(notices, String(i)).value;
      if (!Predicate.isString(notice)) {
        complete = false;
        continue;
      }
      if (validation && isOwnedValidationNotice(notice, validation)) continue;
      if (
        classifyMcpDiscoveryNotice({
          action: Predicate.isString(action) ? action : "",
          outcome: presentation.outcome,
          isError: presentation.isError,
          notice,
        }).visibility === "expanded-only"
      )
        continue;
      const text = safe(notice);
      if (text) unknown.push(text);
    }
    if (unknown.length) {
      complete = false;
      add("unclassified-notices", "warning", unknown.join("\n"));
    }
  } else complete = false;
  const undiscoveredCount = presentationArrayLength(undiscovered);
  if (Predicate.isNumber(undiscoveredCount) && undiscoveredCount > 0)
    add(
      "discovery-incomplete",
      "warning",
      `${undiscoveredCount} MCP servers have undiscovered metadata.`,
      [{ code: "target-discovery", text: "Select a relevant server for targeted discovery." }],
    );
  if (
    presentation.resultId &&
    (presentation.truncated || presentation.isError || presentation.outcome !== "completed")
  )
    add("retained-output", "warning", "", [
      {
        code: "read-retained",
        text: `Read retained MCP output with result.read id="${presentation.resultId}". Reading output does not authorize replay.`,
      },
    ]);
  if (!complete)
    add("evidence-incomplete", "warning", "MCP presentation evidence is incomplete.", [noReplay]);
  return { coverage: complete ? "complete" : "unknown", entries };
}
