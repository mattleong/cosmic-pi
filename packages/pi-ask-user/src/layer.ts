import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Layer from "effect/Layer";
import { makeAskUserHost } from "./boundary/host-dialogs.ts";
import type { AskUserDialogBridge } from "./boundary/host-ui.ts";
import { AskUserService } from "./questionnaire/service.ts";

export const makeAskUserLayer = (ctx: ExtensionContext, bridge: AskUserDialogBridge) =>
  AskUserService.layer(makeAskUserHost(ctx, bridge));

type AskUserApplicationLayer = ReturnType<typeof makeAskUserLayer>;
export type AskUserApplication = Layer.Success<AskUserApplicationLayer>;
export type AskUserRuntimeError = Layer.Error<AskUserApplicationLayer>;
