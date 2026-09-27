import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { registerExtensionCommand } from "pi-cosmic-core";
import { notifyHerdrBtw } from "../boundary/host-notifier.ts";
import { HERDR_BTW_COMMAND, HERDR_BTW_NEW_SUBCOMMAND, type HerdrBtwResult } from "./service.ts";

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

/** Runs one side-session request from a terminal and reports how it went. */
const sideSession =
  (usage: string, run: (prompt?: string | undefined) => Promise<HerdrBtwResult>) =>
  (args: string, ctx: ExtensionCommandContext): Promise<void> => {
    if (ctx.mode !== "tui") {
      notifyHerdrBtw(ctx, `Open Pi in an interactive terminal to use ${usage}`, "warning");
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
  };

/**
 * `/herdr-btw [prompt]` opens or returns to the side session; `/herdr-btw new [prompt]` starts a
 * fresh one. A prompt whose first word is exactly `new` therefore starts a fresh session.
 */
export const registerHerdrBtwCommands = (
  pi: ExtensionAPI,
  handlers: HerdrBtwCommandHandlers,
): void => {
  registerExtensionCommand(pi, {
    name: HERDR_BTW_COMMAND,
    description: "Open or return to a side conversation in the current tab",
    bare: { text: true, handler: sideSession(`/${HERDR_BTW_COMMAND}`, handlers.open) },
    subcommands: [
      {
        name: HERDR_BTW_NEW_SUBCOMMAND,
        arguments: "[prompt]",
        description: "Start a fresh side conversation and keep it as this session's side session",
        handler: sideSession(`/${HERDR_BTW_COMMAND} ${HERDR_BTW_NEW_SUBCOMMAND}`, handlers.openNew),
      },
    ],
  });
};
