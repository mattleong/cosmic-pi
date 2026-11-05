import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import { ACTIVITY_LIMITS, type ActivityDetail, type ActivityItem } from "pi-cosmic-ui/activity";
import { countLabel } from "pi-cosmic-core/display";
import { sanitizeDiagnosticContent } from "pi-cosmic-core/security";
import { sha256Text } from "pi-cosmic-core/security/sha256";
import { runCleanupAttention } from "../run/attention.ts";
import { userRunText } from "../run/warnings.ts";
import {
  isActiveRunState,
  type SubagentProjection,
  type SubagentRunState,
  type SubagentRunView,
} from "../run/model.ts";
import {
  EMPTY_ACTIVITY_PRESENTATION,
  type SubagentActivityPresentationSnapshot,
} from "./activity-panel.ts";
import { runActivityDetail } from "./run-activity-detail.ts";
import { projectRunModel } from "./run-presentation.ts";
import { isWaitingOnRuns, runLiveActivity, type RunNameLookup } from "./run-live-activity.ts";
import {
  canInterruptRun,
  canRenameRun,
  canResumeRun,
  canStopRun,
  runMessageMode,
  type RunMessageMode,
} from "./run-state.ts";
import { projectFleetTree } from "./run-tree-rows.ts";
export const SUBAGENT_ACTIVITY_PROVIDER = "pi-subagents";

type UnrevisionedItem<Item extends ActivityItem = ActivityItem> = Item extends ActivityItem
  ? Omit<Item, "revision">
  : never;

const withActivityRevision = (item: UnrevisionedItem, identity = ""): ActivityItem =>
  Object.freeze({
    ...item,
    revision: Fn.pipe(sha256Text(JSON.stringify([identity, item])), Str.slice(0, 32)),
  } satisfies ActivityItem);

const RUN_STATUS = {
  starting: "pending",
  running: "running",
  waiting_for_parent: "needs-input",
  paused: "paused",
  completed: "done",
  failed: "failed",
  stopping: "stopping",
  stopped: "cancelled",
} satisfies Readonly<Record<SubagentRunState, ActivityItem["status"]>>;

function activityAttention(run: SubagentRunView) {
  const cleanup = runCleanupAttention(run);
  if (cleanup !== undefined) return { status: "blocked", blockedReason: "parent-review" } as const;
  if (run.state === "waiting_for_parent")
    return { status: "needs-input", inputTarget: "parent" } as const;
  return { status: RUN_STATUS[run.state] } as const;
}

const handoff = (id: string, label: string) => ({ id, label, handoff: true as const });

const MESSAGE_ACTIONS = {
  reply: handoff("reply", "Reply"),
  guidance: handoff("message", "Message"),
} satisfies Readonly<Record<RunMessageMode, ReturnType<typeof handoff>>>;

/** Stopping a run stops its subtree, so the confirmation counts the active runs beneath it. */
const stopConfirmation = (title: string, activeDescendants: number): string =>
  activeDescendants > 0
    ? `Stop "${title}" and its ${countLabel(activeDescendants, "subagent")}?`
    : `Stop "${title}"?`;

export function runActions(run: SubagentRunView, title: string, activeDescendants = 0) {
  const mode = runMessageMode(run);
  return [
    ...(isActiveRunState(run.state) || canStopRun(run)
      ? [
          {
            id: "stop",
            label: isActiveRunState(run.state) ? "Stop" : "Verify cleanup",
            confirmation: isActiveRunState(run.state)
              ? stopConfirmation(title, activeDescendants)
              : `Verify cleanup for "${title}" and stop any active subagents?`,
            handoff: false as const,
          },
        ]
      : []),
    ...(canInterruptRun(run)
      ? [
          {
            id: "interrupt",
            label: "Interrupt",
            confirmation: `Interrupt "${title}"? Its subagents keep running.`,
            handoff: false as const,
          },
        ]
      : []),
    ...(canResumeRun(run) ? [handoff("resume", "Resume")] : []),
    ...(mode && (mode !== "reply" || run.question) ? [MESSAGE_ACTIONS[mode]] : []),
    ...(canRenameRun(run) ? [handoff("rename", "Rename")] : []),
  ];
}

const runIdentity = (run: SubagentRunView): string =>
  JSON.stringify([
    run.assignmentEpoch,
    run.reportGeneration,
    run.sessionId ?? null,
    run.question?.requestId ?? null,
    run.cleanup ?? null,
    run.writerCleanupQuarantined ?? null,
  ]);

const runSummary = (run: SubagentRunView, nameOf: RunNameLookup): Pick<ActivityItem, "summary"> => {
  const reason = run.state === "failed" ? userRunText(run).error : undefined;
  const cleanup = runCleanupAttention(run);
  const summary =
    cleanup === "quarantined"
      ? "Couldn't confirm its processes ended; the task outcome is unchanged"
      : cleanup === "pool-quarantined"
        ? "New writers wait until an earlier writer's cleanup is confirmed"
        : reason
          ? Str.split(reason, "\n")[0]
          : (runLiveActivity(run, nameOf) ?? run.progress);
  return summary
    ? { summary: sanitizeDiagnosticContent(summary, { maximumLength: ACTIVITY_LIMITS.text }) }
    : {};
};

