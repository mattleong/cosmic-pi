import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { OverlayHandle, TUI } from "@earendil-works/pi-tui";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { openOwnedSurface } from "pi-cosmic-ui/boundary/host-surface";
import { AskUserHostError } from "../questionnaire/errors.ts";
import type { AskUserOutcome } from "../questionnaire/model.ts";
import { cancelQuestionnaire } from "../questionnaire/reducer.ts";
import type { AskUserHost } from "../questionnaire/service.ts";
import { captureExternalEditorCommand, editWithExternalEditor } from "./host-external-editor.ts";
import type { AskUserPromptGate } from "./host-prompt.ts";
import type { AskUserDialogBridge } from "./host-ui.ts";

/** Admission beside `custom`. Its release frees the prompt gate, then the dialog's bridge token. */
export const admitDialog =
  (
    bridge: AskUserDialogBridge,
    token: () => number | undefined,
    gate: AskUserPromptGate | undefined,
    recheck: boolean,
  ) =>
  (): false | (() => void) => {
    if (recheck && gate && !gate.canOpen()) return false;
    const releasePrompt = gate?.enter();
    return () => {
      releasePrompt?.();
      const owned = token();
      if (owned !== undefined) bridge.clear(owned);
    };
  };

const renderFailed = () =>
  new AskUserHostError({
    operation: "render",
    message: "Unable to render the user questionnaire.",
  });

export const makeAskUserTuiHost =
  (
    ctx: ExtensionContext,
    bridge: AskUserDialogBridge,
    promptGate?: AskUserPromptGate,
  ): AskUserHost =>
  (request, opened, queued) =>
    Effect.tryPromise(() => import("../ui/dialog.ts")).pipe(
      Effect.tap(() => (queued && promptGate ? promptGate.awaitOpen : Effect.void)),
      Effect.flatMap(({ AskUserDialog }) =>
        Effect.suspend(() => {
          const authority = new AbortController();
          let handle: OverlayHandle | undefined;
          let bridgeToken: number | undefined;
          const editors = new Set<Promise<void>>();
          const editExternally = (
            tui: TUI,
            command: string | undefined,
            value: string,
          ): Promise<string | undefined> => {
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
          };

          return openOwnedSurface<AskUserOutcome>(ctx, {
            placement: "dock",
            closedValue: cancelQuestionnaire(),
            // Recheck after the lazy import, in the same synchronous call as custom().
            admit: admitDialog(bridge, () => bridgeToken, promptGate, !!(opened || queued)),
            onClose: () => authority.abort(),
            create: ({ tui, theme, keybindings, getHeight, finish }) => {
              const editorCommand = captureExternalEditorCommand(ctx);
              const dialog = new AskUserDialog({
                tui,
                theme,
                keybindings,
                request,
                getHeight,
                done: finish,
                editExternally: (value) => editExternally(tui, editorCommand, value),
                collapse: () => {
                  handle?.setHidden(true);
                  if (!authority.signal.aborted && bridgeToken !== undefined)
                    bridge.markCollapsed(bridgeToken);
                },
              });
              bridgeToken = bridge.activate(() => {
                if (authority.signal.aborted) return;
                handle?.setHidden(false);
                tui.requestRender(true);
              });
              return dialog;
            },
            onMounted: (mounted) => {
              handle = mounted;
              if (bridgeToken !== undefined) bridge.markOpened(bridgeToken);
              if (opened) Deferred.doneUnsafe(opened, Effect.void);
            },
          }).pipe(
            // Ordered finalization joins only admitted, owned editor cleanup, never
            // the arbitrary custom Promise. Closing revoked later admissions first.
            Effect.ensuring(Effect.promise(() => Promise.all(editors))),
            Effect.catch((error) =>
              error.reason === "blocked" && queued && promptGate
                ? promptGate.awaitOpen.pipe(
                    Effect.andThen(
                      makeAskUserTuiHost(ctx, bridge, promptGate)(request, opened, queued),
                    ),
                  )
                : Effect.fail(renderFailed()),
            ),
          );
        }),
      ),
      Effect.mapError(renderFailed),
    );
