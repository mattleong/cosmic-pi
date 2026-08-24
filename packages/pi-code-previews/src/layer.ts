import { getAgentDir } from "@earendil-works/pi-coding-agent";
import * as Layer from "effect/Layer";
import { AgentDirectory, nodeFilePlatformLayer } from "pi-cosmic-core";
import { CodePreviewSchedulerService } from "./application/scheduler";
import { ShikiAdapter } from "./boundary/shiki";
import { CodePreviewEnvironmentService } from "./config/env";
import { CodePreviewSettingsService } from "./config/service";
import { CodePreviewSyntaxService } from "./syntax/service";
import { CodePreviewWriteService } from "./write/service";

const privateDependencies = Layer.mergeAll(
  AgentDirectory.layerFromHost(getAgentDir),
  CodePreviewEnvironmentService.layer,
  ShikiAdapter.layer,
);

const applicationServices = Layer.mergeAll(
  CodePreviewSettingsService.layer,
  CodePreviewSyntaxService.layer,
  CodePreviewWriteService.layer,
  CodePreviewSchedulerService.layer,
).pipe(Layer.provide(privateDependencies));

export const codePreviewApplicationLayer = applicationServices.pipe(
  Layer.provideMerge(nodeFilePlatformLayer),
);

export type CodePreviewApplication = Layer.Success<typeof codePreviewApplicationLayer>;
export type CodePreviewRuntimeError = Layer.Error<typeof codePreviewApplicationLayer>;
