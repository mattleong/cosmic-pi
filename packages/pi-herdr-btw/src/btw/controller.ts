import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { registerExtensionCommand } from "pi-cosmic-core";
import { notifyHerdrBtw } from "../boundary/host-notifier.ts";
import { HerdrBtwError } from "./errors.ts";
import { HERDR_BTW_COMMAND, HERDR_BTW_NEW_SUBCOMMAND, type HerdrBtwResult } from "./service.ts";

type SideSessionRun = (prompt?: string | undefined) => Promise<HerdrBtwResult>;

const SUCCESS_MESSAGES = {
  focused: "Switched to your BTW side session",
  resumed: "Reopened your BTW side session",
  created: "Opened a new BTW side session",
} satisfies Record<HerdrBtwResult["mode"], string>;

/** Runs one side-session request from a terminal and reports how it went. */
const sideSession =
  (usage: string, run: SideSessionRun) =>
  (args: string, ctx: ExtensionCommandContext): Promise<void> => {
    if (ctx.mode !== "tui") {
      notifyHerdrBtw(ctx, `Open Pi in an interactive terminal to use ${usage}`, "warning");
      return Promise.resolve();
    }
    const trimmed = args.trim();
    return run(trimmed || undefined).then(
      (result) => notifyHerdrBtw(ctx, SUCCESS_MESSAGES[result.mode], "info"),
      (failure) => {
        // Only workflow failures carry user-facing text; runtime and defect rejections do not.
        const message =
          failure instanceof HerdrBtwError ? failure.message : "Couldn't open a BTW side session";
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
  handlers: { readonly open: SideSessionRun; readonly openNew: SideSessionRun },
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
