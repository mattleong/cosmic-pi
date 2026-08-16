import { hasObjectRuntimeType } from "pi-cosmic-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { notifyHerdrFork } from "../boundary/host-notifier.ts";
import type { HerdrForkResult } from "../fork/service.ts";

export interface HerdrForkCommandActions {
  readonly open: (prompt?: string | undefined) => Promise<HerdrForkResult>;
}

export const registerHerdrForkCommand = (
  pi: ExtensionAPI,
  actions: HerdrForkCommandActions,
): void => {
  pi.registerCommand("herdr-fork", {
    description: "Fork this Pi session into a new user-owned pane in the current Herdr tab.",
    handler: (args, ctx) => {
      if (ctx.mode !== "tui") {
        notifyHerdrFork(ctx, "/herdr-fork is available only in Pi's interactive TUI.", "error");
        return Promise.resolve();
      }

      const trimmed = args.trim();
      return actions.open(trimmed || undefined).then(
        (result) => {
          notifyHerdrFork(
            ctx,
            `Opened ${result.agentName} in ${result.paneId}. The pane is now user-owned.`,
            "info",
          );
        },
        (failure) => {
          // SAFETY: The value is constructed by the typed owner on this path and satisfies the asserted domain contract.
          const message =
            failure && hasObjectRuntimeType(failure) && "message" in failure
              ? String((failure as { message: unknown }).message)
              : "Unable to open a Herdr fork.";
          notifyHerdrFork(ctx, message.slice(0, 2_000), "error");
        },
      );
    },
  });
};
