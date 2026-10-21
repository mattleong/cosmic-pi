import { registerRevisionedActivityProvider, type ActivityEvents } from "pi-cosmic-ui/activity";
import { sanitizeDiagnosticContent } from "pi-cosmic-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import { absurd } from "effect/Function";
import * as Schema from "effect/Schema";
import {
  captureSubagentControlExpectation,
  type SubagentControlExpectation,
  type SubagentRunView,
} from "../run/model.ts";
import type { SubagentError } from "../run/errors.ts";
import type { SubagentServiceContract } from "../run/service.ts";
import type { SubagentProjectionBridge } from "./host-ui.ts";
import { MAX_NAME_CHARS } from "../run/state.ts";
import { MAX_AGENT_MESSAGE_CHARS } from "../run/agent-messaging.ts";
import {
  runActions,
  SUBAGENT_ACTIVITY_PROVIDER,
  subagentActivityDetail,
  subagentActivityItems,
} from "../ui/run-activity.ts";

type SubagentActivityAction = "stop" | "interrupt" | "resume" | "message" | "reply" | "rename";
type SubagentActivityInput = "resume" | "message" | "reply" | "rename";

class SubagentActivityInputError extends Schema.TaggedError<SubagentActivityInputError>()(
  "SubagentActivityInputError",
  { message: Schema.String },
) {}

export const promptSubagentActivityInput = (
  ctx: ExtensionContext,
  run: SubagentRunView,
  action: SubagentActivityInput,
): Effect.Effect<string | undefined, SubagentActivityInputError> =>
  Effect.tryPromise({
    try: (signal) => {
      const title = sanitizeDiagnosticContent(run.name, { maximumLength: 160 });
      const question = action === "reply" ? run.question?.message : undefined;
      return ctx.ui.input(
        `${action.charAt(0).toUpperCase()}${action.slice(1)}: ${title}`,
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

const missingActivityInput = (action: string): Error =>
  new Error(`The ${action} activity action needs text input.`);

/**
 * Runs an admitted Activity action. Reply and message share the user's send path, which answers
 * a pending question or steers by the target's locked state.
 */
export const runSubagentActivityAction = (
  service: Pick<SubagentServiceContract, "stop" | "interrupt" | "resume" | "send" | "rename">,
  id: string,
  action: SubagentActivityAction,
  input: string | undefined,
  expected: SubagentControlExpectation,
  onPendingGuidance: () => void,
): Effect.Effect<void, SubagentError> => {
  switch (action) {
    case "stop":
    case "interrupt":
      return service[action](id, expected).pipe(Effect.asVoid);
    case "resume":
      return service.resume(id, input, expected).pipe(Effect.asVoid);
    case "rename":
    case "message":
    case "reply":
      if (input === undefined) return Effect.die(missingActivityInput(action));
      if (action === "rename") return service.rename(id, input, expected).pipe(Effect.asVoid);
      return service
        .send(id, input, expected)
        .pipe(
          Effect.flatMap((sent) => (sent.confirmed ? Effect.void : Effect.sync(onPendingGuidance))),
        );
  }
  return absurd(action);
};

const sameAssignment = (before: SubagentRunView, after: SubagentRunView): boolean =>
  before.assignmentEpoch === after.assignmentEpoch &&
  before.startedAt === after.startedAt &&
  before.reportGeneration === after.reportGeneration &&
  before.task === after.task &&
  before.sessionId === after.sessionId &&
  before.state === after.state &&
  before.question?.requestId === after.question?.requestId;

const isInputAction = (action: string): action is SubagentActivityInput =>
  action === "resume" || action === "message" || action === "reply" || action === "rename";

const offers = (run: SubagentRunView, title: string, action: string): boolean =>
  runActions(run, title).some((candidate) => candidate.id === action);

export function registerSubagentActivity(options: {
  readonly events: ActivityEvents;
  readonly sessionId: string;
  readonly bridge: SubagentProjectionBridge;
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
    input: string | undefined,
    expected: SubagentControlExpectation,
  ) => Promise<void>;
}): () => void {
  let disposed = false;
  const dispose = registerRevisionedActivityProvider(options.events, {
    sessionId: options.sessionId,
    providerId: SUBAGENT_ACTIVITY_PROVIDER,
    isCurrent: options.isCurrent,
    items: () =>
      subagentActivityItems(options.bridge.get(), options.bridge.getActivityPresentation()),
    starting: () =>
      options.bridge
        .getActivityPresentation()
        .starts.reduce((total, lease) => total + lease.requestedCount, 0),
    detail: (item) => subagentActivityDetail(options.bridge.get(), item.id) ?? item.title,
    act: (item, action, signal, invocationCurrent) => {
      const before = options.bridge.get().runs.find((run) => run.id === item.id);
      if (!before) throw new Error("Subagent action is unavailable");
      const expected = captureSubagentControlExpectation(before);
      if (action === "stop" || action === "interrupt")
        return options.act(item.id, action, signal, undefined, expected);
      if (!isInputAction(action)) throw new Error("Subagent action is unavailable");
      if (!options.input) throw new Error("Subagent input isn't available");
      return options.input(before, action, signal).then((input) => {
        if (input === undefined) return undefined;
        const after = options.bridge.get().runs.find((run) => run.id === item.id);
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
          value.length > (action === "rename" ? MAX_NAME_CHARS : MAX_AGENT_MESSAGE_CHARS)
        )
          throw new Error("Subagent input is invalid");
        return options.act(item.id, action, signal, value || undefined, expected);
      });
    },
    subscriptions: [options.bridge.subscribe, options.bridge.subscribeActivityPresentation],
    onAvailability: (available, current) =>
      options.bridge.setActivityAvailable(current() && available),
  });
  return () => {
    disposed = true;
    dispose();
    options.bridge.setActivityAvailable(false);
  };
}
