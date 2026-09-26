import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { synchronousNow } from "pi-cosmic-core";
import * as Predicate from "effect/Predicate";
import { startHostUiTicker } from "pi-cosmic-ui/boundary/host-status";
import { openOwnedSurfacePromise } from "pi-cosmic-ui/boundary/host-surface";
import { fullScreenKeybindingOptions } from "pi-cosmic-ui/manager/key-labels";
import { decodeCompactToolDetails, type SubagentRunCard } from "../tools/details-schema.ts";
import type { SubagentLifecycleInput, SubagentToolInput } from "../tools/schema.ts";
import type { SubagentProjection, SubagentRunView } from "../run/model.ts";
import { SUBAGENT_TOOL_NAME } from "../run/tool-policy.ts";
import { SubagentFleetComponent, type FleetMessageMode } from "../ui/fleet.ts";

export type SubagentProxyCall = (
  input: SubagentToolInput,
  signal?: AbortSignal,
) => Promise<AgentToolResult<unknown>>;

const cardView = (card: SubagentRunCard): SubagentRunView => ({
  id: card.id,
  name: card.name,
  task: "Task details are available through subagent_status.",
  selection: card.selection,
  cwd: "",
  state: card.state,
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
    createdAt: card.lastActivityAt,
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
          ctx.ui.notify(
            "Nested Pi can inspect and control its subtree; root owns settings.",
            "warning",
          );
        return Promise.resolve();
      }
      if (ctx.mode !== "tui") {
        if (ctx.hasUI)
          ctx.ui.notify(
            "Open Pi in an interactive terminal to view agents with /subagents.",
            "warning",
          );
        return Promise.resolve();
      }
      let revision = 0;
      let projection: SubagentProjection = { revision, runs: [] };
      let refreshInFlight: Promise<void> | undefined;
      const refresh = (signal?: AbortSignal): Promise<void> => {
        if (refreshInFlight) return refreshInFlight;
        const pending = call({ tool: SUBAGENT_TOOL_NAME.list, args: {} }, signal).then((result) => {
          projection = projectionFromResult(result, ++revision);
        });
        refreshInFlight = pending;
        const clear = () => {
          if (refreshInFlight === pending) refreshInFlight = undefined;
        };
        void pending.then(clear, clear);
        return pending;
      };
      let stopRefresh: (() => void) | undefined;
      let closed = false;
      return refresh()
        .then(() =>
          openOwnedSurfacePromise<undefined>(ctx, {
            placement: "screen",
            closedValue: undefined,
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
              const action = (input: SubagentToolInput) =>
                call(input)
                  .then(() => refresh())
                  .then(() => tui.requestRender());
              const lifecycle = (args: SubagentLifecycleInput) =>
                action({ tool: SUBAGENT_TOOL_NAME.lifecycle, args });
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
                  stop: (id) => lifecycle({ action: "stop", runIds: [id] }),
                  interrupt: (id) => lifecycle({ action: "interrupt", runIds: [id] }),
                  resume: (id, message) =>
                    lifecycle(
                      message
                        ? { action: "resume", runIds: [id], message }
                        : { action: "resume", runIds: [id] },
                    ),
                  message: (id, mode: FleetMessageMode, message) =>
                    action(
                      mode === "reply"
                        ? { tool: SUBAGENT_TOOL_NAME.reply, args: { runId: id, message } }
                        : { tool: SUBAGENT_TOOL_NAME.send, args: { runIds: [id], message } },
                    ),
                  rename: (id, name) =>
                    action({ tool: SUBAGENT_TOOL_NAME.rename, args: { runId: id, name } }),
                },
              });
            },
          }),
        )
        .then((outcome) => {
          // A failed opening rejects the command, as Pi's own custom Promise does.
          if (outcome._tag === "Failed") throw outcome.cause;
        });
    },
  });
};
