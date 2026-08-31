import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as MutableRef from "effect/MutableRef";
import type { HostCallbackBoundaryContract } from "./host-callback.ts";

export type WorkingMessageHostResult = "written" | "unavailable" | "failed";

export interface WorkingMessageHostContract {
  /** Updates Pi's live working row without conflating host absence with a failed write. */
  readonly set: (message?: string) => Effect.Effect<WorkingMessageHostResult>;
}

export const makeWorkingMessageHost = (options: {
  readonly context: MutableRef.MutableRef<ExtensionContext>;
  readonly callbacks: HostCallbackBoundaryContract;
}): WorkingMessageHostContract => ({
  set: (message) =>
    Effect.sync(() =>
      options.callbacks.invoke(
        "working-message",
        () => {
          const ctx = MutableRef.get(options.context);
          if (ctx.mode !== "tui") return "unavailable";
          ctx.ui.setWorkingMessage(message);
          return "written";
        },
        "failed",
      ),
    ),
});
