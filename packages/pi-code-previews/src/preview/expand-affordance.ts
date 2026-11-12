import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Predicate from "effect/Predicate";
import * as Rec from "effect/Record";
import * as Str from "effect/String";
import { stripTerminalControls } from "pi-cosmic-core/security";
import * as Struct from "effect/Struct";
import type {
  CompactPhase,
  CompactSummary,
  CompactSummaryProvider,
} from "../tools/compact-summary";
import type { HostObject } from "../shared/untrusted-value";
import { repeatsIssueMessage } from "./compact-issues";
export { isAffordanceRow, showsAffordance } from "./affordance-row";

const visiblePart = (part: AgentToolResult<unknown>["content"][number]) =>
  part.type === "image" || Str.isNonEmpty(Str.trim(part.text));

/** Whether a result has content someone would see; an empty partial update has none. */
const showsContent = (result: AgentToolResult<unknown> | undefined): boolean =>
  result !== undefined && Arr.some(result.content, visiblePart);

/** Issues whose expansion adds something: routine information, or detail beyond the message. */
const hidesIssueDetail = (summary: CompactSummary): boolean =>
  Arr.some(
    summary.issues ?? [],
    (issue) =>
      issue.severity === "info" ||
      (issue.detail !== undefined && !repeatsIssueMessage(issue.detail, [issue])),
  );

/** A failed result's content is its error; anything else is output. */
const contentLabel = (summary: CompactSummary): string =>
  summary.outcome === "error" ? "error" : "output";

/** The producer's declaration: a label, `false` for nothing to reveal, or undefined to infer. */
const declared = (summary: CompactSummary): string | false | undefined =>
  summary.expandLabel === undefined || summary.expandLabel === false
    ? summary.expandLabel
    : Str.isNonEmpty(Str.trim(summary.expandLabel))
      ? summary.expandLabel
      : undefined;

/**
 * A provider for a tool whose preview bodies show its arguments and output and draw their own hints
 * for what they clip, so the summary's `expandLabel` names what a compact row hides. In preview
 * style the label is dropped, and a row that didn't fail and keeps no issue detail for expansion
 * declares that expansion reveals nothing more.
 */
export function previewBodiesShowContent<TArgs, TDetails, TState>(
  provider: CompactSummaryProvider<TArgs, TDetails, TState>,
  style: "compact" | "preview",
): CompactSummaryProvider<TArgs, TDetails, TState> {
  if (style === "compact") return provider;
  return (input) => {
    const summary = provider(input);
    if (summary === undefined) return undefined;
    const quiet = summary.outcome !== "error" && !hidesIssueDetail(summary);
    return quiet ? { ...summary, expandLabel: false } : Struct.omit(summary, ["expandLabel"]);
  };
}

/**
 * What expanding a collapsed compact row reveals: the producer's `expandLabel`, else the result's
 * visible content (`output`), else issues kept for expansion or, before the call settles, its
 * arguments (`details`). A partial result without visible content counts as no result. A settled
 * row always offers the call tree its collapsed row hides (`calls`), whatever it declares.
 * Undefined when expansion adds nothing.
 */
export function compactExpandLabel(
  summary: CompactSummary,
  phase: CompactPhase,
  result: AgentToolResult<unknown> | undefined,
  input: HostObject | undefined,
): string | undefined {
  const label = declared(summary);
  if (Predicate.isString(label)) return label;
  if (phase === "settled" && (summary.children?.total ?? 0) > 0) return "calls";
  if (label === false) return undefined;
  if (showsContent(result)) return contentLabel(summary);
  const pendingInput = phase !== "settled" && input !== undefined && Rec.keys(input).length > 0;
  return hidesIssueDetail(summary) || pendingInput ? "details" : undefined;
}

/**
 * What expanding a collapsed preview row reveals. Preview bodies show their arguments and output,
 * so without a declaration only a result the collapsed body leaves out (`output`, or `error` for a
 * failure) or else issues kept for expansion (`details`) count. Like a compact row, a hidden result
 * names the affordance before issue detail does.
 */
export function previewExpandLabel(
  summary: CompactSummary,
  result: AgentToolResult<unknown> | undefined,
  resultShown: boolean,
): string | undefined {
  const label = declared(summary);
  if (label !== undefined) return label === false ? undefined : label;
  if (showsContent(result) && !resultShown) return contentLabel(summary);
  return hidesIssueDetail(summary) ? "details" : undefined;
}

/** Whether drawn rows show anything. */
export const drawsRows = (rows: readonly string[]): boolean =>
  Arr.some(rows, (row) => Str.isNonEmpty(Str.trim(stripTerminalControls(row))));
