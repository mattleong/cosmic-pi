import {
  registerRevisionedActivityProvider,
  type ActivityEvents,
  type ActivityItem,
} from "pi-cosmic-ui/activity";
import { sanitizeDiagnosticContent } from "pi-cosmic-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { projectFleetTree } from "../ui/run-tree-rows.ts";
import {
  isActiveRunState,
  isParentActionRequiredRun,
  isTerminalRunState,
  hasSubagentCapability,
  hasUnresolvedSteeringDelivery,
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
import { MAX_NAME_CHARS } from "../run/state.ts";
import { MAX_PARENT_MESSAGE_CHARS } from "../run/limits.ts";
import { isWorkflowRunFinished, type WorkflowRunView } from "../workflow/model.ts";
import {
  queuedAgentDetail,
  withActivityRevision,
  workflowActivityDetail,
  workflowActivityItems,
  workflowMembership,
  workflowRunIdOf,
} from "../ui/workflow-activity.ts";

const PROVIDER = "pi-subagents";
/** The Activity protocol's snapshot bound; going over withdraws every row. */
const ACTIVITY_ITEM_LIMIT = 512;

export interface WorkflowActivitySnapshot {
  readonly runs: ReadonlyArray<WorkflowRunView>;
}

/** Synchronous bridge from the workflow service to the Activity provider. */
export interface WorkflowActivitySource {
  readonly publish: (runs: ReadonlyArray<WorkflowRunView>) => void;
  readonly get: () => WorkflowActivitySnapshot;
  readonly subscribe: (listener: () => void) => () => void;
  readonly clear: () => void;
}

const EMPTY_WORKFLOWS: WorkflowActivitySnapshot = Object.freeze({ runs: [] });

/**
 * Workflows that still own their members. A workflow releases its members before its view
 * finishes, so a finished or evicted workflow owns none.
 */
const liveWorkflowIds = (snapshot: WorkflowActivitySnapshot): ReadonlySet<string> =>
  new Set(snapshot.runs.filter((run) => !isWorkflowRunFinished(run.state)).map((run) => run.id));

/** Whether a running workflow, not the root, still receives this run's results. */
const isOwnedByLiveWorkflow = (run: SubagentRunView, live: ReadonlySet<string>): boolean =>
  run.workflow !== undefined && live.has(run.workflow.workflowId);

export const makeWorkflowActivitySource = (): WorkflowActivitySource => {
  let snapshot = EMPTY_WORKFLOWS;
  const listeners = new Set<() => void>();
  const replace = (runs: ReadonlyArray<WorkflowRunView>) => {
    snapshot = Object.freeze({ runs });
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // One failing subscriber cannot block the others.
      }
    }
  };
  return {
    publish: replace,
    get: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    clear: () => replace([]),
  };
};
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

type SubagentActivityAction = "stop" | "interrupt" | "resume" | "message" | "reply" | "rename";
type SubagentActivityInput = "resume" | "message" | "reply" | "rename";

function messageAction(run: SubagentRunView) {
  if (run.writeAdmissionPaused) return [];
  if (
    run.state === "waiting_for_parent" &&
    run.question &&
    hasSubagentCapability(run, "parent-contact")
  )
    return [{ id: "reply", label: "Reply", handoff: true as const }];
  if (hasUnresolvedSteeringDelivery(run)) return [];
  if (run.state === "reported" && run.closeOnReport === false)
    return [{ id: "message", label: "Next assignment", handoff: true as const }];
  return run.state === "running" && hasSubagentCapability(run, "steer")
    ? [{ id: "message", label: "Message", handoff: true as const }]
    : [];
}

/**
 * A paused owned run continues its owned assignment. A completed one stays with its workflow until
 * the workflow ends, because the root refuses a resume whose result only the root would receive.
 */
function resumeAction(run: SubagentRunView, owned: boolean) {
  const resumable = run.state === "paused" || (run.state === "completed" && !owned);
  return resumable && !run.writeAdmissionPaused && hasSubagentCapability(run, "resume")
    ? [{ id: "resume", label: "Resume", handoff: true as const }]
    : [];
}

