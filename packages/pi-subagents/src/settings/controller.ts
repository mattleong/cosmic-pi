// Pi command and custom-UI handlers are Promise-shaped host boundaries.
// @effect-diagnostics effect/asyncFunction:off
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { SubagentProjectionBridge } from "../boundary/host-ui.ts";
import { SubagentFleetComponent } from "../ui/fleet.ts";

export interface FleetManagerActions {
  readonly stop: (id: string) => Promise<void>;
  readonly interrupt: (id: string) => Promise<void>;
  readonly resume: (id: string, message?: string) => Promise<void>;
  readonly send: (id: string, message: string) => Promise<void>;
  readonly reply: (id: string, message: string) => Promise<void>;
  readonly rename: (id: string, name: string) => Promise<void>;
}

const report = (ctx: ExtensionCommandContext, operation: Promise<void>) =>
  void operation.catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Subagent operation failed.";
    ctx.ui.notify(message, "error");
  });

async function openFleetManager(
  ctx: ExtensionCommandContext,
  bridge: SubagentProjectionBridge,
  actions: FleetManagerActions,
): Promise<void> {
  if (ctx.mode !== "tui") {
    if (ctx.hasUI) ctx.ui.notify("/subagents requires interactive TUI mode.", "warning");
    return;
  }
  await ctx.ui.custom<void>(
    (tui, theme, _keybindings, done) => {
      let unsubscribe = () => {};
      const promptMessage = (id: string, waiting: boolean) => {
        void ctx.ui
          .input(waiting ? "Reply to subagent" : "Message subagent", "Enter guidance")
          .then((message) => {
            if (!message?.trim()) return;
            report(
              ctx,
              waiting ? actions.reply(id, message.trim()) : actions.send(id, message.trim()),
            );
          });
      };
      const promptResume = (id: string) => {
        void ctx.ui.input("Resume subagent", "Optional continuation message").then((message) => {
          if (message === undefined) return;
          report(ctx, actions.resume(id, message.trim() || undefined));
        });
      };
      const promptRename = (id: string) => {
        void ctx.ui.input("Rename subagent", "New display name").then((name) => {
          if (!name?.trim()) return;
          report(ctx, actions.rename(id, name.trim()));
        });
      };
      const manager = new SubagentFleetComponent({
        theme,
        getProjection: bridge.get,
        getHeight: () => tui.terminal.rows,
        requestRender: () => tui.requestRender(),
        close: () => done(undefined),
        actions: {
          stop: (id) => report(ctx, actions.stop(id)),
          interrupt: (id) => report(ctx, actions.interrupt(id)),
          resume: promptResume,
          message: promptMessage,
          rename: promptRename,
        },
      });
      unsubscribe = bridge.subscribe(() => {
        manager.invalidate();
        tui.requestRender();
      });
      return {
        render: (width) => manager.render(width),
        handleInput: (data) => manager.handleInput(data),
        invalidate: () => manager.invalidate(),
        dispose: () => unsubscribe(),
      };
    },
    {
      overlay: true,
      overlayOptions: {
        anchor: "top-left",
        width: "100%",
        maxHeight: "100%",
      },
    },
  );
}

export function registerSubagentManagerCommand(
  pi: ExtensionAPI,
  bridge: SubagentProjectionBridge,
  actions: FleetManagerActions,
): void {
  pi.registerCommand("subagents", {
    description: "Open the full-screen subagent fleet inspector",
    handler: (_args, ctx) => openFleetManager(ctx, bridge, actions),
  });
}
