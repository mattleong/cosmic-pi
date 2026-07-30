// Pi command and dialog handlers are Promise-shaped host boundaries.
// @effect-diagnostics effect/asyncFunction:off
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { HerdrProjectionBridge } from "../boundary/host-ui.ts";
import type { HerdrAgentView } from "../herd/model.ts";
import { isHerdrAgentFinished } from "../herd/model.ts";
import { formatHerdrState } from "../herd/projection.ts";

export interface HerdrManagerActions {
  readonly focus: (id: string) => Promise<void>;
  readonly stop: (id: string) => Promise<void>;
  readonly read: (id: string) => Promise<string>;
  readonly send: (id: string, message: string) => Promise<void>;
}

const shortRunId = (id: string): string => id.replace(/^herdr-/, "").slice(0, 8);

export const formatHerdrManagerLabel = (agent: HerdrAgentView, index: number): string => {
  const report = agent.report ? " · report ready" : "";
  const attention = agent.error ? " · attention" : "";
  return `${index + 1}. [${agent.kind}] ${agent.name} · ${formatHerdrState(agent.state)}${report}${attention} · ${shortRunId(agent.id)}`;
};

const notifyFailure = (ctx: ExtensionCommandContext, error: unknown): void => {
  const message = error instanceof Error ? error.message : "Herdr operation failed.";
  ctx.ui.notify(message, "error");
};

async function openManager(
  ctx: ExtensionCommandContext,
  bridge: HerdrProjectionBridge,
  actions: HerdrManagerActions,
): Promise<void> {
  if (ctx.mode !== "tui") {
    if (ctx.hasUI) ctx.ui.notify("/herdr requires interactive TUI mode.", "warning");
    return;
  }
  while (true) {
    const agents = bridge.get().agents;
    if (agents.length === 0) {
      ctx.ui.notify("No extension-managed Herdr agents for this project.", "info");
      return;
    }
    const menu = agents.map((agent, index) => ({
      agent,
      label: formatHerdrManagerLabel(agent, index),
    }));
    const active = agents.filter(
      (agent) => !isHerdrAgentFinished(agent.state) && agent.report === undefined,
    ).length;
    const selected = await ctx.ui.select(
      `Herdr agents · ${active} active · ${agents.length - active} history · esc close`,
      menu.map((item) => item.label),
    );
    if (!selected) return;
    const agent = menu.find((item) => item.label === selected)?.agent;
    if (!agent) continue;
    const reportedTerminal =
      agent.report !== undefined && (agent.state === "completed" || agent.state === "failed");
    const paneAvailable = agent.state !== "stopped" && !reportedTerminal;
    const sendAvailable = !isHerdrAgentFinished(agent.state) && agent.report === undefined;
    const choices = [
      ...(paneAvailable ? ["Open Herdr pane", "View terminal output"] : []),
      ...(agent.report ? ["View final report"] : []),
      ...(agent.error ? ["View attention details"] : []),
      ...(sendAvailable ? ["Send guidance"] : []),
      ...(paneAvailable ? ["Stop agent and close pane"] : []),
      "Back",
    ];
    const action = await ctx.ui.select(
      `${agent.name} · ${agent.kind} · ${formatHerdrState(agent.state)} · ${shortRunId(agent.id)}`,
      choices,
    );
    if (!action || action === "Back") continue;
    try {
      if (action === "Open Herdr pane") {
        await actions.focus(agent.id);
        return;
      }
      if (action === "View terminal output") {
        await ctx.ui.editor(`${agent.name} · terminal output`, await actions.read(agent.id));
        continue;
      }
      if (action === "View final report") {
        await ctx.ui.editor(`${agent.name} · final report`, agent.report ?? "No report available.");
        continue;
      }
      if (action === "View attention details") {
        await ctx.ui.editor(
          `${agent.name} · attention`,
          agent.error ?? "No attention details available.",
        );
        continue;
      }
      if (action === "Send guidance") {
        const message = await ctx.ui.input("Send guidance to agent", "Enter follow-up guidance");
        if (!message?.trim()) continue;
        await actions.send(agent.id, message.trim());
        ctx.ui.notify(`Guidance sent to ${agent.name}.`, "info");
        continue;
      }
      if (action === "Stop agent and close pane") {
        const confirmed = await ctx.ui.confirm(
          "Stop managed agent?",
          `Stop ${agent.name} and close its extension-owned Herdr pane?`,
        );
        if (confirmed) {
          await actions.stop(agent.id);
          ctx.ui.notify(`${agent.name} stopped.`, "info");
        }
      }
    } catch (error) {
      notifyFailure(ctx, error);
    }
  }
}

export function registerHerdrManagerCommand(
  pi: ExtensionAPI,
  bridge: HerdrProjectionBridge,
  actions: HerdrManagerActions,
): void {
  pi.registerCommand("herdr", {
    description: "Inspect and manage extension-owned Herdr agents (TUI only)",
    handler: (_args, ctx) => openManager(ctx, bridge, actions),
  });
}
