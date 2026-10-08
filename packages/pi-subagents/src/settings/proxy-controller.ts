import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { synchronousNow, notifyAtHostBoundary } from "pi-cosmic-core";
import * as Predicate from "effect/Predicate";
import { startHostUiTicker } from "pi-cosmic-ui/boundary/host-status";
import { openCommandSurface } from "pi-cosmic-ui/boundary/host-surface";
import { fullScreenKeybindingOptions } from "pi-cosmic-ui/manager/key-labels";
import { decodeCompactToolDetails, type SubagentRunCard } from "../tools/details-schema.ts";
import { actionFailureDisposition, decodeSubagentOutcomeDetails } from "../tools/outcome.ts";
import type { SubagentLifecycleInput, SubagentToolInput } from "../tools/schema.ts";
import type { SubagentProjection, SubagentRunView } from "../run/model.ts";
import { SUBAGENT_TOOL_NAME } from "../run/tool-policy.ts";
import {
  SubagentFleetComponent,
  type FleetMessageDelivery,
  type FleetMessageMode,
} from "../ui/fleet.ts";

export type SubagentProxyCall = (
  input: SubagentToolInput,
  signal?: AbortSignal,
) => Promise<AgentToolResult<unknown>>;

/** The single-target actions the nested fleet owns; each names its expected details action. */
type ProxyFleetAction = "stop" | "interrupt" | "resume" | "send" | "reply" | "rename";

/** `pending` is send-only native delivery that is neither delivered nor failed. */
type ProxyActionOutcome = "accepted" | "pending";

const UNCONFIRMED_ACTION =
  "The root session didn't confirm this; it may already have happened, so check the run before trying again";

const decodeRunActionDetails = <ValueInput>(action: ProxyFleetAction, value: ValueInput) => {
  const details = decodeSubagentOutcomeDetails(action, value);
  return details && "runCount" in details ? details : undefined;
};

/**
 * Classifies one proxied single-target action from its decoded details alone. Only the expected
 * action with exactly the target's own card and no failure is accepted. Missing, malformed,
 * mismatched, or contradictory evidence is never success, and nothing here resends the action.
 */
const classifyProxyActionResult = (
  action: ProxyFleetAction,
  targetId: string,
  result: AgentToolResult<unknown>,
): ProxyActionOutcome => {
  const details = decodeRunActionDetails(action, result.details);
  if (!details) throw new Error(UNCONFIRMED_ACTION);
  const failures = details.actionFailures ?? [];
  const [failure] = failures;
  if (!failure) {
    if (details.runCount === 1 && details.cards.length === 1 && details.cards[0]?.id === targetId)
      return "accepted";
    throw new Error(UNCONFIRMED_ACTION);
  }
  if (
    failures.length !== 1 ||
    failure.id !== targetId ||
    details.runCount !== 0 ||
    details.cards.length !== 0
  )
    throw new Error(UNCONFIRMED_ACTION);
  switch (actionFailureDisposition(action, failure)) {
    case "pending":
      return "pending";
    case "unconfirmed":
      throw new Error(`Outcome not confirmed: ${failure.message}`);
    case "failed":
      throw new Error(failure.message);
  }
};

const cardView = (card: SubagentRunCard): SubagentRunView => ({
  id: card.id,
  name: card.name,
  task: "Task details are shown in the root session",
  selection: card.selection,
  cwd: "",
  state: card.state,
  steeringDelivery: card.steeringDelivery,
  context: card.context,
  writeIntent: card.writeIntent,
  openaiFastMode: card.openaiFastMode,
  host: card.host,
  runtime: card.runtime,
  closeOnReport: card.closeOnReport,
  reportGeneration: card.reportGeneration,
  capabilities: card.capabilities,
  model: card.model,
  effort: card.effort,
  startedAt: card.startedAt,
  lastActivityAt: card.lastActivityAt,
  sessionEvents: [],
  usage: card.usage,
  profile: card.profile,
  parentRunId: card.parentRunId,
  depth: card.depth,
  directChildCount: card.directChildCount,
  descendantCount: card.descendantCount,
  nativeActivity: card.nativeActivity,
  writeClaims: card.writeClaims,
  writeAudit: card.writeAudit,
  writeAdmissionPaused: card.writeAdmissionPaused,
  endedAt: card.endedAt,
  currentTool: card.currentTool,
  progress: card.progress,
  warning: card.warning,
  warningSource: card.warningSource,
  systemWarning: card.systemWarning,
  question: card.question && {
    requestId: "proxy-question",
    message: card.question.message,
  },
  finalText: card.finalText,
  error: card.error,
});

const projectionFromResult = (
  result: AgentToolResult<unknown>,
  revision: number,
): SubagentProjection => {
  const details = decodeCompactToolDetails(result.details);
  const runs = details && details.action !== "models" ? details.cards.map(cardView) : [];
  return { revision, runs };
};

