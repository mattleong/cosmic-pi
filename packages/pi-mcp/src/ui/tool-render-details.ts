import {
  ownPresentationField as own,
  presentationArrayLength as arrayLength,
  presentationOutcome as outcome,
  presentationEvidence,
  presentationValidationIdentity,
} from "../code-mode/presentation-evidence.ts";
/** Display-only normalization. Descriptor reads never invoke historical getters or toJSON. */
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { sanitizeDiagnosticContent, sanitizeTerminalLine } from "pi-cosmic-core";
import { mcpDiagnostic, type McpDiagnostic } from "../client/diagnostics.ts";
import { McpBoundaryError } from "../client/errors.ts";
import { projectMcpPresentation, type McpPresentation } from "../code-mode/presentation.ts";

import { MCP_DISPLAY_LIMITS, mcpContentPreview, type McpDisplayCut } from "./content-preview.ts";

import { isOwnedValidationNotice } from "./validation-notices.ts";

export const MCP_CARD_LIMITS = MCP_DISPLAY_LIMITS;
interface McpRenderField {
  readonly value: unknown;
}
const safeText = <Value>(value: Value, maximum = 512): string | undefined =>
  Predicate.isString(value)
    ? sanitizeDiagnosticContent(sanitizeTerminalLine(value), {
        maximumLength: maximum,
      })
    : undefined;
const list = <Value>(value: Value, maximum: number): unknown[] => {
  const length = arrayLength(value);
  if (length === undefined) return [];
  return Array.from(
    { length: Math.min(length, maximum) },
    (_, index) => own(value, String(index)).value,
  );
};
export type McpCardOutcome = "completed" | "unknown" | "not-sent";
export interface McpCardOrigin {
  readonly action: string;
  readonly outcome?: McpCardOutcome;
  readonly isError: boolean;
  readonly outputValidationFailed: boolean;
  readonly outputValidationUnavailable: boolean;
}
export interface McpCardPage {
  readonly returned: number;
  readonly total: number | undefined;
  readonly hasMore: boolean;
}
export interface McpCardDetails {
  readonly presentation: McpPresentation;
  readonly action: string;
  readonly outcome?: McpCardOutcome;
  readonly isError: boolean;
  readonly known: boolean;
  readonly counts: readonly string[];
  readonly counters: readonly string[];
  readonly metadata: readonly string[];
  readonly notices: readonly string[];
  readonly noticesComplete: boolean;
  readonly warnings: readonly string[];
  readonly truncated: boolean;
  readonly displayCuts: readonly McpDisplayCut[];
  readonly hasCompleteReadableText: boolean;
  readonly attachmentCount: number;
  readonly attachmentsLimited: boolean;
  readonly imageCount: number;
  readonly page?: McpCardPage;
  readonly retainedPage?: {
    readonly offset: number;
    readonly end: number;
    readonly next: number | null;
    readonly total: number;
  };
  readonly failureKind?: McpBoundaryError["kind"];
  readonly failureReason?: McpBoundaryError["reason"];
  readonly undiscoveredCount: number;
  readonly preview: string;
  readonly failurePreview: string;
  readonly resultId?: string;
  readonly origin?: McpCardOrigin;
  readonly recoveryHint?: string;
  readonly diagnostic?: McpDiagnostic;
}
const failureEvidenceSchema = Schema.Struct({
  kind: McpBoundaryError.fields.kind,
  reason: McpBoundaryError.fields.reason,
});

const legacyDetails = <Result>(result: Result): McpRenderField => {
  const details = own(result, "details").value;
  if (details !== undefined && details !== null) return { value: details };
  const text = list(own(result, "content").value, 16).find(
    (entry) => own(entry, "type").value === "text",
  );
  const raw = own(text, "text").value;
  if (!Predicate.isString(raw) || raw.length > 51_200) return { value: undefined };
  try {
    return {
      value: Option.getOrUndefined(Schema.decodeOption(Schema.fromJsonString(Schema.Unknown))(raw)),
    };
  } catch {
    return { value: undefined };
  }
};

