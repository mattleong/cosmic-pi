import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { notifyHerdrBtw } from "../boundary/host-notifier.ts";
import { HERDR_BTW_NEW_COMMAND, type HerdrBtwResult } from "./service.ts";

export interface HerdrBtwCommandHandlers {
  readonly open: (prompt?: string | undefined) => Promise<HerdrBtwResult>;
  readonly openNew: (prompt?: string | undefined) => Promise<HerdrBtwResult>;
}

const successMessage = (result: HerdrBtwResult): string => {
  switch (result.mode) {
    case "focused":
      return "Switched to your BTW side session";
    case "resumed":
      return "Reopened your BTW side session";
    case "created":
      return "Opened a new BTW side session";
  }
};

const registerCommand = (
  pi: ExtensionAPI,
  name: string,
  description: string,
  run: (prompt?: string | undefined) => Promise<HerdrBtwResult>,
): void => {
  pi.registerCommand(name, {
    description,
    handler: (args, ctx) => {
      if (ctx.mode !== "tui") {
        notifyHerdrBtw(ctx, `Open Pi in an interactive terminal to use /${name}`, "warning");
        return Promise.resolve();
      }

      const trimmed = args.trim();
      return run(trimmed || undefined).then(
        (result) => notifyHerdrBtw(ctx, successMessage(result), "info"),
        (failure) => {
          const message =
            failure instanceof Error ? failure.message : "Couldn't open a BTW side session";
          notifyHerdrBtw(ctx, message, "error");
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
    "Open or return to a side conversation in the current tab",
    handlers.open,
  );
  registerCommand(
    pi,
    HERDR_BTW_NEW_COMMAND,
    "Start a fresh side conversation and keep it as this session's side session",
    handlers.openNew,
  );
};