/** `owned`: a running workflow still owns the run; see {@link isOwnedByLiveWorkflow}. */
function runActions(run: SubagentRunView, title: string, owned: boolean) {
  const unresolved = hasUnresolvedSteeringDelivery(run);
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
    ...((run.state === "running" || run.state === "waiting_for_parent") &&
    hasSubagentCapability(run, "interrupt") &&
    !unresolved
      ? [
          {
            id: "interrupt",
            label: "Interrupt",
            confirmation: `Interrupt "${title}"? Its subagents keep running.`,
            handoff: false as const,
          },
        ]
      : []),
    ...resumeAction(run, owned),
    ...messageAction(run),
    ...(hasSubagentCapability(run, "rename-display") &&
    !["starting", "stopping", "stopped", "failed"].includes(run.state)
      ? [{ id: "rename", label: "Rename", handoff: true as const }]
      : []),
  ];
}

class SubagentActivityInputError extends Schema.TaggedError<SubagentActivityInputError>()(
  "SubagentActivityInputError",
  { message: Schema.String },
) {}

/** Pi owns the abort-aware input dialog; the Activity manager closes before invoking it. */
export const promptSubagentActivityInput = (
  ctx: ExtensionContext,
  run: SubagentRunView,
  action: SubagentActivityInput,
): Effect.Effect<string | undefined, SubagentActivityInputError> =>
  Effect.tryPromise({
    try: (signal) => {
      const title = sanitizeDiagnosticContent(run.name, { maximumLength: 160 });
      const question = action === "reply" ? run.question?.message : undefined;
      const label = action === "message" && run.state === "reported" ? "Next assignment" : action;
      return ctx.ui.input(
        `${label[0]!.toUpperCase()}${label.slice(1)}: ${title}`,
        question
          ? sanitizeDiagnosticContent(question, { maximumLength: 2000 })
          : action === "resume"
            ? "Optional continuation message"
            : action === "rename"
              ? "New display name"
              : "Message",
        { signal },
      );
    },
    catch: () => new SubagentActivityInputError({ message: "Subagent input isn't available" }),
  });

/** What an action applies to beyond the published fields: the assignment and its question. */
const runIdentity = (run: SubagentRunView): string =>
  JSON.stringify([run.reportGeneration, run.sessionId ?? null, run.question?.requestId ?? null]);

/**
 * A member nests under its workflow while the workflow runs, and its finished runs stay there as
 * history, even after the workflow leaves the snapshot. A run working again after its workflow
 * ended belongs to the root, so it is published as a root run.
 */
const workflowPlacement = (run: SubagentRunView, owned: boolean) =>
  run.workflow !== undefined &&
  (run.parentRunId ?? "root") === "root" &&
  (owned || isTerminalRunState(run.state))
    ? workflowMembership(run.workflow, PROVIDER)
    : undefined;

export function subagentActivityItems(
  projection: SubagentProjection,
  presentation: SubagentActivityPresentationSnapshot = emptyActivityPresentation(),
  workflowSnapshot: WorkflowActivitySnapshot = EMPTY_WORKFLOWS,
): readonly ActivityItem[] {
  const awaited = new Set(presentation.awaits.flatMap((lease) => lease.runIds));
  const rows = projectFleetTree(projection.runs, "root", new Set()).rows;
  // Placeholders fill the slots runs leave.
  const workflows = workflowActivityItems({
    runs: workflowSnapshot.runs,
    visibleRunIds: new Set(rows.map(({ run }) => run.id)),
    providerId: PROVIDER,
    budget: Math.max(0, ACTIVITY_ITEM_LIMIT - rows.length),
  });
  const live = liveWorkflowIds(workflowSnapshot);
  const runs = rows.map(({ run }) => {
    const title = sanitizeDiagnosticContent(run.name, { maximumLength: 512 });
    const owned = isOwnedByLiveWorkflow(run, live);
    return withActivityRevision(
      {
        id: run.id,
        kind: "agent" as const,
        title,
        ...runAttention(run),
        awaited: awaited.has(run.id),
        startedAt: run.startedAt,
        updatedAt: run.lastActivityAt,
        summary: sanitizeDiagnosticContent(
          `${runStateLabel(run.state)} · ${run.currentTool ?? run.progress ?? run.runtime}`,
          { maximumLength: 4096 },
        ),
        actions: Object.freeze(
          runActions(run, title, owned).map((action) => Object.freeze(action)),
        ),
        route: sanitizeDiagnosticContent(formatRunRoute(run), { maximumLength: 512 }),
        ...(run.profile !== undefined && { profile: run.profile }),
        ...(run.endedAt !== undefined && { endedAt: run.endedAt }),
        ...(run.parentRunId &&
          run.parentRunId !== "root" && {
            parent: Object.freeze({ providerId: PROVIDER, itemId: run.parentRunId }),
          }),
        ...workflowPlacement(run, owned),
      },
      runIdentity(run),
    );
  });
  return Object.freeze([...workflows, ...runs].slice(0, ACTIVITY_ITEM_LIMIT));
}

