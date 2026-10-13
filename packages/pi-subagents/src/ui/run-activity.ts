import { ACTIVITY_LIMITS, type ActivityItem } from "pi-cosmic-ui/activity";
import { sanitizeDiagnosticContent } from "pi-cosmic-core";
import {
  isActiveRunState,
  isParentActionRequiredRun,
  type SubagentProjection,
  type SubagentRunState,
  type SubagentRunView,
} from "../run/model.ts";
import {
  EMPTY_ACTIVITY_PRESENTATION,
  type SubagentActivityPresentationSnapshot,
} from "./activity-panel.ts";
import { withActivityRevision } from "./activity-revision.ts";
import { runActivityDetail } from "./run-activity-detail.ts";
import { formatRunRoute } from "./run-presentation.ts";
import {
  canInterruptRun,
  canRenameRun,
  canResumeRun,
  runMessageMode,
  type RunMessageMode,
} from "./run-state.ts";
import { projectFleetTree } from "./run-tree-rows.ts";
export const SUBAGENT_ACTIVITY_PROVIDER = "pi-subagents";

const RUN_STATUS = {
  starting: "pending",
  running: "running",
  waiting_for_parent: "blocked",
  paused: "blocked",
  reported: "done",
  completed: "done",
  failed: "failed",
  stopping: "stopping",
  stopped: "cancelled",
} satisfies Readonly<Record<SubagentRunState, ActivityItem["status"]>>;

function activityAttention(run: SubagentRunView) {
  if (run.writeAdmissionPaused) {
    const blockedReason = run.writeViolationOffender
      ? isParentActionRequiredRun({ ...run, question: undefined })
        ? "file-access-review"
        : "write-containment"
      : "file-access";
    return { status: "blocked", blockedReason } as const;
  }
  if (run.state === "waiting_for_parent" && run.question !== undefined)
    return { status: "needs-input", inputTarget: "parent" } as const;
  if (run.state === "paused" || run.state === "waiting_for_parent")
    return { status: "blocked", blockedReason: "parent-review" } as const;
  return { status: RUN_STATUS[run.state] } as const;
}

const handoff = (id: string, label: string) => ({ id, label, handoff: true as const });

const MESSAGE_ACTIONS = {
  reply: handoff("reply", "Reply"),
  guidance: handoff("message", "Message"),
} satisfies Readonly<Record<RunMessageMode, ReturnType<typeof handoff>>>;

export function runActions(run: SubagentRunView, title: string) {
  const mode = run.writeAdmissionPaused ? undefined : runMessageMode(run);
  return [
    ...(isActiveRunState(run.state)
      ? [
          {
            id: "stop",
            label: "Stop",
            confirmation: `Stop "${title}" and all its subagents?`,
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
    ...(canResumeRun(run) && !run.writeAdmissionPaused ? [handoff("resume", "Resume")] : []),
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
  ]);

const runSummary = (run: SubagentRunView): Pick<ActivityItem, "summary"> => {
  const reason = run.state === "failed" ? run.error : undefined;
  const summary = reason ? reason.split("\n", 1)[0] : (run.currentTool ?? run.progress);
  return summary
    ? { summary: sanitizeDiagnosticContent(summary, { maximumLength: ACTIVITY_LIMITS.text }) }
    : {};
};

export function subagentActivityItems(
  projection: SubagentProjection,
  presentation: SubagentActivityPresentationSnapshot = EMPTY_ACTIVITY_PRESENTATION,
): readonly ActivityItem[] {
  const awaited = new Set(presentation.awaits.flatMap((lease) => lease.runIds));
  const rows = projectFleetTree(projection.runs, "root").rows;
  const runs = rows.map(({ run }) => {
    const title = sanitizeDiagnosticContent(run.name, { maximumLength: ACTIVITY_LIMITS.title });
    return withActivityRevision(
      {
        id: run.id,
        kind: "agent" as const,
        title,
        ...activityAttention(run),
        awaited: awaited.has(run.id),
        startedAt: run.startedAt,
        updatedAt: run.lastActivityAt,
        ...runSummary(run),
        actions: Object.freeze(runActions(run, title).map((action) => Object.freeze(action))),
        route: sanitizeDiagnosticContent(formatRunRoute(run), {
          maximumLength: ACTIVITY_LIMITS.route,
        }),
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
  });
  return Object.freeze(runs.slice(0, ACTIVITY_LIMITS.items));
}

export function subagentActivityDetail(
  projection: SubagentProjection,
  id: string,
): string | undefined {
  const run = projectFleetTree(projection.runs, "root").rows.find((row) => row.run.id === id)?.run;
  return run && runActivityDetail(run);
}
