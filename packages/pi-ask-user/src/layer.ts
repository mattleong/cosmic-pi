import type { AskUserPromptGate } from "./boundary/host-prompt.ts";
import type { AsyncDelivery } from "./questionnaire/async-service.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Layer from "effect/Layer";
import { CodePreviewSchedulerService } from "pi-code-previews";
import { makeAskUserHost } from "./boundary/host-dialogs.ts";
import { makeOwnedFormTuiHost } from "./boundary/host-form-tui.ts";
import { makeOwnedFormDialogsHost } from "./boundary/host-form-dialogs.ts";
import type { AskUserDialogBridge } from "./boundary/host-ui.ts";
import { AskUserService, type QuestionnaireActivity } from "./questionnaire/service.ts";

export const makeAskUserLayer = (
  ctx: ExtensionContext,
  bridge: AskUserDialogBridge,
  delivery?: AsyncDelivery,
  generation?: string,
  promptGate?: AskUserPromptGate,
  activity?: QuestionnaireActivity,
) =>
  AskUserService.layer(
    makeAskUserHost(ctx, bridge, promptGate),
    ctx.mode === "tui" ? delivery : undefined,
    generation,
    activity,
    ctx.mode === "tui"
      ? makeOwnedFormTuiHost(ctx, bridge, promptGate)
      : ctx.mode === "rpc" && ctx.hasUI
        ? makeOwnedFormDialogsHost(ctx, promptGate)
        : undefined,
  ).pipe(Layer.merge(CodePreviewSchedulerService.layer));

export type AskUserApplication = Layer.Success<ReturnType<typeof makeAskUserLayer>>;
export type AskUserRuntimeError = Layer.Error<ReturnType<typeof makeAskUserLayer>>;
