import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { notifyHerdrBtw } from "../boundary/host-notifier.ts";
import type { HerdrBtwResult } from "./service.ts";

export type HerdrBtwCommandOutcome =
  | { readonly _tag: "opened"; readonly result: HerdrBtwResult }
  | { readonly _tag: "failed"; readonly message: string };

export interface HerdrBtwCommandHandlers {
  readonly open: (prompt?: string | undefined) => Promise<HerdrBtwCommandOutcome>;
  readonly openNew: (prompt?: string | undefined) => Promise<HerdrBtwCommandOutcome>;
}

const successMessage = (result: HerdrBtwResult): string => {
  switch (result.mode) {
    case "focused":
      return `Focused ${result.agentName} in ${result.paneId}.`;
    case "resumed":
      return `Reopened the BTW session as ${result.agentName} in ${result.paneId}. The pane is now user-owned.`;
    case "created":
      return `Opened ${result.agentName} in ${result.paneId}. The pane is now user-owned.`;
  }
};

const registerCommand = (
  pi: ExtensionAPI,
  name: string,
  description: string,
  run: (prompt?: string | undefined) => Promise<HerdrBtwCommandOutcome>,
): void => {
  pi.registerCommand(name, {
    description,
    handler: (args, ctx) => {
      if (ctx.mode !== "tui") {
        notifyHerdrBtw(ctx, `/${name} is available only in Pi's interactive TUI.`, "error");
        return Promise.resolve();
      }

      const trimmed = args.trim();
      return run(trimmed || undefined).then(
        (outcome) => {
          if (outcome._tag === "opened")
            notifyHerdrBtw(ctx, successMessage(outcome.result), "info");
          else notifyHerdrBtw(ctx, outcome.message.slice(0, 2_000), "error");
        },
        (failure) => {
          // Inactive-slot or unexpected runtime rejections; domain failures arrive as typed outcomes.
          const message =
            failure instanceof Error ? failure.message : "Unable to open a Herdr BTW session.";
          notifyHerdrBtw(ctx, message.slice(0, 2_000), "error");
        },
      );
    },
  });
};

export const registerHerdrBtwCommands = (
  pi: ExtensionAPI,
  handlers: HerdrBtwCommandHandlers,
): void => {
  registerCommand(
    pi,
    "herdr-btw",
    "Reuse or open this session's durable Herdr BTW pane in the current tab.",
    handlers.open,
  );
  registerCommand(
    pi,
    "herdr-btw:new",
    "Create a fresh Herdr BTW pane and make it this session's reusable side session.",
    handlers.openNew,
  );
};