const workflowDetail = (workflows: WorkflowActivitySnapshot, id: string): string | undefined => {
  const runId = workflowRunIdOf(id);
  if (runId !== undefined) {
    const run = workflows.runs.find((candidate) => candidate.id === runId);
    return run ? workflowActivityDetail(run) : undefined;
  }
  for (const run of workflows.runs) {
    const agent = run.agents.find((candidate) => candidate.runId === id);
    if (agent?.state === "queued") return queuedAgentDetail(run, agent);
  }
  return undefined;
};

export function subagentActivityDetail(
  projection: SubagentProjection,
  id: string,
  workflows: WorkflowActivitySnapshot = EMPTY_WORKFLOWS,
): string | undefined {
  const run = projectFleetTree(projection.runs, "root", new Set()).rows.find(
    (row) => row.run.id === id,
  )?.run;
  if (!run) return workflowDetail(workflows, id);
  return sanitizeDiagnosticContent(
    [
      sanitizeDiagnosticContent(`${run.name}: ${run.state}`, { maximumLength: 512 }),
      sanitizeDiagnosticContent(`${run.host}/${run.runtime} · ${run.model}`, {
        maximumLength: 512,
      }),
      sanitizeDiagnosticContent(
        [
          `ID: ${run.id} · assignment/report: ${run.reportGeneration} · report: ${run.reportStatus ?? "unknown"}`,
          `Cwd: ${run.cwd} · PID: ${run.pid ?? "none"}`,
          `Capabilities: ${run.capabilities.join(", ")} · steering: ${run.steeringDelivery ?? "none"}`,
          `Writes: ${run.writeIntent} · claims: ${run.writeClaims?.join(", ") ?? "exclusive / none"}`,
          `File access paused: ${run.writeAdmissionPaused === true}`,
          `Tokens: ${run.usage.totalTokens} · cost: ${run.usage.cost ?? "unknown"}`,
          `Workspace: ${run.writerWorkspaceMode ?? "shared-checkout"} · ${run.workspaceId ?? "none"}`,
          `Native agents: ${run.nativeActivity?.active ?? 0} active / ${run.nativeActivity?.total ?? 0} total`,
        ].join("\n"),
        { maximumLength: 2_000 },
      ),
      run.question
        ? `Question for parent: ${sanitizeDiagnosticContent(run.question.message, { maximumLength: 1_000 })}`
        : "",
      sanitizeDiagnosticContent(
        [run.error, run.warning, run.systemWarning].filter(Boolean).join("\n"),
        { maximumLength: 1_000 },
      ),
      sanitizeDiagnosticContent(run.task, { maximumLength: 2_000 }),
      sanitizeDiagnosticContent(
        run.sessionEvents
          .slice(-12)
          .map((event) =>
            event.type === "tool"
              ? `${event.toolName}: ${event.state}${event.target ? ` · ${event.target}` : ""}`
              : event.text.slice(-600),
          )
          .join("\n")
          .slice(-3_000),
        { maximumLength: 3_000 },
      ),
      sanitizeDiagnosticContent(run.finalText ?? run.progress ?? "", { maximumLength: 6_000 }),
    ].join("\n\n"),
    { maximumLength: 16_384 },
  );
}

const sameAssignment = (before: SubagentRunView, after: SubagentRunView): boolean =>
  before.startedAt === after.startedAt &&
  before.reportGeneration === after.reportGeneration &&
  before.task === after.task &&
  before.sessionId === after.sessionId &&
  before.state === after.state &&
  before.question?.requestId === after.question?.requestId;

