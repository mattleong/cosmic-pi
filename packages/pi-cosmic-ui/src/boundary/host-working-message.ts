import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as MutableRef from "effect/MutableRef";
import { HostCallbackBoundary } from "./host-callback.ts";

export interface WorkingMessageHostShape {
  /** Updates Pi's live working row. Returns false when the TUI host is unavailable. */
  readonly set: (message?: string) => Effect.Effect<boolean>;
}

export class WorkingMessageHost extends Context.Service<
  WorkingMessageHost,
  WorkingMessageHostShape
>()("pi-cosmic-ui/boundary/host-working-message/WorkingMessageHost") {
  static layer(options: { readonly context: MutableRef.MutableRef<ExtensionContext> }) {
    return Layer.effect(
      this,
      Effect.gen(function* () {
        const callbacks = yield* HostCallbackBoundary;
        return WorkingMessageHost.of({
          set: (message) =>
            Effect.sync(() =>
              callbacks.invoke(
                "working-message",
                () => {
                  const ctx = MutableRef.get(options.context);
                  if (ctx.mode !== "tui") return false;
                  ctx.ui.setWorkingMessage(message);
                  return true;
                },
                false,
              ),
            ),
        });
      }),
    );
  }
}