const cleanModelText = (text: string) =>
  sanitizeDiagnosticContent(text, { maximumLength: ACTIVITY_LIMITS.model });

const runModelFields = (run: SubagentRunView): Pick<ActivityItem, "model" | "modelDetail"> => {
  const { model, detail } = projectRunModel(run);
  return { model: cleanModelText(model), ...(detail && { modelDetail: cleanModelText(detail) }) };
};

const runActivityItem = (
  run: SubagentRunView,
  awaited: boolean,
  nameOf: RunNameLookup,
  activeDescendants: number,
): ActivityItem => {
  const title = sanitizeDiagnosticContent(run.name, { maximumLength: ACTIVITY_LIMITS.title });
  return withActivityRevision(
    {
      id: run.id,
      kind: "agent" as const,
      title,
      ...activityAttention(run),
      awaited,
      startedAt: run.startedAt,
      updatedAt: run.lastActivityAt,
      ...runSummary(run, nameOf),
      actions: Object.freeze(
        Arr.map(runActions(run, title, activeDescendants), (action) => Object.freeze(action)),
      ),
      ...runModelFields(run),
      ...(run.profile !== undefined && { profile: run.profile }),
      ...(run.endedAt !== undefined && { endedAt: run.endedAt }),
      ...(run.parentRunId &&
        run.parentRunId !== "root" && {
          parent: Object.freeze({
            providerId: SUBAGENT_ACTIVITY_PROVIDER,
            itemId: run.parentRunId,
          }),
        }),
    },
    runIdentity(run),
  );
};

interface CachedActivityItem {
  readonly item: ActivityItem;
  readonly activeDescendants: number;
}

interface CachedActivityItems {
  readonly awaited?: CachedActivityItem;
  readonly idle?: CachedActivityItem;
}

// Projections keep an unchanged run's frozen view, so its item is built once per change.
const activityItemCache = new WeakMap<SubagentRunView, CachedActivityItems>();

const cachedRunActivityItem = (
  run: SubagentRunView,
  awaited: boolean,
  nameOf: RunNameLookup,
  activeDescendants: number,
): ActivityItem => {
  // A run waiting on others names them, so its item follows their names, not only its own view.
  if (!Object.isFrozen(run) || isWaitingOnRuns(run))
    return runActivityItem(run, awaited, nameOf, activeDescendants);
  const cached = activityItemCache.get(run);
  const hit = awaited ? cached?.awaited : cached?.idle;
  // The stop confirmation counts the subtree, which changes without this run's view changing.
  if (hit?.activeDescendants === activeDescendants) return hit.item;
  const item = runActivityItem(run, awaited, nameOf, activeDescendants);
  const entry = { item, activeDescendants };
  activityItemCache.set(run, awaited ? { ...cached, awaited: entry } : { ...cached, idle: entry });
  return item;
};

/** The number of active runs beneath each run, counted once per ancestor. */
const activeDescendantCounts = (
  runs: ReadonlyArray<SubagentRunView>,
): ReadonlyMap<string, number> => {
  const parents = new Map(Arr.map(runs, (run) => [run.id, run.parentRunId] as const));
  const counts = new Map<string, number>();
  for (const run of runs) {
    if (!isActiveRunState(run.state)) continue;
    const seen = new Set([run.id]);
    let parent = parents.get(run.id);
    while (parent !== undefined && parent !== "root" && !seen.has(parent)) {
      seen.add(parent);
      counts.set(parent, (counts.get(parent) ?? 0) + 1);
      parent = parents.get(parent);
    }
  }
  return counts;
};

export function subagentActivityItems(
  projection: SubagentProjection,
  presentation: SubagentActivityPresentationSnapshot = EMPTY_ACTIVITY_PRESENTATION,
): readonly ActivityItem[] {
  const awaited = new Set(Arr.flatMap(presentation.awaits, (lease) => lease.runIds));
  const rows = projectFleetTree(projection.runs, "root").rows;
  const names = new Map(Arr.map(projection.runs, (run) => [run.id, run.name] as const));
  const nameOf: RunNameLookup = (id) => names.get(id);
  const descendants = activeDescendantCounts(projection.runs);
  const runs = Arr.map(rows, ({ run }) =>
    cachedRunActivityItem(run, awaited.has(run.id), nameOf, descendants.get(run.id) ?? 0),
  );
  return Object.freeze(runs.slice(0, ACTIVITY_LIMITS.items));
}

export function subagentActivityDetail(
  projection: SubagentProjection,
  id: string,
): ActivityDetail | undefined {
  const run = Option.getOrUndefined(
    Arr.findFirst(projectFleetTree(projection.runs, "root").rows, (row) => row.run.id === id),
  )?.run;
  if (!run) return undefined;
  const names = new Map(
    Arr.map(projection.runs, (candidate) => [candidate.id, candidate.name] as const),
  );
  return runActivityDetail(run, (runId) => names.get(runId));
}
