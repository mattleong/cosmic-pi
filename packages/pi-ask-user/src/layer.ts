import type { AskUserPromptGate } from "./boundary/host-prompt.ts";
import type { AsyncDelivery } from "./questionnaire/async-service.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Layer from "effect/Layer";
import { makeAskUserHost } from "./boundary/host-dialogs.ts";
import type { AskUserDialogBridge } from "./boundary/host-ui.ts";
import { AskUserService } from "./questionnaire/service.ts";

export const makeAskUserLayer = (
  ctx: ExtensionContext,
  bridge: AskUserDialogBridge,
  delivery?: AsyncDelivery,
  generation?: string,
  promptGate?: AskUserPromptGate,
) =>
  AskUserService.layer(
    makeAskUserHost(ctx, bridge, promptGate),
    ctx.mode === "tui" ? delivery : undefined,
    generation,
  );

export type AskUserApplication = Layer.Success<ReturnType<typeof makeAskUserLayer>>;
export type AskUserRuntimeError = Layer.Error<ReturnType<typeof makeAskUserLayer>>;
