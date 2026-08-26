import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { notifyHerdrFork } from "../boundary/host-notifier.ts";
import type { HerdrForkResult } from "./service.ts";

export type HerdrForkCommandOutcome =
  | { readonly _tag: "opened"; readonly result: HerdrForkResult }
  | { readonly _tag: "failed"; readonly message: string };

export interface HerdrForkCommandHandlers {
  readonly open: (prompt?: string | undefined) => Promise<HerdrForkCommandOutcome>;
  readonly openNew: (prompt?: string | undefined) => Promise<HerdrForkCommandOutcome>;
}

const successMessage = (result: HerdrForkResult): string => {
  switch (result.mode) {
    case "focused":
      return `Focused ${result.agentName} in ${result.paneId}.`;
    case "resumed":
      return `Reopened the fork session as ${result.agentName} in ${result.paneId}. The pane is now user-owned.`;
    case "created":
      return `Opened ${result.agentName} in ${result.paneId}. The pane is now user-owned.`;
  }
};

const registerCommand = (
  pi: ExtensionAPI,
  name: string,
  description: string,
  run: (prompt?: string | undefined) => Promise<HerdrForkCommandOutcome>,
): void => {
  pi.registerCommand(name, {
    description,
    handler: (args, ctx) => {
      if (ctx.mode !== "tui") {
        notifyHerdrFork(ctx, `/${name} is available only in Pi's interactive TUI.`, "error");
        return Promise.resolve();
      }

      const trimmed = args.trim();
      return run(trimmed || undefined).then(
        (outcome) => {
          if (outcome._tag === "opened")
            notifyHerdrFork(ctx, successMessage(outcome.result), "info");
          else notifyHerdrFork(ctx, outcome.message.slice(0, 2_000), "error");
        },
        (failure) => {
          // Inactive-slot or unexpected runtime rejections; domain failures arrive as typed outcomes.
          const message =
            failure instanceof Error ? failure.message : "Unable to open a Herdr fork.";
          notifyHerdrFork(ctx, message.slice(0, 2_000), "error");
        },
      );
    },
  });
};

export const registerHerdrForkCommands = (
  pi: ExtensionAPI,
  handlers: HerdrForkCommandHandlers,
): void => {
  registerCommand(
    pi,
    "herdr-fork",
    "Reuse or open this session's durable Herdr fork pane in the current tab.",
    handlers.open,
  );
  registerCommand(
    pi,
    "herdr-fork:new",
    "Create a fresh Herdr fork pane and make it this session's reusable fork.",
    handlers.openNew,
  );
};
