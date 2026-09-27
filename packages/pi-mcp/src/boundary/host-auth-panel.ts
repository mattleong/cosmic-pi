import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { OverlayHandle, TUI } from "@earendil-works/pi-tui";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { invokeHostCallback, isProjectTrusted, makeSynchronousIngress } from "pi-cosmic-core";
import { startHostUiTicker } from "pi-cosmic-ui/boundary/host-status";
import { openOwnedSurface } from "pi-cosmic-ui/boundary/host-surface";
import { fullScreenKeybindingOptions } from "pi-cosmic-ui/manager/key-labels";
import type { McpAuthAttempt } from "../auth/flow.ts";
import { authPhaseTerminal } from "../auth/progress.ts";
import { boundaryError, type McpBoundaryError } from "../client/errors.ts";
import { McpAuthPanel } from "../ui/auth-panel.ts";
import { SPINNER_FRAME_MS } from "pi-cosmic-ui/manager";

const failed = () => boundaryError("unavailable", "not-sent", "The sign-in panel is unavailable.");

/** One private TUI presentation. Closing it cancels the exact flow, never logout. */
export const presentMcpAuthPanel = (
  ctx: ExtensionContext,
  attempt: McpAuthAttempt,
  current: () => boolean,
): Effect.Effect<void, McpBoundaryError> =>
  Effect.scoped(
    Effect.gen(function* () {
      if (
        !invokeHostCallback(
          () => ctx.mode === "tui" && ctx.hasUI && current() && isProjectTrusted(ctx),
          false,
        )
      )
        return yield* failed();
      const cancellation = yield* Deferred.make<void>();
      let closing = false;
      let cancelled = false;
      let reopening = false;
      let tui: TUI | undefined;
      let overlay: OverlayHandle | undefined;
      let close = () => {};
      const trusted = () => invokeHostCallback(current, false) && isProjectTrusted(ctx);
      const active = () => !closing && trusted();
      const repaint = () => {
        if (!active()) return;
        const value = attempt.snapshot();
        invokeHostCallback(() => {
          // Stock consent and manual callback dialogs own input without an overlay on top.
          overlay?.setHidden(
            value.phase === "scope-approval" ||
              (value.mode === "manual" && value.phase === "awaiting-callback"),
          );
          tui?.requestRender();
        }, undefined);
      };
      yield* attempt.subscribe(repaint);
      yield* Effect.acquireRelease(
        Effect.sync(() => startHostUiTicker(SPINNER_FRAME_MS, repaint)),
        (stop) => Effect.sync(() => invokeHostCallback(stop, undefined)),
      );
      // Cancellation must never wait behind (or be dropped by) browser opening.
      yield* Effect.forkScoped(
        Deferred.await(cancellation).pipe(
          Effect.andThen(attempt.cancel),
          Effect.andThen(Effect.sync(() => close())),
        ),
      );
      const reopens = yield* makeSynchronousIngress({
        capacity: 1,
        overflow: "drop",
        handle: () =>
          Effect.suspend(() => (cancelled ? Effect.void : attempt.reopen)).pipe(
            Effect.ignore,
            Effect.ensuring(
              Effect.sync(() => {
                reopening = false;
              }),
            ),
          ),
      }).pipe(Effect.orDie);
      yield* openOwnedSurface<void>(ctx, {
        placement: "dock",
        closedValue: undefined,
        isCurrent: trusted,
        onControl: (control) => {
          close = control;
        },
        onClose: () => {
          closing = true;
        },
        onMounted: (handle) => {
          overlay = handle;
          repaint();
        },
        create: (host) => {
          tui = host.tui;
          const keys = fullScreenKeybindingOptions(host.keybindings);
          return new McpAuthPanel({
            snapshot: attempt.snapshot,
            now: attempt.now,
            theme: host.theme,
            matchesKeybinding: keys.matchesKeybinding,
            keyLabel: keys.keybindingLabel,
            act: (action) => {
              if (!active() || cancelled) return;
              if (action === "cancel") {
                if (authPhaseTerminal(attempt.snapshot().phase)) {
                  close();
                  return;
                }
                cancelled = true;
                Deferred.doneUnsafe(cancellation, Effect.void);
              } else if (!reopening) {
                // Latch before ingress so repeated clicks cannot queue a later launch.
                reopening = true;
                reopens.offer(undefined);
              }
              repaint();
            },
          });
        },
      }).pipe(Effect.mapError(failed));
    }),
  );
