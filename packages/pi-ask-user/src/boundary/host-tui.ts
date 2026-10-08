import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { OverlayHandle } from "@earendil-works/pi-tui";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import { openOwnedSurface, type OwnedSurfaceError } from "pi-cosmic-ui/boundary/host-surface";
import { AskUserHostError } from "../questionnaire/errors.ts";
import type { AskUserOutcome } from "../questionnaire/model.ts";
import { cancelQuestionnaire } from "../questionnaire/reducer.ts";
import type { AskUserHost } from "../questionnaire/service.ts";
import { captureExternalEditorCommand, editWithExternalEditor } from "./host-external-editor.ts";
import type { AskUserPromptGate } from "./host-prompt.ts";
import type { AskUserDialogBridge } from "./host-ui.ts";

/**
 * Lazily loads and opens the questionnaire dialog on the dock with host-owned hide/resume.
 * Admission rechecks the prompt gate in the same synchronous call as `custom`; its release frees
 * the gate, then the dialog's bridge token. Closing revokes hide/resume and external-editor
 * authority before Pi's `done`. A queued opener first awaits the public prompt gate and retries a
 * blocked admission.
 * Every failure becomes one redacted render error.
 */
export const makeAskUserTuiHost =
  (ctx: ExtensionContext, bridge: AskUserDialogBridge, gate?: AskUserPromptGate): AskUserHost =>
  (request, presence, queued) =>
    Effect.tryPromise(() => import("../ui/dialog.ts")).pipe(
      Effect.flatMap(({ AskUserDialog }) => {
        // One opening attempt; a blocked admission builds a fresh one.
        const open = Effect.suspend(() => {
          const authority = new AbortController();
          const editors = new Set<Promise<void>>();
          let live = true;
          let handle: OverlayHandle | undefined;
          let token: number | undefined;
          // Mounting and resuming report `open`; collapsing reports `hidden`.
          const report = (visibility: "open" | "hidden") => {
            if (!presence) return;
            if (visibility === "open") Deferred.doneUnsafe(presence.opened, Effect.void);
            Queue.offerUnsafe(presence.visibility, visibility);
          };
          const show = (visibility: "open" | "hidden") => {
            if (!live) return false;
            handle?.setHidden(visibility === "hidden");
            report(visibility);
            return true;
          };
          return openOwnedSurface<AskUserOutcome>(ctx, {
            placement: "dock",
            closedValue: cancelQuestionnaire(),
            admit: () => {
              if (gate && !gate.canOpen()) return false;
              const releasePrompt = gate?.enter();
              return () => {
                releasePrompt?.();
                if (token !== undefined) bridge.clear(token);
              };
            },
            onClose: () => {
              live = false;
              authority.abort();
            },
            create: ({ tui, theme, keybindings, getHeight, finish }) => {
              const command = captureExternalEditorCommand(ctx);
              const dialog = new AskUserDialog({
                tui,
                theme,
                keybindings,
                request,
                getHeight,
                done: finish,
                collapse: () => {
                  if (show("hidden") && token !== undefined) bridge.markCollapsed(token);
                },
                editExternally: (value) => {
                  if (authority.signal.aborted) return Promise.resolve(undefined);
                  const editing = editWithExternalEditor(tui, command, value, authority.signal);
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
                },
              });
              token = bridge.activate(() => {
                if (show("open")) tui.requestRender(true);
              });
              return dialog;
            },
            onMounted: (mounted) => {
              handle = mounted;
              if (token !== undefined) bridge.markOpened(token);
              report("open");
            },
            // Ordered finalization joins only admitted, owned editor cleanup, never
            // the arbitrary custom Promise. Closing revoked later admissions first.
          }).pipe(Effect.ensuring(Effect.promise(() => Promise.all(editors))));
        });
        const retrying: Effect.Effect<AskUserOutcome, OwnedSurfaceError> = (
          gate?.awaitOpen ?? Effect.void
        ).pipe(
          Effect.andThen(open),
          // Only a closed prompt gate blocks admission, so a retry first waits for it to reopen.
          Effect.catchIf(
            (error) => error.reason === "blocked",
            () => retrying,
          ),
        );
        return queued ? retrying : open;
      }),
      Effect.mapError(
        () =>
          new AskUserHostError({
            operation: "render",
            message: "Couldn't show the questionnaire.",
          }),
      ),
    );
