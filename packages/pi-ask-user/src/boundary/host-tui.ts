import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { OverlayHandle, TUI } from "@earendil-works/pi-tui";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { AskUserHostError } from "../questionnaire/errors.ts";
import type { AskUserOutcome } from "../questionnaire/model.ts";
import { cancelQuestionnaire } from "../questionnaire/reducer.ts";
import type { AskUserHost } from "../questionnaire/service.ts";
import { captureExternalEditorCommand, editWithExternalEditor } from "./host-external-editor.ts";
import type { AskUserPromptGate } from "./host-prompt.ts";
import type { AskUserDialogBridge } from "./host-ui.ts";

/** Pi 0.85 done() pops the global overlay stack. Protect unrelated overlays with an owned guard. */
const finishOwnedOverlay = (tui: TUI, handle: OverlayHandle, done: () => void): void => {
  handle.hide();
  const guard = tui.showOverlay({ render: () => [], invalidate: () => {} }, { nonCapturing: true });
  try {
    done();
  } finally {
    guard.hide();
  }
};

export const makeAskUserTuiHost =
  (
    ctx: ExtensionContext,
    bridge: AskUserDialogBridge,
    promptGate?: AskUserPromptGate,
  ): AskUserHost =>
  (request, opened) =>
    Effect.tryPromise(() => import("../ui/dialog.ts")).pipe(
      Effect.flatMap(({ AskUserDialog }) =>
        Effect.suspend(() => {
          const editorCommand = captureExternalEditorCommand(ctx);
          const authority = new AbortController();
          let requested: AskUserOutcome | undefined;
          let settled = false;
          let hostDone: ((outcome: AskUserOutcome) => void) | undefined;
          let hostTui: TUI | undefined;
          let overlay: OverlayHandle | undefined;
          let bridgeToken: number | undefined;
          let dialog: InstanceType<typeof AskUserDialog> | undefined;
          let releasePrompt: (() => void) | undefined;
          const editors = new Set<Promise<void>>();
          const editExternally = (tui: TUI, value: string): Promise<string | undefined> => {
            if (authority.signal.aborted) return Promise.resolve(undefined);
            const editing = editWithExternalEditor(tui, editorCommand, value, authority.signal);
            // Settlement includes the owned process, temporary files, and TUI restoration.
            // Retain only nonrejecting joins; dialog consumers still receive live failures.
            const settled = editing.then(
              () => undefined,
              () => undefined,
            );
            editors.add(settled);
            void settled.then(() => editors.delete(settled));
            return editing.then(
              (result) => (authority.signal.aborted ? undefined : result),
              (error) => {
                if (!authority.signal.aborted) throw error;
                return undefined;
              },
            );
          };

          const finish = (outcome: AskUserOutcome): void => {
            requested ??= outcome;
            if (settled || !overlay || !hostDone || !hostTui) return;
            settled = true;
            const finalOutcome = requested;
            const done = hostDone;
            finishOwnedOverlay(hostTui, overlay, () => done(finalOutcome));
          };
          const close = (): void => {
            authority.abort();
            try {
              finish(cancelQuestionnaire());
            } finally {
              releasePrompt?.();
              if (bridgeToken !== undefined) bridge.clear(bridgeToken);
            }
          };
          const cleanup = Effect.try({
            try: close,
            catch: () =>
              new AskUserHostError({
                operation: "close",
                message: "Unable to close the questionnaire overlay.",
              }),
          }).pipe(
            Effect.ignore,
            // Ordered finalization joins only admitted, owned editor cleanup, never
            // the arbitrary custom Promise. Revocation above prevents late admissions.
            Effect.andThen(Effect.promise(() => Promise.all(editors))),
          );

          return Effect.tryPromise(() => {
            // Recheck after the lazy import, in the same synchronous call as custom().
            if (opened && promptGate && !promptGate.canOpen())
              throw new Error("Another UI prompt owns input.");
            releasePrompt = promptGate?.enter();
            return ctx.ui.custom<AskUserOutcome>(
              (tui, theme, keybindings, done) => {
                hostDone = done;
                hostTui = tui;
                dialog = new AskUserDialog({
                  tui,
                  theme,
                  keybindings,
                  request,
                  done: finish,
                  editExternally: (value) => editExternally(tui, value),
                  onCollapse: () => {
                    if (!authority.signal.aborted && bridgeToken !== undefined)
                      bridge.markCollapsed(bridgeToken);
                  },
                });
                if (!authority.signal.aborted)
                  bridgeToken = bridge.activate(() => {
                    if (!authority.signal.aborted) dialog?.resume();
                  });
                return dialog;
              },
              {
                overlay: true,
                overlayOptions: {
                  anchor: "bottom-center",
                  width: "100%",
                  maxHeight: "100%",
                  margin: { left: 0, right: 0, bottom: 0 },
                },
                onHandle: (handle) => {
                  overlay = handle;
                  if (authority.signal.aborted || requested) {
                    try {
                      finish(requested ?? cancelQuestionnaire());
                    } catch {
                      /* Revoked callbacks cannot report into a disposed runtime. */
                    }
                    return;
                  }
                  dialog?.setOverlayHandle(handle);
                  if (opened) Deferred.doneUnsafe(opened, Effect.void);
                },
              },
            );
          }).pipe(Effect.ensuring(cleanup));
        }),
      ),
      Effect.mapError(
        () =>
          new AskUserHostError({
            operation: "render",
            message: "Unable to render the user questionnaire.",
          }),
      ),
    );
