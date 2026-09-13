import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { OverlayHandle, TUI } from "@earendil-works/pi-tui";
import * as Effect from "effect/Effect";
import { createScreenViewport } from "pi-cosmic-ui/boundary/host-viewport";
import { AskUserHostError } from "../questionnaire/errors.ts";
import type { FormOutcome } from "../questionnaire/form-protocol.ts";
import type { OwnedFormHost } from "../questionnaire/form-service.ts";
import type { AskUserPromptGate } from "./host-prompt.ts";
import type { AskUserDialogBridge } from "./host-ui.ts";
import { finishOwnedOverlay } from "./host-tui.ts";

export const makeOwnedFormTuiHost =
  (ctx: ExtensionContext, bridge: AskUserDialogBridge, gate?: AskUserPromptGate): OwnedFormHost =>
  (request, owner) =>
    Effect.tryPromise(() => import("../ui/form-dialog.ts")).pipe(
      Effect.flatMap(({ OwnedFormDialog }) =>
        (gate?.awaitOpen ?? Effect.void).pipe(
          Effect.andThen(
            Effect.suspend(() => {
              const viewport = createScreenViewport("bottom-center");
              let live = true;
              let finished = false;
              let requested: FormOutcome | undefined;
              let tui: TUI | undefined;
              let handle: OverlayHandle | undefined;
              let done: ((outcome: FormOutcome) => void) | undefined;
              let dialog: InstanceType<typeof OwnedFormDialog> | undefined;
              let token: number | undefined;
              let releasePrompt: (() => void) | undefined;
              let rejectCompletion: (() => void) | undefined;
              let blocked = false;
              const finish = (outcome: FormOutcome) => {
                requested ??= outcome;
                if (finished || !handle || !tui || !done) return;
                finished = true;
                const result = requested;
                const complete = done;
                try {
                  finishOwnedOverlay(tui, handle, () => complete(result));
                } catch {
                  rejectCompletion?.();
                }
              };
              const cleanup = Effect.try({
                try: () => {
                  live = false;
                  rejectCompletion = undefined;
                  dialog?.dispose();
                  try {
                    finish({ action: "cancel" });
                  } finally {
                    releasePrompt?.();
                    if (token !== undefined) bridge.clear(token);
                  }
                },
                catch: () =>
                  new AskUserHostError({
                    operation: "close",
                    message: "Unable to close the private form.",
                  }),
              }).pipe(Effect.ignore);
              return Effect.callback<FormOutcome, AskUserHostError>((resume) => {
                const fail = () =>
                  resume(
                    Effect.fail(
                      new AskUserHostError({
                        operation: "render",
                        message: "Unable to display the private form.",
                      }),
                    ),
                  );
                rejectCompletion = fail;
                try {
                  if (gate && !gate.canOpen()) {
                    blocked = true;
                    fail();
                    return;
                  }
                  releasePrompt = gate?.enter();
                  ctx.ui
                    .custom<FormOutcome>(
                      (hostTui, theme, keybindings, hostDone) => {
                        tui = hostTui;
                        done = hostDone;
                        if (!live) return { render: () => [], invalidate: () => {} };
                        viewport.attach(() => hostTui.terminal);
                        dialog = new OwnedFormDialog({
                          tui,
                          theme,
                          keybindings,
                          request,
                          owner,
                          getHeight: viewport.getHeight,
                          done: (outcome) => {
                            if (live) finish(outcome);
                          },
                          onCollapse: () => {
                            if (live && token !== undefined) bridge.markCollapsed(token);
                          },
                        });
                        token = bridge.activate(() => {
                          if (live) dialog?.resume();
                        });
                        return dialog;
                      },
                      {
                        overlay: true,
                        overlayOptions: viewport.overlayOptions,
                        onHandle: (ownedHandle) => {
                          handle = ownedHandle;
                          if (!live || requested) {
                            finish(requested ?? { action: "cancel" });
                            return;
                          }
                          dialog?.setOverlayHandle(handle);
                          if (token !== undefined) bridge.markOpened(token);
                        },
                      },
                    )
                    .then((outcome) => {
                      if (live) resume(Effect.succeed(outcome));
                    }, fail);
                } catch {
                  fail();
                }
              }).pipe(
                Effect.ensuring(cleanup),
                Effect.catch((error) =>
                  blocked && gate
                    ? gate.awaitOpen.pipe(
                        Effect.andThen(makeOwnedFormTuiHost(ctx, bridge, gate)(request, owner)),
                      )
                    : Effect.fail(error),
                ),
              );
            }),
          ),
        ),
      ),
      Effect.mapError(
        () =>
          new AskUserHostError({
            operation: "render",
            message: "Unable to display the private form.",
          }),
      ),
    );
