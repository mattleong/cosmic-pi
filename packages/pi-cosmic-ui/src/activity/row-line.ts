import type { Theme } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { formatElapsed } from "pi-cosmic-core/display";
import {
  managerActivityColor,
  managerActivityGlyph,
  managerActivityMeaning,
  managerNoticeColor,
  managerNoticeGlyph,
  clipToWidth,
  spinnerFrameAt,
  withoutStatusGlyphWords,
  type ManagerStatusColor,
  type StatusGlyphMeaning,
} from "../manager/chrome.ts";
import {
  activityAttention,
  activityAttentionColor,
  activityAttentionLabels,
  activityAttentionCounts,
  activityAwaitingTurn,
  activityQueued,
  activityStatus,
  addAttention,
  emptyAttention,
  type ActivityAttentionCounts,
} from "./attention.ts";
import { isFinished, type ActivityRow } from "./model.ts";
import type { GroupedActivityRow } from "./grouped-tree.ts";
import { renderActivityRowLines, STATUS_DROP, type ActivityStatusPart } from "./row-render.ts";

const REASON_WIDTH = 32;
const REASON_MINIMUM_WIDTH = 10;

export interface ActivityMark {
  readonly glyph: string;
  readonly color: ManagerStatusColor;
  /** What the glyph says in words, which the row then leaves out of its status. */
  readonly meaning: StatusGlyphMeaning | undefined;
}
export const activityMark = (row: ActivityRow, now = 0): ActivityMark => {
  if (row.status === "needs-input")
    return {
      glyph: managerNoticeGlyph("attention"),
      color: managerNoticeColor("attention"),
      meaning: undefined,
    };
  if (row.status === "blocked")
    return { glyph: managerNoticeGlyph("warning"), color: "warning", meaning: undefined };
  // Queued work and questions waiting their turn share the suite's single queued glyph.
  if (activityAwaitingTurn(row)) return { glyph: "○", color: "muted", meaning: "queued" };
  const kind = row.status === "cancelled" ? "stopped" : row.status;
  return {
    glyph: managerActivityGlyph(kind, spinnerFrameAt(now)),
    color: managerActivityColor(kind),
    meaning: managerActivityMeaning(kind),
  };
};
/** Longer spans come from a skewed clock or a missing start, such as `startedAt: 1`, not real work. */
const MAX_ACTIVITY_SPAN = 7 * 24 * 60 * 60 * 1_000;

/** The span between two activity times, or `undefined` when it is negative or implausibly long. */
export const activitySpan = (later: number, earlier: number): number | undefined => {
  const span = later - earlier;
  return Number.isFinite(span) && span >= 0 && span <= MAX_ACTIVITY_SPAN ? span : undefined;
};

export const activityElapsed = (row: ActivityRow, now?: number, compact = false): string => {
  if (row.startedAt === undefined) return "";
  const elapsed = activitySpan(row.endedAt ?? now ?? row.updatedAt ?? row.startedAt, row.startedAt);
  if (elapsed === undefined) return "";
  const text = formatElapsed(elapsed);
  return compact ? Str.split(text, " ")[0] : text;
};
/** An agent's model with what qualifies it, as `provider/model:effort ⚡ (fallback)`. */
export const activityModelLabel = (
  row: Pick<ActivityRow, "model" | "modelDetail">,
): string | undefined =>
  row.model ? (row.modelDetail ? `${row.model}:${row.modelDetail}` : row.model) : undefined;

/** An agent's profile and the model it runs on, joined as `scout → provider/model:effort`. */
export const activityAgentIdentity = (
  row: Pick<ActivityRow, "profile" | "model" | "modelDetail">,
): string | undefined => {
  const model = activityModelLabel(row);
  return row.profile && model ? `${row.profile} → ${model}` : (row.profile ?? model);
};

// Agents name their profile instead; a question's glyph and status already say what it is.
const activityTypes = { agent: "subagent", command: "task", question: "" } as const;
// The manager's `Tasks` and `Subagents` headings already name their rows' kind; the widget has none.
const activityType = (
  entry: Extract<GroupedActivityRow, { readonly type: "member" }>,
  interactive: boolean,
): string => (interactive && entry.kindSection ? "" : activityTypes[entry.row.kind]);

export interface RowPaint {
  readonly now?: number | undefined;
  readonly theme?: Pick<Theme, "fg">;
}

const memberReason = (row: ActivityRow, widget: boolean): string | undefined =>
  (widget && row.status === "failed") || (row.status === "cancelled" && row.startedAt === undefined)
    ? row.summary === undefined
      ? undefined
      : Str.trim(row.summary)
    : undefined;

// A hidden request that offers Resume says how to get back to it, in its producer's words.
const resumeHint = (row: ActivityRow): string | undefined =>
  row.status === "needs-input" &&
  row.summary !== undefined &&
  Str.isNonEmpty(Str.trim(row.summary)) &&
  Arr.some(row.actions ?? [], (action) => action.id === "resume")
    ? Str.trim(row.summary)
    : undefined;

