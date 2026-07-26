import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Layer from "effect/Layer";
import { ChildProcess } from "./boundary/child-process.ts";
import type {
  SubagentNotification,
  SubagentNotificationDelivery,
} from "./boundary/host-notifier.ts";
import type { SubagentProjection } from "./run/model.ts";
import { SubagentService } from "./run/service.ts";

export interface SubagentSessionInput {
  readonly ctx: ExtensionContext;
  readonly cwd: string;
  readonly projectTrusted: boolean;
}

export interface SubagentLayerOptions {
  readonly publish: (projection: SubagentProjection) => void;
  readonly notify: (notification: SubagentNotification) => SubagentNotificationDelivery | undefined;
}

export const makeSubagentLayer = (_input: SubagentSessionInput, options: SubagentLayerOptions) =>
  SubagentService.layer({ publish: options.publish, notify: options.notify }).pipe(
    Layer.provideMerge(ChildProcess.layer),
  );

export type SubagentApplicationLayer = ReturnType<typeof makeSubagentLayer>;
export type SubagentApplication = Layer.Success<SubagentApplicationLayer>;
export type SubagentRuntimeError = Layer.Error<SubagentApplicationLayer>;