const isInputAction = (action: string): action is SubagentActivityInput =>
  action === "resume" || action === "message" || action === "reply" || action === "rename";

/** Root session only. No parent-contact message is promoted to a user question. */
export function registerSubagentActivity(options: {
  readonly events: ActivityEvents;
  readonly sessionId: string;
  readonly bridge: SubagentProjectionBridge;
  readonly workflows?: WorkflowActivitySource | undefined;
  /** Stops a workflow by run id, or skips a queued or running workflow agent by its run id. */
  readonly actWorkflow?:
    | ((action: "stop" | "skip", id: string, signal: AbortSignal) => Promise<void>)
    | undefined;
  readonly isCurrent: () => boolean;
  readonly input?: (
    run: SubagentRunView,
    action: SubagentActivityInput,
    signal: AbortSignal,
  ) => Promise<string | undefined>;
  readonly act: (
    id: string,
    action: SubagentActivityAction,
    signal: AbortSignal,
    input?: string,
  ) => Promise<void>;
}): () => void {
  let disposed = false;
  /** Current action policy, including whether a running workflow still owns the run. */
  const offers = (run: SubagentRunView, title: string, action: string): boolean => {
    const live = liveWorkflowIds(options.workflows?.get() ?? EMPTY_WORKFLOWS);
    return runActions(run, title, isOwnedByLiveWorkflow(run, live)).some(
      (candidate) => candidate.id === action,
    );
  };
  const dispose = registerRevisionedActivityProvider(options.events, {
    sessionId: options.sessionId,
    providerId: PROVIDER,
    isCurrent: options.isCurrent,
    items: () =>
      subagentActivityItems(
        options.bridge.get(),
        options.bridge.getActivityPresentation(),
        options.workflows?.get(),
      ),
    starting: () =>
      options.bridge
        .getActivityPresentation()
        .starts.reduce((total, lease) => total + lease.requestedCount, 0),
    detail: (item) =>
      subagentActivityDetail(options.bridge.get(), item.id, options.workflows?.get()) ?? item.title,
    act: (item, action, signal, invocationCurrent) => {
      const workflowRunId = workflowRunIdOf(item.id);
      if (item.kind === "workflow" || action === "skip") {
        if (!options.actWorkflow || (item.kind === "workflow" && action !== "stop"))
          throw new Error("Workflow action is unavailable");
        return options.actWorkflow(
          action === "skip" ? "skip" : "stop",
          workflowRunId ?? item.id,
          signal,
        );
      }
      if (action === "stop" || action === "interrupt") return options.act(item.id, action, signal);
      if (!isInputAction(action)) throw new Error("Subagent action is unavailable");
      const before = options.bridge.get().runs.find((run) => run.id === item.id);
      if (!before || !options.input) throw new Error("Subagent input isn't available");
      return options.input(before, action, signal).then((input) => {
        if (input === undefined) return;
        const after = options.bridge.get().runs.find((run) => run.id === item.id);
        // The run's own progress changes its revision while typing. Preserve exact
        // assignment/question identity instead, then re-evaluate current action policy.
        if (
          disposed ||
          !invocationCurrent() ||
          !options.isCurrent() ||
          signal.aborted ||
          !after ||
          !sameAssignment(before, after) ||
          !offers(after, item.title, action)
        )
          throw new Error("Subagent changed while entering input");
        const value = input.trim();
        if (
          (!value && action !== "resume") ||
          value.length > (action === "rename" ? MAX_NAME_CHARS : MAX_PARENT_MESSAGE_CHARS)
        )
          throw new Error("Subagent input is invalid");
        return options.act(item.id, action, signal, value || undefined);
      });
    },
    subscriptions: [
      options.bridge.subscribe,
      options.bridge.subscribeActivityPresentation,
      ...(options.workflows ? [options.workflows.subscribe] : []),
    ],
    onAvailability: (available, current) =>
      options.bridge.setActivityAvailable(current() && available),
  });
  return () => {
    disposed = true;
    dispose();
    options.bridge.setActivityAvailable(false);
  };
}
