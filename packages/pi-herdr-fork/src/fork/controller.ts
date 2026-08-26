import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { notifyHerdrFork } from "../boundary/host-notifier.ts";
import type { HerdrForkResult } from "./service.ts";

export type HerdrForkCommandOutcome =
  | { readonly _tag: "opened"; readonly result: HerdrForkResult }
  | { readonly _tag: "failed"; readonly message: string };

export const registerHerdrForkCommand = (
  pi: ExtensionAPI,
  open: (prompt?: string | undefined) => Promise<HerdrForkCommandOutcome>,
): void => {
  pi.registerCommand("herdr-fork", {
    description: "Fork this Pi session into a new user-owned pane in the current Herdr tab.",
    handler: (args, ctx) => {
      if (ctx.mode !== "tui") {
        notifyHerdrFork(ctx, "/herdr-fork is available only in Pi's interactive TUI.", "error");
        return Promise.resolve();
      }

      const trimmed = args.trim();
      return open(trimmed || undefined).then(
        (outcome) => {
          if (outcome._tag === "opened")
            notifyHerdrFork(
              ctx,
              `Opened ${outcome.result.agentName} in ${outcome.result.paneId}. The pane is now user-owned.`,
              "info",
            );
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