export const mcpCallSummary = <Args>(args: Args) => {
  const action = safeText(own(args, "action").value, 64) || "status";
  const server = safeText(own(args, "server").value, 128);
  const target = ["tool", "prompt", "uri", "id"]
    .map((key) => safeText(own(args, key).value, 160))
    .find(Boolean);
  return { action, target: [server, target].filter(Boolean).join(" / ") };
};

const natural = <Value>(value: Value): number | undefined =>
  Predicate.isNumber(value) && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

/** Normalized binary output uses type:attachment descriptors inside content, contents,
 * messages, or structured data, not a second top-level attachment collection. */
const attachments = <Value>(value: Value) => {
  const indices = new Set<number>();
  const seen = new WeakSet<object>();
  let nodes = 0;
  let limited = false;
  const visit = <Current>(current: Current, depth: number): void => {
    if (!Predicate.isObjectOrArray(current) || seen.has(current)) return;
    if (++nodes > MCP_CARD_LIMITS.nodes || depth > MCP_CARD_LIMITS.depth) {
      limited = true;
      return;
    }
    seen.add(current);
    if (own(current, "type").value === "attachment") {
      const index = natural(own(current, "index").value);
      if (index !== undefined) indices.add(index);
      return;
    }
    const length = arrayLength(current);
    if (length !== undefined) {
      if (length > 128) limited = true;
      for (const item of list(current, 128)) visit(item, depth + 1);
      return;
    }
    try {
      let fields = 0;
      for (const key in current) {
        if (++fields > 32 || nodes > MCP_CARD_LIMITS.nodes) {
          limited = true;
          break;
        }
        visit(own(current, key).value, depth + 1);
      }
    } catch {
      limited = true;
    }
  };
  visit(value, 0);
  return { count: indices.size, limited };
};