export const registerSubagentProxyManagerCommand = (
  pi: ExtensionAPI,
  visibilityRootId: string,
  call: SubagentProxyCall,
): void => {
  if (!Predicate.isFunction(pi.registerCommand)) return;
  pi.registerCommand("subagents", {
    description: "Open the authenticated descendant subagent tree",
    handler: (args, ctx) => {
      if (args.trim()) {
        if (ctx.hasUI)
          notifyAtHostBoundary(
            ctx,
            "Subagent profiles and settings are managed in the root Pi session",
            "warning",
          );
        return Promise.resolve();
      }
      if (ctx.mode !== "tui") {
        if (ctx.hasUI)
          notifyAtHostBoundary(
            ctx,
            "Open Pi in an interactive terminal to use /subagents",
            "warning",
          );
        return Promise.resolve();
      }
      let revision = 0;
      let projection: SubagentProjection = { revision, runs: [] };
      let refreshInFlight: Promise<void> | undefined;
      const refresh = (): Promise<void> => {
        if (refreshInFlight) return refreshInFlight;
        const pending = call({ tool: SUBAGENT_TOOL_NAME.list, args: {} }).then((result) => {
          projection = projectionFromResult(result, ++revision);
        });
        refreshInFlight = pending;
        const clear = () => {
          if (refreshInFlight === pending) refreshInFlight = undefined;
        };
        void pending.then(clear, clear);
        return pending;
      };
      /** A refresh admitted after the action settled, so an older in-flight list cannot win. */
      const refreshAfterAction = (): Promise<void> => {
        const prior = refreshInFlight;
        const next = () => refresh();
        return prior ? prior.then(next, next) : next();
      };
      let stopRefresh: (() => void) | undefined;
      let closed = false;
      return refresh().then(() =>
        openCommandSurface(ctx, {
          placement: "screen",
          onClose: () => {
            closed = true;
            stopRefresh?.();
          },
          create: ({ tui, theme, keybindings, getHeight, finish }) => {
            stopRefresh = startHostUiTicker(750, () => {
              if (closed) return;
              void refresh().then(
                () => tui.requestRender(),
                () => undefined,
              );
            });
            // The action's own classified outcome wins: a later refresh failure never turns
            // accepted work into a failure (inviting duplicate work), nor hides a real failure.
            const afterRefresh = <A>(outcome: () => Promise<A>): Promise<A> =>
              (closed ? Promise.resolve() : refreshAfterAction().catch(() => undefined))
                .then(outcome)
                .finally(() => tui.requestRender());
            // Exactly one proxied call per user action; unconfirmed outcomes are never resent.
            const action = (
              expected: ProxyFleetAction,
              targetId: string,
              input: SubagentToolInput,
            ): Promise<ProxyActionOutcome> =>
              call(input)
                .then((result) => classifyProxyActionResult(expected, targetId, result))
                .then(
                  (outcome) => afterRefresh(() => Promise.resolve(outcome)),
                  (error) => afterRefresh(() => Promise.reject(error)),
                );
            const accepted = (outcome: ProxyActionOutcome): void => {
              if (outcome !== "accepted") throw new Error(UNCONFIRMED_ACTION);
            };
            const lifecycle = (
              lifecycleAction: "stop" | "interrupt" | "resume",
              id: string,
              resumeMessage?: string,
            ) => {
              const args: SubagentLifecycleInput = resumeMessage
                ? { action: lifecycleAction, runIds: [id], message: resumeMessage }
                : { action: lifecycleAction, runIds: [id] };
              return action(lifecycleAction, id, {
                tool: SUBAGENT_TOOL_NAME.lifecycle,
                args,
              }).then(accepted);
            };
            const message = (
              id: string,
              mode: FleetMessageMode,
              text: string,
            ): Promise<FleetMessageDelivery> =>
              (mode === "reply"
                ? action("reply", id, {
                    tool: SUBAGENT_TOOL_NAME.reply,
                    args: { runId: id, message: text },
                  })
                : action("send", id, {
                    tool: SUBAGENT_TOOL_NAME.send,
                    args: { runIds: [id], message: text },
                  })
              ).then((outcome) => (outcome === "pending" ? "pending" : "delivered"));
            return new SubagentFleetComponent({
              theme,
              visibilityRootId,
              getProjection: () => projection,
              getHeight,
              getNow: synchronousNow,
              ...fullScreenKeybindingOptions(keybindings),
              requestRender: () => tui.requestRender(),
              close: () => finish(undefined),
              actions: {
                stop: (id) => lifecycle("stop", id),
                interrupt: (id) => lifecycle("interrupt", id),
                resume: (id, resumeMessage) => lifecycle("resume", id, resumeMessage),
                message,
                rename: (id, name) =>
                  action("rename", id, {
                    tool: SUBAGENT_TOOL_NAME.rename,
                    args: { runId: id, name },
                  }).then(accepted),
              },
            });
          },
        }),
      );
    },
  });
};
