import {
  presentationEvidence,
  presentationArrayLength,
  presentationValidationIdentity,
  type PresentationReader,
} from "./presentation-evidence.ts";
import { mcpDiscoveryMessage, mcpIssueMessages } from "../ui/compact-descriptions.ts";
import { firstLineMessage, mergeCompactIssues, type CompactIssue } from "pi-code-previews";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { McpBoundaryError } from "../client/errors.ts";
import { mcpDiagnostic } from "../client/diagnostics.ts";
import {
  credentialMutationBlocked,
  mcpBoundaryView,
  type McpBoundaryView,
} from "../ui/boundary-failure.ts";
import {
  decodeUnknownOrUndefined,
  sanitizeDiagnosticContent,
  sanitizeTerminalLine,
} from "pi-cosmic-core";
import { classifyMcpDiscoveryNotice, mcpUndiscoveredNotice } from "../discovery/diagnostics.ts";
import { canonicalValidationWarning, isOwnedValidationNotice } from "../ui/validation-notices.ts";
import type { McpValidationNoticeIdentity } from "../results/validation-notices.ts";
import type { McpPresentation } from "./presentation.ts";

const FailureEvidence = Schema.Struct({
  kind: McpBoundaryError.fields.kind,
  reason: McpBoundaryError.fields.reason,
});

const NO_REPLAY = "Do not replay the operation to recover output.";
const MAX_DETAIL = 2048;
/** One entry stays reserved for the incomplete-evidence warning. */
const MAX_ENTRIES = 31;

export interface McpNoticeEvidence {
  /** Sanitized notices that keep attention, in first-seen order. */
  readonly attention: readonly string[];
  /** Routine discovery notices, shown only on expansion. */
  readonly information: readonly CompactIssue[];
  readonly incomplete: boolean;
}

export interface McpIssueProjection {
  readonly issues: readonly CompactIssue[];
  /** Some issue evidence exceeded its bounds and was omitted. */
  readonly lost: boolean;
  readonly failure?: typeof FailureEvidence.Type | undefined;
  readonly boundary?: McpBoundaryView | undefined;
}

/** Envelope notices, redacted in full before bounding. An oversized notice is not a complete
 * instruction, so it marks the evidence incomplete rather than leaving a fragment. Owned
 * validation notices are consolidated into their validation issue. */
export function readMcpNotices<Reply>(
  field: PresentationReader,
  reply: Reply,
  context: {
    readonly action: unknown;
    readonly outcome: string;
    readonly isError: boolean;
    readonly validation: McpValidationNoticeIdentity | undefined;
  },
): McpNoticeEvidence {
  const notices = field(reply, "notices").value;
  const count = presentationArrayLength(notices);
  let incomplete = count === undefined || count > 32;
  const attention: string[] = [];
  const information: CompactIssue[] = [];
  for (let index = 0; index < Math.min(count ?? 0, 32); index++) {
    const notice = field(notices, String(index)).value;
    if (!Predicate.isString(notice)) {
      incomplete = true;
      continue;
    }
    if (context.validation && isOwnedValidationNotice(notice, context.validation)) continue;
    const text = sanitizeDiagnosticContent(sanitizeTerminalLine(notice), {
      maximumLength: Number.MAX_SAFE_INTEGER,
    });
    if (text.length > 512) {
      incomplete = true;
      continue;
    }
    if (!text) continue;
    const policy = classifyMcpDiscoveryNotice({
      action: Predicate.isString(context.action) ? context.action : "",
      outcome: context.outcome,
      isError: context.isError,
      notice,
    });
    if (policy.visibility === "expanded-only")
      information.push({
        severity: "info",
        code: "discovery-information",
        message: mcpDiscoveryMessage(policy),
        detail: text,
      });
    else if (!attention.includes(text)) attention.push(text);
  }
  return { attention, information: mergeCompactIssues(information), incomplete };
}

/** Every consumer shares this view. Any origin, including a malformed null, and malformed
 * or oversized notices decline it; notices that sanitize to empty are dropped. */
function boundaryView<Reply, Origin>(
  field: PresentationReader,
  reply: Reply,
  origin: Origin,
  action: string,
  failure: typeof FailureEvidence.Type,
  presentation: Omit<McpPresentation, "issues">,
  notices: McpNoticeEvidence,
): McpBoundaryView | undefined {
  if (origin !== undefined || field(reply, "isError").value !== true) return undefined;
  if (notices.incomplete || notices.attention.join("\n").length > MAX_DETAIL) return undefined;
  const diagnostic = mcpDiagnostic({ ...failure, outcome: presentation.outcome }, { action });
  return mcpBoundaryView({
    diagnostic,
    failure,
    outcome: presentation.outcome,
    action,
    truncated: presentation.truncated,
    notices: notices.attention,
    ...(presentation.resultId
      ? { recoveryHint: `/mcp result ${presentation.resultId}` }
      : diagnostic.recovery.length
        ? { recoveryHint: "Open /mcp to inspect current server details." }
        : {}),
  });
}

/** Remote tool errors may have several text blocks. Keep their complete bounded text. */
function remoteErrorText<Payload, Data>(field: PresentationReader, payload: Payload, data: Data) {
  let lost = false;
  const texts: string[] = [];
  const add = <Value>(value: Value) => {
    if (!Predicate.isString(value) || value.length > 512) {
      lost = true;
      return;
    }
    // Keep line structure: the first line becomes the message.
    const lines = value.split(/\r?\n/u).map(sanitizeTerminalLine).filter(Boolean);
    const text = sanitizeDiagnosticContent(lines.join("\n"), { maximumLength: 512 });
    if (text) texts.push(text);
  };
  const content = field(payload, "content").value;
  const count = presentationArrayLength(content);
  if (count !== undefined && count <= 32) {
    for (let index = 0; index < count; index++) {
      const part = field(content, String(index)).value;
      // Non-text parts are not error text; the raw result keeps them.
      if (field(part, "type").value === "text") add(field(part, "text").value);
    }
  } else if (count !== undefined) lost = true;
  const message = field(data, "message").value;
  if (message !== undefined) add(message);
  return { text: texts.join("\n"), lost };
}

