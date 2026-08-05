import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Layer from "effect/Layer";
import { HostDialogs } from "./boundary/host-dialogs.ts";
import type { AskUserDialogBridge } from "./boundary/host-ui.ts";
import { AskUserService } from "./questionnaire/service.ts";

export interface AskUserSessionInput {
  readonly ctx: ExtensionContext;
  readonly cwd: string;
  readonly projectTrusted: boolean;
}

export const makeAskUserLayer = (input: AskUserSessionInput, bridge: AskUserDialogBridge) =>
  AskUserService.layer.pipe(Layer.provide(HostDialogs.layer(input.ctx, bridge)));

export type AskUserApplicationLayer = ReturnType<typeof makeAskUserLayer>;
export type AskUserApplication = Layer.Success<AskUserApplicationLayer>;
export type AskUserRuntimeError = Layer.Error<AskUserApplicationLayer>;
