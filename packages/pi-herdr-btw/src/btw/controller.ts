import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { registerExtensionCommand } from "pi-cosmic-core";
import { notifyHerdrBtw } from "../boundary/host-notifier.ts";
import { HerdrBtwError } from "./errors.ts";
import { HERDR_BTW_COMMAND, HERDR_BTW_NEW_SUBCOMMAND, type HerdrBtwResult } from "./service.ts";

type SideSessionRun = (prompt?: string) => Promise<HerdrBtwResult>;

const isHerdrBtwError = Schema.is(HerdrBtwError);

const SUCCESS_MESSAGES = {
  focused: "Switched to your BTW side session",
  resumed: "Reopened your BTW side session",
  created: "Opened a new BTW side session",
} satisfies Record<HerdrBtwResult["mode"], string>;

const sideSession =
  (usage: string, run: SideSessionRun, captureAuthority: () => () => boolean) =>
  (args: string, ctx: ExtensionCommandContext): Promise<void> => {
    if (ctx.mode !== "tui") {
      notifyHerdrBtw(ctx, `Open Pi in an interactive terminal to use ${usage}`, "warning");
      return Promise.resolve();
    }
    const isCurrent = captureAuthority();
    const trimmed = Str.trim(args);
    return run(trimmed === "" ? undefined : trimmed).then(
      (result) =>
        isCurrent() ? notifyHerdrBtw(ctx, SUCCESS_MESSAGES[result.mode], "info") : undefined,
      (cause: unknown) => {
        if (!isCurrent()) return;
        const message = isHerdrBtwError(cause) ? cause.message : "Couldn't open a BTW side session";
        notifyHerdrBtw(ctx, message, "error");
      },
    );
  };

export const registerHerdrBtwCommands = (
  pi: ExtensionAPI,
  handlers: {
    readonly open: SideSessionRun;
    readonly openNew: SideSessionRun;
    readonly captureAuthority: () => () => boolean;
  },
): void => {
  registerExtensionCommand(pi, {
    name: HERDR_BTW_COMMAND,
    description: "Open or return to a side conversation in the current tab",
    bare: {
      text: true,
      handler: sideSession(`/${HERDR_BTW_COMMAND}`, handlers.open, handlers.captureAuthority),
    },
    subcommands: [
      {
        name: HERDR_BTW_NEW_SUBCOMMAND,
        arguments: "[prompt]",
        description: "Start a fresh side conversation and keep it as this session's side session",
        handler: sideSession(
          `/${HERDR_BTW_COMMAND} ${HERDR_BTW_NEW_SUBCOMMAND}`,
          handlers.openNew,
          handlers.captureAuthority,
        ),
      },
    ],
  });
};
