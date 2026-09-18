/** Pure, bounded recovery evidence. No arguments or general result bodies; issues may
 * retain bounded sanitized remote error text. Nested consumers enforce receipt limits.
 */
import * as Predicate from "effect/Predicate";
import type { CompactIssues } from "pi-code-previews";
import { projectMcpIssues } from "./issues.ts";
import { sanitizeDiagnosticContent, sanitizeTerminalLine } from "pi-cosmic-core";
import { classifyMcpDiscoveryNotice, mcpUndiscoveredNotice } from "../discovery/diagnostics.ts";
import {
  canonicalValidationWarning,
  isOwnedValidationNotice,
  validationNoticeIdentity,
} from "../ui/validation-notices.ts";
import { normalizeMcpCodeModeError } from "./protocol.ts";

export interface McpPresentation {
  readonly issues: CompactIssues;
  readonly outcome: "completed" | "unknown" | "not-sent";
  readonly isError: boolean;
  readonly incomplete: boolean;
  readonly truncated: boolean;
  readonly notices: readonly string[];
  readonly resultId?: string;
}
interface PresentationField {
  readonly value: unknown;
  readonly unreadable?: true;
}
const own = <Value>(value: Value, key: string): PresentationField => {
  try {
    if (!Predicate.isObjectOrArray(value)) return { value: undefined };
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (field && !("value" in field)) return { value: undefined, unreadable: true };
    return { value: field?.value };
  } catch {
    return { value: undefined, unreadable: true };
  }
};
const object = <Value>(value: Value): boolean => {
  try {
    return Predicate.isObjectOrArray(value) && !Array.isArray(value);
  } catch {
    return false;
  }
};
const outcomeOf = <Value>(value: Value): McpPresentation["outcome"] | undefined =>
  value === "completed"
    ? "completed"
    : value === "not-sent"
      ? "not-sent"
      : value === "unknown"
        ? "unknown"
        : undefined;
const lengthOf = <Value>(value: Value): number | undefined => {
  try {
    const length = own(value, "length").value;
    return Array.isArray(value) &&
      Predicate.isNumber(length) &&
      Number.isSafeInteger(length) &&
      length >= 0
      ? length
      : undefined;
  } catch {
    return undefined;
  }
};

export const projectMcpPresentation = <Reply>(reply: Reply): McpPresentation => {
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
  const notices: string[] = [];
  const add = <Value>(value: Value) => {
    if (!Predicate.isString(value)) {
      incomplete = true;
      return;
    }
    // Redact complete text before bounding it. An oversized diagnostic is not a
    // complete recovery instruction, so retain incompleteness rather than a fragment.
    const text = sanitizeDiagnosticContent(sanitizeTerminalLine(value), {
      maximumLength: Number.MAX_SAFE_INTEGER,
    });
    if (text.length > 512) {
      incomplete = true;
      return;
    }
    if (!text || notices.includes(text)) return;
    if (notices.length >= 32) {
      incomplete = true;
      return;
    }
    notices.push(text);
  };
  const data = field(reply, "data").value;
  if (data !== null && !object(data)) incomplete = true;
  const result = field(data, "result").value;
  const payload = result ?? data;
  const kind = field(data, "kind").value;
  const message = field(data, "message").value;
  if (kind !== undefined && !Predicate.isString(kind)) incomplete = true;
  if (message !== undefined && (!Predicate.isString(message) || message.length > 512))
    incomplete = true;
  for (const source of [data, object(payload) ? payload : undefined]) {
    for (const key of ["truncated", "omitted"]) {
      const flag = field(source, key).value;
      if (flag !== undefined && !Predicate.isBoolean(flag)) incomplete = true;
    }
  }
  const truncated =
    field(data, "truncated").value === true ||
    field(data, "omitted").value === true ||
    kind === "output-limit" ||
    field(payload, "truncated").value === true;
  let recovery = truncated;
  const origin = field(data, "origin").value;
  const validationIdentity = validationNoticeIdentity({
    action,
    outcome: envelopeOutcome,
    isError: rawError,
    originAction: field(origin, "action").value,
    originOutcome: field(origin, "outcome").value,
    originIsError: field(origin, "isError").value,
    outputValidation: field(origin, "outputValidation").value,
  });
  if (validationIdentity) add(canonicalValidationWarning(validationIdentity));
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
    if (originError === true)
      add(
        "The original operation reported a failure. Reading retained output does not change that outcome; do not replay the operation to recover output.",
      );
    if (!validationIdentity && validation === "failed")
      add(
        "The original operation completed but output validation failed. Reading retained output does not change that outcome; do not replay the operation to recover output.",
      );
    if (validation === "unavailable") {
      recovery = true;
      if (!validationIdentity)
        add(
          "Original MCP output validation was unavailable. No mismatch was established. Do not replay the operation to recover output.",
        );
    }
  }
  if (outcome === "unknown")
    add("MCP execution is uncertain. Check its state; do not replay the operation automatically.");
  if (outcome === "not-sent") add("The MCP operation was not sent.");
  if (kind === "cleanup") add("MCP cleanup is unconfirmed. Reconnection is not safe recovery yet.");
  if (truncated)
    add("MCP output is truncated or omitted. Do not replay the operation to recover output.");
  const undiscovered = field(payload, "undiscovered").value;
  const undiscoveredCount = lengthOf(undiscovered);
  if (undiscovered !== undefined && undiscoveredCount === undefined) incomplete = true;
  if (undiscoveredCount) add(mcpUndiscoveredNotice(undiscoveredCount));
  const rawId = field(reply, "resultId").value;
  const resultId =
    Predicate.isString(rawId) && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(rawId)
      ? rawId
      : undefined;
  if (rawId !== undefined && resultId === undefined) incomplete = true;
  if (resultId && (recovery || isError || outcome !== "completed"))
    add(
      `Read retained MCP output with result.read id="${resultId}". Reading output does not authorize replay.`,
    );
  if (
    isError &&
    !validationIdentity &&
    field(origin, "isError").value !== true &&
    field(origin, "outputValidation").value !== "failed"
  )
    add("MCP reported an error. Do not replay a completed operation to recover output.");
  if (rawError === true && field(data, "message").value !== undefined)
    add(field(data, "message").value);
  const rawNotices = field(reply, "notices").value;
  const count = lengthOf(rawNotices);
  if (count === undefined || count > 32) incomplete = true;
  for (let index = 0; index < Math.min(count ?? 0, 32); index++) {
    const notice = field(rawNotices, String(index)).value;
    if (!Predicate.isString(notice)) {
      incomplete = true;
      continue;
    }
    if (validationIdentity && isOwnedValidationNotice(notice, validationIdentity)) continue;
    if (
      classifyMcpDiscoveryNotice({
        action: Predicate.isString(action) ? action : "",
        outcome: envelopeOutcome ?? "unknown",
        isError: rawError !== false,
        notice,
      }).visibility === "attention"
    )
      add(notice);
  }
  if (incomplete) {
    if (notices.length >= 32) notices.pop();
    add(
      "MCP presentation evidence is incomplete. Some recovery information is unavailable; do not replay operations to recover output.",
    );
  }
  const evidence: Omit<McpPresentation, "issues"> = {
    outcome,
    isError,
    incomplete,
    truncated,
    notices,
  };
  const retained = resultId ? { ...evidence, resultId } : evidence;
  const issues = projectMcpIssues(field, reply, retained);
  return {
    ...retained,
    incomplete,
    issues: incomplete ? { ...issues, coverage: "unknown" } : issues,
  };
};

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