export const decodeMcpCardDetails = <Result>(result: Result): McpCardDetails => {
  const details = legacyDetails(result).value;
  const { data, payload, page: rawPage, undiscovered, counterKeys } = presentationEvidence(details);
  const currentOutcome = outcome(own(details, "outcome").value);
  const action = safeText(own(details, "action").value, 64) ?? "MCP result";
  const currentError = own(details, "isError").value === true;
  const rawEvidence = { kind: own(data, "kind").value };
  const rawReason = own(data, "reason").value;
  const evidence = Option.getOrUndefined(
    Schema.decodeUnknownOption(failureEvidenceSchema)(
      rawReason === undefined ? rawEvidence : { ...rawEvidence, reason: rawReason },
    ),
  );
  const diagnostic =
    currentError && evidence
      ? mcpDiagnostic({ ...evidence, outcome: currentOutcome ?? "unknown" }, { action })
      : undefined;
  const rawOrigin = own(data, "origin").value;
  const originOutcome = outcome(own(rawOrigin, "outcome").value);
  let origin: McpCardOrigin | undefined;
  if (rawOrigin !== undefined) {
    origin = {
      action: safeText(own(rawOrigin, "action").value, 64) ?? "Original operation",
      isError: own(rawOrigin, "isError").value === true,
      outputValidationFailed: own(rawOrigin, "outputValidation").value === "failed",
      outputValidationUnavailable: own(rawOrigin, "outputValidation").value === "unavailable",
    };
    if (originOutcome) origin = { ...origin, outcome: originOutcome };
  }
  const validationIdentity = presentationValidationIdentity(details, rawOrigin);
  const rawNotices = own(details, "notices").value;
  const noticeCount = arrayLength(rawNotices);
  const noticeEntries = list(rawNotices, 32);
  const noticesComplete =
    noticeCount !== undefined &&
    noticeCount <= 32 &&
    noticeEntries.every((entry) => Predicate.isString(entry) && entry.length <= 512);
  const notices = noticeEntries.flatMap((entry) => {
    if (validationIdentity && isOwnedValidationNotice(entry, validationIdentity)) return [];
    const text = safeText(entry);
    return text ? [text] : [];
  });
  const presentation = projectMcpPresentation(details);
  const warnings = [...presentation.notices];
  if (
    evidence?.reason === "oauth-mutation-unresolved" ||
    evidence?.reason === "oauth-finalization-failed" ||
    evidence?.reason === "oauth-deletion-failed"
  )
    warnings.push(mcpDiagnostic({ ...evidence, outcome: "not-sent" }).explanation);
  const truncated = presentation.truncated;
  const counts: string[] = [];
  const counters: string[] = [];
  const metadata: string[] = [];
  const addCounter = (label: string) => {
    counts.push(label);
    counters.push(label);
  };
  for (const key of counterKeys) {
    const length = arrayLength(own(payload, key).value);
    if (length !== undefined) addCounter(`${length} ${key === "content" ? "content blocks" : key}`);
  }
  const returned = arrayLength(own(rawPage, "items").value);
  const rawTotal = natural(own(rawPage, "total").value);
  const cursor = own(rawPage, "nextCursor").value;
  const page: McpCardPage | undefined =
    returned === undefined
      ? undefined
      : {
          returned,
          total: rawTotal !== undefined && rawTotal >= returned ? rawTotal : undefined,
          hasMore: Predicate.isString(cursor) && cursor.length > 0,
        };
  if (page) {
    addCounter(
      page.total === undefined
        ? `${page.returned} entries returned`
        : `${page.returned} of ${page.total} entries returned`,
    );
    if (page.hasMore) {
      counts.push("more metadata available");
      metadata.push("more metadata available");
    }
  }
  const undiscoveredCount = arrayLength(undiscovered) ?? 0;
  if (undiscoveredCount) addCounter(`${undiscoveredCount} undiscovered servers`);
  const descriptors = attachments(payload);
  const attachmentCount = Math.max(
    descriptors.count,
    arrayLength(own(payload, "attachments").value) ?? (own(data, "attachment").value ? 1 : 0),
  );
  const imageCount = list(own(result, "content").value, 128).filter(
    (item) => own(item, "type").value === "image",
  ).length;
  const resultId = presentation.resultId;
  const historicalText =
    currentOutcome === undefined
      ? list(own(result, "content").value, 128)
          .filter((part) => own(part, "type").value === "text")
          .map((part) => own(part, "text").value)
      : undefined;
  const preview = mcpContentPreview(
    action,
    historicalText?.length ? { details, content: historicalText } : (data ?? details),
    own(data, "result").value !== undefined,
  );
  let projection: McpCardDetails = {
    presentation,
    action,
    isError: currentError,
    known: currentOutcome !== undefined && Predicate.isBoolean(own(details, "isError").value),
    counts,
    counters,
    metadata,
    notices,
    noticesComplete,
    warnings,
    truncated,
    displayCuts: preview.cuts,
    hasCompleteReadableText: preview.readable !== undefined && preview.readableCuts.length === 0,
    attachmentCount,
    attachmentsLimited: descriptors.limited,
    imageCount,
    undiscoveredCount,
    failurePreview: preview.readable ?? preview.combined,
    preview:
      details === undefined
        ? `Details are unavailable for this historical result.\n${preview.combined}`
        : preview.combined,
  };
  if (currentOutcome) projection = { ...projection, outcome: currentOutcome };
  if (origin) projection = { ...projection, origin };
  if (page) projection = { ...projection, page };
  if (diagnostic && evidence)
    projection = {
      ...projection,
      diagnostic,
      failureKind: evidence.kind,
      failureReason: evidence.reason,
    };
  if (action === "result.read" && currentOutcome === "completed" && !currentError) {
    const offset = natural(own(data, "offset").value);
    const total = natural(own(data, "total").value);
    const next = own(data, "next").value;
    const text = own(data, "text").value;
    const end = offset !== undefined && Predicate.isString(text) ? offset + text.length : undefined;
    if (
      offset !== undefined &&
      end !== undefined &&
      Number.isSafeInteger(end) &&
      total !== undefined &&
      end <= total &&
      (next === null
        ? end === total
        : natural(next) !== undefined && next === end && end > offset && end < total)
    ) {
      projection = {
        ...projection,
        retainedPage: { offset, end, total, next: next === null ? null : end },
      };
    }
  }
  if (resultId !== undefined)
    projection = { ...projection, resultId, recoveryHint: `/mcp result ${resultId}` };
  else if (diagnostic?.recovery.length)
    projection = { ...projection, recoveryHint: "Open /mcp to inspect current server details." };
  return projection;
};
