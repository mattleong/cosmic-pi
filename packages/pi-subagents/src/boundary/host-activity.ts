import {
  registerActivityProvider,
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
import { projectRunRoutePresentation } from "../ui/run-presentation.ts";

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
    const item: ActivityItem = {
      id: run.id,
      kind: "agent" as const,
      title: sanitizeDiagnosticContent(run.name, { maximumLength: 512 }),
      ...runAttention(run),
      revision: `${projection.revision}:${presentation.revision}`,
      awaited: awaited.has(run.id),
      startedAt: run.startedAt,
      updatedAt: run.lastActivityAt,
      summary: sanitizeDiagnosticContent(
        `${run.state} · ${run.currentTool ?? run.progress ?? run.runtime}`,
        { maximumLength: 4096 },
      ),
      actions: Object.freeze(
        [
          ...(isActiveRunState(run.state)
            ? [
                {
                  id: "stop",
                  label: "Stop",
                  confirmation: `Stop ${run.id} and all its descendants?`,
                },
              ]
            : []),
          ...(run.state === "running" && run.capabilities.includes("interrupt")
            ? [
                {
                  id: "interrupt",
                  label: "Interrupt",
                  confirmation: `Interrupt ${run.id}? Its descendants will continue running.`,
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
    };
    const route = projectRunRoutePresentation(run);
    Object.assign(item, {
      route: sanitizeDiagnosticContent(`${route.hostRuntime} · ${route.model}`, {
        maximumLength: 512,
      }),
    });
    if (run.profile !== undefined) Object.assign(item, { profile: run.profile });
    if (run.endedAt !== undefined) Object.assign(item, { endedAt: run.endedAt });
    if (run.parentRunId && run.parentRunId !== "root")
      return Object.freeze({
        ...item,
        parent: Object.freeze({ providerId: PROVIDER, itemId: run.parentRunId }),
      });
    return Object.freeze(item);
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
  let live = true;
  const current = () => live && options.isCurrent();
  const snapshot = () =>
    subagentActivityItems(options.bridge.get(), options.bridge.getActivityPresentation());
  const lookup = (id: string, revision: string) => {
    if (!current()) throw new Error("Subagents session was replaced.");
    const item = snapshot().find((item) => item.id === id && item.revision === revision);
    if (!item) throw new Error("Subagent activity changed.");
    return item;
  };
  const registration = registerActivityProvider(options.events, {
    sessionId: options.sessionId,
    providerId: PROVIDER,
    snapshot: () => (current() ? snapshot() : []),
    starting: () =>
      current()
        ? options.bridge
            .getActivityPresentation()
            .starts.reduce((total, lease) => total + lease.requestedCount, 0)
        : 0,
    getDetail: (id, revision, signal) =>
      Promise.resolve().then(() => {
        if (signal.aborted) throw new Error("Activity detail request was cancelled.");
        const item = lookup(id, revision);
        return subagentActivityDetail(options.bridge.get(), id) ?? item.title;
      }),
    invoke: (id, action, revision, signal) =>
      Promise.resolve().then(() => {
        if (signal.aborted) throw new Error("Activity action was cancelled.");
        const item = lookup(id, revision);
        if (
          !item.actions?.some((allowed) => allowed.id === action) ||
          (action !== "stop" && action !== "interrupt" && action !== "resume")
        )
          throw new Error("Subagent action is unavailable.");
        return options.act(id, action, signal);
      }),
    onAvailability: (available) => options.bridge.setActivityAvailable(current() && available),
  });
  const unsubscribe = options.bridge.subscribe(() => registration.publish());
  const unsubscribePresentation = options.bridge.subscribeActivityPresentation(() =>
    registration.publish(),
  );
  registration.publish();
  return () => {
    live = false;
    unsubscribe();
    unsubscribePresentation();
    registration.dispose();
    options.bridge.setActivityAvailable(false);
  };
}
