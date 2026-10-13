import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { absurd } from "effect/Function";
import * as Effect from "effect/Effect";
import { synchronousNow, notifyAtHostBoundary } from "pi-cosmic-core";
import { startHostUiTicker } from "pi-cosmic-ui/boundary/host-status";
import { openOwnedSurface } from "pi-cosmic-ui/boundary/host-surface";
import { fullScreenKeybindingOptions } from "pi-cosmic-ui/manager/key-labels";
import { decodeFleetSnapshotResult, type SubagentFleetActionInput } from "../tools/proxy-fleet.ts";
import { actionFailureDisposition, decodeSubagentOutcomeDetails } from "../tools/outcome.ts";
import type { SubagentLifecycleInput } from "../tools/schema.ts";
import type { SubagentControlExpectation, SubagentProjection } from "../run/model.ts";
import { SUBAGENT_TOOL_NAME } from "../run/tool-policy.ts";
import {
  SubagentFleetComponent,
  type FleetMessageDelivery,
  type FleetMessageMode,
} from "../ui/fleet.ts";

export type SubagentProxyCall = (
  input: SubagentFleetActionInput,
  expected: SubagentControlExpectation,
  signal?: AbortSignal,
) => Promise<AgentToolResult<unknown>>;

type ProxyFleetAction = "stop" | "interrupt" | "resume" | "send" | "reply" | "rename";

type ProxyActionOutcome = "accepted" | "pending";

const UNCONFIRMED_ACTION =
  "The root session didn't confirm this; it may already have happened, so check the run before trying again";

const decodeRunActionDetails = (action: ProxyFleetAction, result: AgentToolResult<unknown>) => {
  const details = decodeSubagentOutcomeDetails(action, result);
  return details && "runCount" in details ? details : undefined;
};

const classifyProxyActionResult = (
  action: ProxyFleetAction,
  targetId: string,
  result: AgentToolResult<unknown>,
): ProxyActionOutcome => {
  const details = decodeRunActionDetails(action, result);
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
  const disposition = actionFailureDisposition(action, failure);
  switch (disposition) {
    case "pending":
      return "pending";
    case "unconfirmed":
      throw new Error(`Outcome not confirmed: ${failure.message}`);
    case "failed":
      throw new Error(failure.message);
  }
  return absurd(disposition);
};

