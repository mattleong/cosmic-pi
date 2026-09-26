import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { OverlayHandle } from "@earendil-works/pi-tui";
import * as Effect from "effect/Effect";
import { openOwnedSurface } from "pi-cosmic-ui/boundary/host-surface";
import { AskUserHostError } from "../questionnaire/errors.ts";
import type { FormOutcome } from "../questionnaire/form-protocol.ts";
import type { OwnedFormHost } from "../questionnaire/service.ts";
import type { AskUserPromptGate } from "./host-prompt.ts";
import { admitDialog } from "./host-tui.ts";
import type { AskUserDialogBridge } from "./host-ui.ts";

const renderFailed = () =>
  new AskUserHostError({ operation: "render", message: "Unable to display the private form." });

export const makeOwnedFormTuiHost =
  (ctx: ExtensionContext, bridge: AskUserDialogBridge, gate?: AskUserPromptGate): OwnedFormHost =>
  (request, owner) =>
    Effect.tryPromise(() => import("../ui/form-dialog.ts")).pipe(
      Effect.flatMap(({ OwnedFormDialog }) =>
        (gate?.awaitOpen ?? Effect.void).pipe(
          Effect.andThen(
            Effect.suspend(() => {
              let live = true;
              let handle: OverlayHandle | undefined;
              let token: number | undefined;
              let dialog: InstanceType<typeof OwnedFormDialog> | undefined;
              return openOwnedSurface<FormOutcome>(ctx, {
                placement: "dock",
                closedValue: { action: "cancel" },
                admit: admitDialog(bridge, () => token, gate, true),
                // Disposal clears private drafts before Pi's done.
                onClose: () => {
                  live = false;
                  dialog?.dispose();
                },
                create: ({ tui, theme, keybindings, getHeight, finish }) => {
                  dialog = new OwnedFormDialog({
                    tui,
                    theme,
                    keybindings,
                    request,
                    owner,
                    getHeight,
                    done: finish,
                    collapse: () => {
                      if (!live) return;
                      handle?.setHidden(true);
                      if (token !== undefined) bridge.markCollapsed(token);
                    },
                  });
                  token = bridge.activate(() => {
                    if (!live) return;
                    handle?.setHidden(false);
                    tui.requestRender(true);
                  });
                  return dialog;
                },
                onMounted: (mounted) => {
                  handle = mounted;
                  if (token !== undefined) bridge.markOpened(token);
                },
              }).pipe(
                Effect.catch((error) =>
                  error.reason === "blocked" && gate
                    ? gate.awaitOpen.pipe(
                        Effect.andThen(makeOwnedFormTuiHost(ctx, bridge, gate)(request, owner)),
                      )
                    : Effect.fail(renderFailed()),
                ),
              );
            }),
          ),
        ),
      ),
      Effect.mapError(renderFailed),
    );
