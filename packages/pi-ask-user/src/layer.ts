import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Layer from "effect/Layer";
import { makeAskUserHost } from "./boundary/host-dialogs.ts";
import type { AskUserDialogBridge } from "./boundary/host-ui.ts";
import { AskUserService } from "./questionnaire/service.ts";

export const makeAskUserLayer = (ctx: ExtensionContext, bridge: AskUserDialogBridge) =>
  AskUserService.layer(makeAskUserHost(ctx, bridge));

export type AskUserApplication = Layer.Success<ReturnType<typeof makeAskUserLayer>>;
export type AskUserRuntimeError = Layer.Error<ReturnType<typeof makeAskUserLayer>>;
