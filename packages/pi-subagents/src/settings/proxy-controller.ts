import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { synchronousNow } from "pi-cosmic-core";
import * as Predicate from "effect/Predicate";
import { fullScreenKeybindingLabel } from "pi-cosmic-ui/manager/key-labels";
import { startHostUiTicker } from "../boundary/host-ui.ts";
import { decodeCompactToolDetails, type SubagentRunCard } from "../tools/details.ts";
import type { SubagentToolInput } from "../tools/schema.ts";
import type { SubagentProjection, SubagentRunView } from "../run/model.ts";
import { SubagentFleetComponent, type FleetMessageMode } from "../ui/fleet.ts";

export type SubagentProxyCall = (
  input: SubagentToolInput,
  signal?: AbortSignal,
) => Promise<AgentToolResult<unknown>>;

const cardView = (card: SubagentRunCard): SubagentRunView => {
  let view: SubagentRunView = {
    id: card.id,
    name: card.name,
    task: "Task details are available through subagent_status.",
    selection: card.selection,
    cwd: "",
    state: card.state,
    context: card.context,
    writeIntent: card.writeIntent,
    fastMode: card.fastMode,
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
  };
  if (card.profile) view = { ...view, profile: card.profile };
  if (card.parentRunId) view = { ...view, parentRunId: card.parentRunId };
  if (card.depth !== undefined) view = { ...view, depth: card.depth };
  if (card.directChildCount !== undefined)
    view = { ...view, directChildCount: card.directChildCount };
  if (card.descendantCount !== undefined) view = { ...view, descendantCount: card.descendantCount };
  if (card.nativeActivity) view = { ...view, nativeActivity: card.nativeActivity };
  if (card.writeClaims) view = { ...view, writeClaims: card.writeClaims };
  if (card.writeAudit) view = { ...view, writeAudit: card.writeAudit };
  if (card.writeAdmissionPaused) view = { ...view, writeAdmissionPaused: true };
  if (card.endedAt !== undefined) view = { ...view, endedAt: card.endedAt };
  if (card.currentTool) view = { ...view, currentTool: card.currentTool };
  if (card.progress) view = { ...view, progress: card.progress };
  if (card.warning) view = { ...view, warning: card.warning };
  if (card.question)
    view = {
      ...view,
      question: {
        requestId: "proxy-question",
        message: card.question.message,
        createdAt: card.lastActivityAt,
      },
    };
  if (card.finalText) view = { ...view, finalText: card.finalText };
  if (card.error) view = { ...view, error: card.error };
  return view;
};

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
        if (ctx.hasUI) ctx.ui.notify("/subagents requires interactive TUI mode.", "warning");
        return Promise.resolve();
      }
      let revision = 0;
      let projection: SubagentProjection = { revision, runs: [] };
      let refreshInFlight: Promise<void> | undefined;
      const refresh = (signal?: AbortSignal): Promise<void> => {
        if (refreshInFlight) return refreshInFlight;
        const pending = call({ action: "list" }, signal).then((result) => {
          projection = projectionFromResult(result, ++revision);
        });
        refreshInFlight = pending;
        void pending.then(
          () => {
            if (refreshInFlight === pending) refreshInFlight = undefined;
          },
          () => {
            if (refreshInFlight === pending) refreshInFlight = undefined;
          },
        );
        return pending;
      };
      return refresh().then(() =>
        ctx.ui.custom<void>(
          (tui, theme, keybindings, done) => {
            let closed = false;
            const stopRefresh = startHostUiTicker(750, () => {
              if (closed) return;
              void refresh().then(
                () => tui.requestRender(),
                () => undefined,
              );
            });
            const close = () => {
              if (closed) return;
              closed = true;
              stopRefresh();
              done(undefined);
            };
            const action = (input: SubagentToolInput) =>
              call(input)
                .then(() => refresh())
                .then(() => tui.requestRender());
            return new SubagentFleetComponent({
              theme,
              visibilityRootId,
              getProjection: () => projection,
              getHeight: () => tui.terminal.rows,
              getNow: synchronousNow,
              matchesKeybinding: (data, id) => keybindings.matches(data, id),
              keybindingLabel: (id, fallback) =>
                fullScreenKeybindingLabel(id, fallback, (candidate) =>
                  keybindings.getKeys(candidate),
                ),
              requestRender: () => tui.requestRender(),
              close,
              actions: {
                stop: (id) => action({ action: "stop", runIds: [id] }),
                interrupt: (id) => action({ action: "interrupt", runIds: [id] }),
                resume: (id, message) =>
                  action(
                    message
                      ? { action: "resume", runIds: [id], message }
                      : { action: "resume", runIds: [id] },
                  ),
                message: (id, mode: FleetMessageMode, message) =>
                  action(
                    mode === "reply"
                      ? { action: "reply", runId: id, message }
                      : { action: "send", runIds: [id], message },
                  ),
                rename: (id, name) => action({ action: "rename", runId: id, name }),
              },
            });
          },
          {
            overlay: true,
            overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%" },
          },
        ),
      );
    },
  });
};
