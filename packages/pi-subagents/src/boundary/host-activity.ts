import {
  registerRevisionedActivityProvider,
  type ActivityEvents,
  type ActivityItem,
} from "pi-cosmic-ui/activity";
import { sanitizeDiagnosticContent } from "pi-cosmic-core";
import { projectFleetTree } from "../ui/run-tree-rows.ts";
import {
  isActiveRunState,
  isParentActionRequiredRun,
  type SubagentProjection,
  type SubagentRunState,
  type SubagentRunView,
} from "../run/model.ts";
import {
  emptyActivityPresentation,
  type SubagentActivityPresentationSnapshot,
} from "../ui/activity-panel.ts";
import type { SubagentProjectionBridge } from "./host-ui.ts";
import { formatRunRoute } from "../ui/run-presentation.ts";
import { runStateLabel } from "../ui/run-state.ts";

const PROVIDER = "pi-subagents";
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

function runAttention(run: SubagentRunView) {
  if (run.writeAdmissionPaused) {
    // An older question does not make active claim containment ready for parent recovery.
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

export function subagentActivityItems(
  projection: SubagentProjection,
  presentation: SubagentActivityPresentationSnapshot = emptyActivityPresentation(),
): readonly ActivityItem[] {
  const awaited = new Set(presentation.awaits.flatMap((lease) => lease.runIds));
  const runs = projectFleetTree(projection.runs, "root", new Set()).rows.map(({ run }) => {
    const title = sanitizeDiagnosticContent(run.name, { maximumLength: 512 });
    return Object.freeze({
      id: run.id,
      kind: "agent" as const,
      title,
      ...runAttention(run),
      revision: `${projection.revision}:${presentation.revision}`,
      awaited: awaited.has(run.id),
      startedAt: run.startedAt,
      updatedAt: run.lastActivityAt,
      summary: sanitizeDiagnosticContent(
        `${runStateLabel(run.state)} · ${run.currentTool ?? run.progress ?? run.runtime}`,
        { maximumLength: 4096 },
      ),
      actions: Object.freeze(
        [
          ...(isActiveRunState(run.state)
            ? [
                {
                  id: "stop",
                  label: "Stop",
                  confirmation: `Stop "${title}" and all its subagents?`,
                },
              ]
            : []),
          ...(run.state === "running" && run.capabilities.includes("interrupt")
            ? [
                {
                  id: "interrupt",
                  label: "Interrupt",
                  confirmation: `Interrupt "${title}"? Its subagents keep running.`,
                },
              ]
            : []),
          ...(run.state === "paused" &&
          !run.writeAdmissionPaused &&
          run.capabilities.includes("resume")
            ? [{ id: "resume", label: "Resume" }]
            : []),
        ].map((action) => Object.freeze(action)),
      ),
      route: sanitizeDiagnosticContent(formatRunRoute(run), { maximumLength: 512 }),
      ...(run.profile !== undefined && { profile: run.profile }),
      ...(run.endedAt !== undefined && { endedAt: run.endedAt }),
      ...(run.parentRunId &&
        run.parentRunId !== "root" && {
          parent: Object.freeze({ providerId: PROVIDER, itemId: run.parentRunId }),
        }),
    } satisfies ActivityItem);
  });
  return Object.freeze(runs);
}

export function subagentActivityDetail(
  projection: SubagentProjection,
  id: string,
): string | undefined {
  const run = projectFleetTree(projection.runs, "root", new Set()).rows.find(
    (row) => row.run.id === id,
  )?.run;
  if (!run) return undefined;
  return sanitizeDiagnosticContent(
    [
      sanitizeDiagnosticContent(`${run.name}: ${run.state}`, { maximumLength: 512 }),
      sanitizeDiagnosticContent(`${run.host}/${run.runtime} · ${run.model}`, {
        maximumLength: 512,
      }),
      sanitizeDiagnosticContent(run.task, { maximumLength: 4_000 }),
      sanitizeDiagnosticContent(run.finalText ?? run.error ?? run.progress ?? "", {
        maximumLength: 10_000,
      }),
      run.question
        ? `Question for parent: ${sanitizeDiagnosticContent(run.question.message, { maximumLength: 2_000 })}`
        : "",
    ].join("\n\n"),
    { maximumLength: 16_384 },
  );
}

/** Root session only. No parent-contact message is promoted to a user question. */
export function registerSubagentActivity(options: {
  readonly events: ActivityEvents;
  readonly sessionId: string;
  readonly bridge: SubagentProjectionBridge;
  readonly isCurrent: () => boolean;
  readonly act: (
    id: string,
    action: "stop" | "interrupt" | "resume",
    signal: AbortSignal,
  ) => Promise<void>;
}): () => void {
  const dispose = registerRevisionedActivityProvider(options.events, {
    sessionId: options.sessionId,
    providerId: PROVIDER,
    isCurrent: options.isCurrent,
    items: () =>
      subagentActivityItems(options.bridge.get(), options.bridge.getActivityPresentation()),
    starting: () =>
      options.bridge
        .getActivityPresentation()
        .starts.reduce((total, lease) => total + lease.requestedCount, 0),
    detail: (item) => subagentActivityDetail(options.bridge.get(), item.id) ?? item.title,
    act: (item, action, signal) => {
      if (action !== "stop" && action !== "interrupt" && action !== "resume")
        throw new Error("Subagent action is unavailable.");
      return options.act(item.id, action, signal);
    },
    subscriptions: [options.bridge.subscribe, options.bridge.subscribeActivityPresentation],
    onAvailability: (available, current) =>
      options.bridge.setActivityAvailable(current() && available),
  });
  return () => {
    dispose();
    options.bridge.setActivityAvailable(false);
  };
}
