// Pi command and dialog handlers are Promise-shaped host boundaries.
// @effect-diagnostics effect/asyncFunction:off
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { HerdrAgentView } from "../herd/model.ts";
import type { HerdrProjectionBridge } from "../boundary/host-ui.ts";

export interface HerdrManagerActions {
  readonly focus: (id: string) => Promise<void>;
  readonly stop: (id: string) => Promise<void>;
  readonly read: (id: string) => Promise<string>;
}

const label = (agent: HerdrAgentView): string =>
  `${agent.name} · ${agent.state}${agent.report ? " · report ready" : ""}`;

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
      ctx.ui.notify("No extension-managed Herdr Claude agents.", "info");
      return;
    }
    const selected = await ctx.ui.select(
      "Herdr Claude agents · choose one · esc close",
      agents.map(label),
    );
    if (!selected) return;
    const agent = agents.find((candidate) => label(candidate) === selected);
    if (!agent) continue;
    const choices = [
      "Focus Herdr pane",
      "Read terminal output",
      ...(agent.report ? ["Read final report"] : []),
      "Stop and close pane",
      "Back",
    ];
    const action = await ctx.ui.select(`${agent.name} · ${agent.state}`, choices);
    if (!action || action === "Back") continue;
    try {
      if (action === "Focus Herdr pane") {
        await actions.focus(agent.id);
        return;
      }
      if (action === "Read terminal output") {
        await ctx.ui.editor(`${agent.name} terminal output`, await actions.read(agent.id));
        continue;
      }
      if (action === "Read final report") {
        await ctx.ui.editor(`${agent.name} final report`, agent.report ?? "No report available.");
        continue;
      }
      if (action === "Stop and close pane") {
        const confirmed = await ctx.ui.confirm(
          "Stop Claude agent?",
          `Close the extension-owned pane for ${agent.name}?`,
        );
        if (confirmed) await actions.stop(agent.id);
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
    description: "Inspect and manage extension-owned Herdr Claude agents",
    handler: (_args, ctx) => openManager(ctx, bridge, actions),
  });
}
