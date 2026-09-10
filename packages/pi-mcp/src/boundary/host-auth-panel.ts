import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component, OverlayHandle, TUI } from "@earendil-works/pi-tui";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { invokeHostCallback, isProjectTrusted, makeSynchronousIngress } from "pi-cosmic-core";
import { startHostUiTicker } from "pi-cosmic-ui/boundary/host-status";
import { fullScreenKeybindingLabel } from "pi-cosmic-ui/manager/key-labels";
import type { McpAuthAttempt } from "../auth/flow.ts";
import { authPhaseTerminal } from "../auth/progress.ts";
import { boundaryError, type McpBoundaryError } from "../client/errors.ts";
import { McpAuthPanel } from "../ui/auth-panel.ts";

const inert = (): Component => ({ render: () => [], invalidate() {} });
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
      let factoryInvoked = false;
      let doneInvoked = false;
      let requested = false;
      let hostDone: (() => void) | undefined;
      let tui: TUI | undefined;
      let overlay: OverlayHandle | undefined;
      let rejectCompletion: (() => void) | undefined;
      const finish = () => {
        requested = true;
        if (doneInvoked || !hostDone || !tui || !overlay) return;
        doneInvoked = true;
        try {
          // Pinned Pi done() pops the global overlay stack. Remove only our handle,
          // then provide an inert guard for that pop so a newer questionnaire survives.
          overlay.hide();
          const guard = tui.showOverlay(inert(), { nonCapturing: true });
          try {
            hostDone();
          } finally {
            guard.hide();
          }
        } catch {
          rejectCompletion?.();
        }
      };
      const close = () => {
        closing = true;
        finish();
      };
      const active = () => !closing && invokeHostCallback(current, false) && isProjectTrusted(ctx);
      const repaint = () => {
        if (!active()) return;
        const value = attempt.snapshot();
        invokeHostCallback(() => {
          // Manual mode uses the stock private dialogs without competing overlay focus.
          overlay?.setHidden(value.mode === "manual" && value.phase === "awaiting-callback");
          tui?.requestRender();
        }, undefined);
      };
      yield* attempt.subscribe(repaint);
      yield* Effect.acquireRelease(
        Effect.sync(() => startHostUiTicker(250, repaint)),
        (stop) => Effect.sync(() => invokeHostCallback(stop, undefined)),
      );
      // Cancellation must never wait behind (or be dropped by) browser opening.
      yield* Effect.forkScoped(
        Deferred.await(cancellation).pipe(
          Effect.andThen(attempt.cancel),
          Effect.andThen(Effect.sync(close)),
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
      yield* Effect.callback<void, McpBoundaryError>((resume) => {
        const fail = () => resume(Effect.fail(failed()));
        rejectCompletion = fail;
        try {
          ctx.ui
            .custom<void>(
              (hostTui, theme, keybindings, done) => {
                if (factoryInvoked) {
                  close();
                  return inert();
                }
                factoryInvoked = true;
                hostDone = () => done(undefined);
                tui = hostTui;
                if (!active() || requested) {
                  close();
                  return inert();
                }
                return new McpAuthPanel({
                  snapshot: attempt.snapshot,
                  now: attempt.now,
                  theme,
                  matchesKeybinding: (data, id) => keybindings.matches(data, id),
                  keyLabel: (id, fallback) =>
                    fullScreenKeybindingLabel(id, fallback, (key) => keybindings.getKeys(key)),
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
              {
                overlay: true,
                overlayOptions: { anchor: "center", width: "85%", maxHeight: "90%" },
                onHandle: (handle) => {
                  overlay = handle;
                  if (closing || requested || !active()) close();
                  else repaint();
                },
              },
            )
            .then(() => resume(Effect.void), fail);
        } catch {
          fail();
        }
      }).pipe(Effect.ensuring(Effect.sync(close)));
    }),
  );
