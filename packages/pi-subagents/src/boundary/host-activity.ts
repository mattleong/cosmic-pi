import { registerRevisionedActivityProvider, type ActivityEvents } from "pi-cosmic-ui/activity";
import { sanitizeDiagnosticContent } from "pi-cosmic-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { SubagentRunView } from "../run/model.ts";
import type { SubagentProjectionBridge } from "./host-ui.ts";
import { MAX_NAME_CHARS } from "../run/state.ts";
import { MAX_PARENT_MESSAGE_CHARS } from "../run/limits.ts";
import type { WorkflowRunView } from "../workflow/model.ts";
import type { WorkflowActivitySink } from "../workflow/runs.ts";
import {
  EMPTY_WORKFLOWS,
  isOwnedByLiveWorkflow,
  liveWorkflowIds,
  runActions,
  SUBAGENT_ACTIVITY_PROVIDER,
  subagentActivityDetail,
  subagentActivityItems,
  type WorkflowActivitySnapshot,
} from "../ui/run-activity.ts";
import { workflowRunIdOf } from "../ui/workflow-activity.ts";

/**
 * Synchronous bridge from the workflow service to the Activity provider. It holds the views last
 * published, the only ones the host holds revisions for, so detail and actions resolve against
 * them between the service's coalesced publishes; stop and skip then act on the service's current
 * state by stable run ids.
 */
export interface WorkflowActivitySource extends WorkflowActivitySink {
  readonly get: () => WorkflowActivitySnapshot;
  readonly subscribe: (listener: () => void) => () => void;
  readonly clear: () => void;
}

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
type SubagentActivityAction = "stop" | "interrupt" | "resume" | "message" | "reply" | "rename";
type SubagentActivityInput = "resume" | "message" | "reply" | "rename";

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
  /**
   * Stops a workflow by run id, or skips a planned, queued or running workflow agent by its run
   * id.
   */
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
    providerId: SUBAGENT_ACTIVITY_PROVIDER,
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