// A row states in words only what its glyph doesn't: `needs your input` beside `?` and a blocked
// reason beside `⚠` stay, while `failed`, `paused`, and `queued` are already their glyphs.
const memberAttention = (
  row: ActivityRow,
  meaning: StatusGlyphMeaning | undefined,
  widget: boolean,
): string =>
  (widget ? resumeHint(row) : undefined) ??
  (activityAttention(row) !== undefined ||
  row.status === "failed" ||
  row.status === "paused" ||
  activityQueued(row)
    ? (withoutStatusGlyphWords(activityStatus(row), meaning) ?? "")
    : "");

/**
 * A folded branch's attention, one part per kind. Input the user owes stays longest; parent waits
 * give way first, since the waiting agent's own row says so once the branch opens.
 */
const warningParts = (counts: ActivityAttentionCounts): ActivityStatusPart[] =>
  Arr.flatMap(
    [
      ["user", undefined],
      ["parent", STATUS_DROP.elapsed],
      ["blocked", STATUS_DROP.state],
      ["failed", STATUS_DROP.state],
    ] as const,
    ([kind, drop]) =>
      Arr.map(activityAttentionLabels({ ...emptyAttention, [kind]: counts[kind] }), (text) => ({
        text,
        ...(drop !== undefined && { drop }),
      })),
  );

const memberStatus = (
  row: ActivityRow,
  {
    warnings,
    attention,
    reason,
  }: { warnings: ActivityStatusPart[]; attention: string; reason: string },
  width: number,
  now: number | undefined,
): ActivityStatusPart[] => {
  if (warnings.length) return warnings;
  if (reason)
    return [
      { text: attention, drop: STATUS_DROP.progress },
      { text: reason, drop: STATUS_DROP.state, clip: REASON_MINIMUM_WIDTH },
    ];
  const elapsed = activityElapsed(row, now, width < 60);
  // An ended row's glyph says how it ended, so its bare duration reads as its run time.
  if (isFinished(row)) return [{ text: elapsed, drop: STATUS_DROP.elapsed }];
  // A row waiting for its parent's reply keeps its elapsed time when cramped; its `?` glyph still
  // says it is waiting.
  const waitWord = activityAttention(row) === "parent" ? { drop: STATUS_DROP.waitWord } : {};
  return [
    { text: attention, ...waitWord },
    { text: elapsed, lead: attention ? "· " : "", drop: STATUS_DROP.elapsed },
  ];
};

/** What running work is doing now, in its producer's words, when that adds to its status. */
const liveActivity = (row: ActivityRow): string | undefined => {
  if (row.status !== "running" || row.summary === undefined) return undefined;
  const summary = Str.trim(Str.split(row.summary, "\n")[0] ?? "");
  return summary && Str.toLowerCase(summary) !== Str.toLowerCase(activityStatus(row))
    ? summary
    : undefined;
};

/** A member row's lines: one in the widget, and in the manager two when its identity wraps. */
export function groupedMemberLines(
  entry: Extract<GroupedActivityRow, { readonly type: "member" }>,
  width: number,
  options: RowPaint,
  presentation: "manager" | "widget",
  focusedStyle?: (text: string) => string,
): readonly string[] {
  const { row } = entry;
  const interactive = presentation === "manager";
  const descendants = addAttention(entry.summary.attention, activityAttentionCounts(row), -1);
  const warnings = entry.expanded ? [] : warningParts(descendants);
  const { glyph, color, meaning } = activityMark(row, options.now);
  const attention = memberAttention(row, meaning, !interactive);
  const ended = memberReason(row, !interactive);
  const reason = ended
    ? clipToWidth(ended, Math.min(REASON_WIDTH, Math.floor(width / 3)), "…")
    : "";
  const status = memberStatus(row, { warnings, attention, reason }, width, options.now);
  return renderActivityRowLines(
    {
      kind: activityType(entry, interactive),
      title: row.title,
      continuations: entry.continuations,
      children: entry.children,
      expanded: entry.expanded,
      glyph,
      color,
      status,
      statusSeparator: reason || warnings.length ? " · " : " ",
      statusColor: warnings.length
        ? activityAttentionColor(descendants)
        : !interactive && !attention && !reason
          ? "muted"
          : color,
      ...(entry.history && { history: true }),
      ...(row.kind === "agent" && row.profile && { profile: row.profile }),
      ...(row.kind === "agent" &&
        row.model && {
          model: { name: row.model, label: activityModelLabel(row) ?? row.model },
        }),
      ...(row.awaited && { awaited: true }),
      ...(row.omittedChildren && { omittedChildren: row.omittedChildren }),
      ...(!interactive && { activity: liveActivity(row) }),
    },
    width,
    options.theme,
    presentation,
    focusedStyle,
  );
}
