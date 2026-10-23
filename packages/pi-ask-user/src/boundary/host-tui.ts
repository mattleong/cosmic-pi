import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { OverlayHandle } from "@earendil-works/pi-tui";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Queue from "effect/Queue";
import { openOwnedSurface } from "pi-cosmic-ui/boundary/host-surface";
import { AskUserHostError } from "../questionnaire/errors.ts";
import type { AskUserOutcome } from "../questionnaire/model.ts";
import { cancelQuestionnaire } from "../questionnaire/reducer.ts";
import type { AskUserHost } from "../questionnaire/service.ts";
import { editWithExternalEditor, readExternalEditorCommand } from "./host-external-editor.ts";
import type { AskUserPromptGate } from "./host-prompt.ts";
import type { AskUserDialogBridge } from "./host-ui.ts";

export const askUserTuiHost =
  (ctx: ExtensionContext, bridge: AskUserDialogBridge, gate?: AskUserPromptGate): AskUserHost =>
  (request, presence, queued) =>
    Effect.tryPromise(() => import("../ui/dialog.ts")).pipe(
      Effect.flatMap(({ AskUserDialog }) => {
        const open = Effect.gen(function* () {
          // Closing this scope interrupts admitted editors and awaits their process termination,
          // file cleanup, and TUI restoration before the dialog permit passes to a successor.
          const runEditor = yield* FiberSet.makeRuntimePromise();
          let live = true;
          let handle: OverlayHandle | undefined;
          let token: number | undefined;
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
          return yield* openOwnedSurface<AskUserOutcome>(ctx, {
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
            },
            create: ({ tui, theme, keybindings, getHeight, finish }) => {
              // Reading settings takes file locks, so wait until the editor key is first pressed.
              let command: { readonly value: string | undefined } | undefined;
              const editorCommand = () =>
                (command ??= { value: readExternalEditorCommand(ctx) }).value;
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
                editExternally: (value) =>
                  live
                    ? runEditor(editWithExternalEditor(tui, editorCommand(), value)).then(
                        (result) => (live ? result : undefined),
                        (cause: unknown) => {
                          if (live) throw cause;
                          return undefined;
                        },
                      )
                    : Promise.resolve(undefined),
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
          });
        }).pipe(Effect.scoped);
        const retrying = (gate?.awaitOpen ?? Effect.void).pipe(
          Effect.andThen(open),
          Effect.retry({ while: (error) => error.reason === "blocked" }),
        );
        return queued ? retrying : open;
      }),
      Effect.mapError(() =>
        AskUserHostError.make({
          operation: "render",
          message: "Couldn't show the questionnaire.",
        }),
      ),
    );