/** The first line becomes the message; the detail keeps what the message does not say. */
function remoteDetail(text: string, message: string): string {
  const lines = text.split("\n");
  const first = lines.findIndex((line) => line.trim());
  // The message may drop the line's final period; it still restates that line.
  const rest =
    lines[first]?.trim().replace(/(?<!\.)\.$/u, "") === message ? lines.slice(first + 1) : lines;
  return [rest.join("\n").trim(), NO_REPLAY].filter(Boolean).join("\n");
}

/** Display evidence only. The v1 capability reply and its notices are unchanged. */
export function projectMcpIssues<Reply>(
  field: PresentationReader,
  reply: Reply,
  presentation: Omit<McpPresentation, "issues">,
  notices: McpNoticeEvidence,
): McpIssueProjection {
  const issues: CompactIssue[] = [];
  let lost = false;
  const { action, data, origin, payload, undiscovered } = presentationEvidence(reply, field);
  const actionName =
    Predicate.isString(action) && /^[a-z][a-z.]{0,63}$/.test(action) ? action : "request";
  const kind = field(data, "kind").value;
  const reason = field(data, "reason").value;
  const failure = decodeUnknownOrUndefined(
    FailureEvidence,
    reason === undefined ? { kind } : { kind, reason },
  );
  const boundary =
    failure && boundaryView(field, reply, origin, actionName, failure, presentation, notices);
  if (boundary) return { issues: boundary.issues, lost, failure, boundary };
  const push = (issue: CompactIssue) => {
    if ((issue.detail?.length ?? 0) > MAX_DETAIL || issues.length >= MAX_ENTRIES) lost = true;
    else issues.push(issue);
  };
  const add = (
    code: keyof typeof mcpIssueMessages,
    severity: CompactIssue["severity"],
    detail?: string,
    message: string = mcpIssueMessages[code],
  ) => push({ severity, code, message, ...(detail && { detail }) });
  const validation = presentationValidationIdentity(reply, origin, field);
  if (validation)
    add(
      `validation-${validation}`,
      validation === "failed" ? "error" : "warning",
      canonicalValidationWarning(validation),
    );
  if (presentation.outcome === "unknown")
    add(
      "execution-unknown",
      "warning",
      "Check its state; do not replay the operation automatically.",
    );
  if (presentation.outcome === "not-sent")
    add("not-sent", presentation.isError ? "error" : "warning");
  if (kind === "cleanup")
    add("cleanup-unconfirmed", "warning", "Reconnection is not safe recovery yet.");
  if (failure && credentialMutationBlocked(failure.reason))
    add(
      "credential-unconfirmed",
      "warning",
      mcpDiagnostic({ ...failure, outcome: "not-sent" }).explanation,
    );
  if (presentation.truncated) add("output-truncated", "warning", NO_REPLAY);
  const originFailed = field(origin, "isError").value === true;
  const originValidation = field(origin, "outputValidation").value;
  const unchanged = `Reading retained output does not change that outcome.\n${NO_REPLAY}`;
  if (originFailed) add("origin-failed", "error", unchanged);
  if (!validation && originValidation === "failed") add("output-invalid", "error", unchanged);
  if (!validation && originValidation === "unavailable")
    add("validation-unavailable", "warning", `No mismatch was established.\n${NO_REPLAY}`);

  if (
    field(reply, "isError").value === true &&
    !validation &&
    (!originFailed || action === "result.read")
  ) {
    const remote = remoteErrorText(field, payload, data);
    lost ||= remote.lost;
    // Oversized remote text keeps its error; the raw result retains the full text.
    const bounded = (detail: string) => {
      if (detail.length <= MAX_DETAIL) return detail;
      lost = true;
      return NO_REPLAY;
    };
    if (action === "result.read")
      add("retained-read-failed", "error", bounded([remote.text, NO_REPLAY].join("\n").trim()));
    else if (remote.text) {
      const message = firstLineMessage(remote.text, mcpIssueMessages["remote-failure"]);
      add("remote-failure", "error", bounded(remoteDetail(remote.text, message)), message);
    } else if (presentation.outcome !== "not-sent") add("failure", "error", NO_REPLAY);
  }
  if (notices.attention.length) {
    // Keep whole notices only. The detailed card still lists any that do not fit.
    let detail = notices.attention[0]!;
    for (const text of notices.attention.slice(1)) {
      if (detail.length + 1 + text.length > MAX_DETAIL) {
        lost = true;
        break;
      }
      detail += `\n${text}`;
    }
    add("unclassified-notices", "warning", detail);
  }
  for (const issue of notices.information) push(issue);
  const undiscoveredCount = presentationArrayLength(undiscovered);
  if (undiscoveredCount)
    add("discovery-incomplete", "warning", mcpUndiscoveredNotice(undiscoveredCount));
  if (
    presentation.resultId &&
    (presentation.truncated ||
      presentation.isError ||
      presentation.outcome !== "completed" ||
      originValidation === "unavailable")
  )
    add(
      "retained-output",
      "info",
      `Read retained MCP output with result.read id="${presentation.resultId}". Reading output does not authorize replay.`,
    );
  return { issues, lost, failure };
}