export const registerSubagentProxyManagerCommand = (
  pi: ExtensionAPI,
  visibilityRootId: string,
  call: SubagentProxyCall,
  snapshot: (signal: AbortSignal) => Promise<AgentToolResult<unknown>>,
  isCurrent: () => boolean,
): void => {
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
      const controller = new AbortController();
      const signal = ctx.signal
        ? AbortSignal.any([ctx.signal, controller.signal])
        : controller.signal;
      let closed = false;
      let closeSurface: (() => void) | undefined;
      const current = () => !closed && !signal.aborted && isCurrent();
      const requireCurrent = () => {
        if (current()) return true;
        closeSurface?.();
        return false;
      };
      let revision = 0;
      let projection: SubagentProjection = { revision, runs: [] };
      let refreshInFlight: Promise<void> | undefined;
      const refresh = (): Promise<void> => {
        if (refreshInFlight) return refreshInFlight;
        const pending = snapshot(signal).then((result) => {
          if (!requireCurrent()) return undefined;
          const runs = decodeFleetSnapshotResult(result);
          if (!runs) throw new Error("The complete fleet snapshot is unavailable.");
          projection = { revision: ++revision, runs };
          return undefined;
        });
        refreshInFlight = pending;
        const clear = () => {
          if (refreshInFlight === pending) refreshInFlight = undefined;
        };
        void pending.then(clear, clear);
        return pending;
      };
      const refreshAfterAction = (): Promise<void> => {
        const prior = refreshInFlight;
        const refreshAgain = () => refresh();
        return prior ? prior.then(refreshAgain, refreshAgain) : refreshAgain();
      };
      let stopRefresh: (() => void) | undefined;
      return refresh()
        .then(() => {
          if (!requireCurrent()) return undefined;
          return Effect.runPromise(
            openOwnedSurface(ctx, {
              closedValue: undefined,
              placement: "screen",
              isCurrent: current,
              onControl: (close) => {
                closeSurface = close;
              },
              onClose: () => {
                closed = true;
                stopRefresh?.();
                controller.abort();
              },
              create: ({ tui, theme, keybindings, getHeight, finish }) => {
                stopRefresh = startHostUiTicker(750, () => {
                  if (!requireCurrent()) return;
                  void refresh().then(
                    () => {
                      if (requireCurrent()) tui.requestRender();
                      return undefined;
                    },
                    () => undefined,
                  );
                });
                const afterRefresh = <A>(outcome: () => Promise<A>): Promise<A> =>
                  (!requireCurrent()
                    ? Promise.resolve()
                    : refreshAfterAction().catch(() => undefined)
                  )
                    .then(outcome)
                    .finally(() => {
                      if (requireCurrent()) tui.requestRender();
                    });
                const action = (
                  actionName: ProxyFleetAction,
                  targetId: string,
                  input: SubagentFleetActionInput,
                  expected: SubagentControlExpectation,
                ): Promise<ProxyActionOutcome> => {
                  if (!requireCurrent()) return Promise.reject(new Error("Subagent fleet closed."));
                  return call(input, expected, signal)
                    .then((result) => classifyProxyActionResult(actionName, targetId, result))
                    .then(
                      (outcome) => afterRefresh(() => Promise.resolve(outcome)),
                      (cause: unknown) =>
                        afterRefresh((): Promise<ProxyActionOutcome> => {
                          throw cause;
                        }),
                    );
                };
                const accepted = (outcome: ProxyActionOutcome): void => {
                  if (outcome !== "accepted") throw new Error(UNCONFIRMED_ACTION);
                };
                const lifecycle = (
                  lifecycleAction: "stop" | "interrupt" | "resume",
                  id: string,
                  expected: SubagentControlExpectation,
                  resumeMessage?: string,
                ) => {
                  const lifecycleArgs: SubagentLifecycleInput = resumeMessage
                    ? { action: lifecycleAction, runIds: [id], message: resumeMessage }
                    : { action: lifecycleAction, runIds: [id] };
                  return action(
                    lifecycleAction,
                    id,
                    {
                      tool: SUBAGENT_TOOL_NAME.lifecycle,
                      args: lifecycleArgs,
                    },
                    expected,
                  ).then(accepted);
                };
                const message = (
                  id: string,
                  mode: FleetMessageMode,
                  text: string,
                  expected: SubagentControlExpectation,
                ): Promise<FleetMessageDelivery> =>
                  (mode === "reply"
                    ? action(
                        "reply",
                        id,
                        {
                          tool: SUBAGENT_TOOL_NAME.reply,
                          args: { runId: id, message: text },
                        },
                        expected,
                      )
                    : action(
                        "send",
                        id,
                        {
                          tool: SUBAGENT_TOOL_NAME.send,
                          args: { runIds: [id], message: text },
                        },
                        expected,
                      )
                  ).then((outcome) => (outcome === "pending" ? "pending" : "delivered"));
                return new SubagentFleetComponent({
                  theme,
                  visibilityRootId,
                  isCurrent: current,
                  getProjection: () => projection,
                  getHeight,
                  getNow: synchronousNow,
                  ...fullScreenKeybindingOptions(keybindings),
                  requestRender: () => tui.requestRender(),
                  close: () => finish(undefined),
                  actions: {
                    stop: (id, expected) => lifecycle("stop", id, expected),
                    interrupt: (id, expected) => lifecycle("interrupt", id, expected),
                    resume: (id, resumeMessage, expected) =>
                      lifecycle("resume", id, expected, resumeMessage),
                    message,
                    rename: (id, name, expected) =>
                      action(
                        "rename",
                        id,
                        {
                          tool: SUBAGENT_TOOL_NAME.rename,
                          args: { runId: id, name },
                        },
                        expected,
                      ).then(accepted),
                  },
                });
              },
            }),
            { signal: ctx.signal },
          );
        })
        .finally(() => controller.abort());
    },
  });
};
