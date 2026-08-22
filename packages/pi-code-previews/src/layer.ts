import { getAgentDir } from "@earendil-works/pi-coding-agent";
import * as Layer from "effect/Layer";
import { AgentDirectory, nodeFilePlatformLayer } from "pi-cosmic-core";
import { ShikiAdapter } from "./boundary/shiki";
import { CodePreviewSchedulerService } from "./application/scheduler";
import { CodePreviewSession } from "./application/service";
import { CodePreviewEnvironmentService } from "./config/env";
import { CodePreviewSettingsService } from "./config/service";
import { CodePreviewSyntaxService } from "./syntax/service";
import { CodePreviewWriteService } from "./write/service";

const hostLayer = Layer.mergeAll(
  nodeFilePlatformLayer,
  AgentDirectory.layerFromHost(getAgentDir),
  CodePreviewEnvironmentService.layer,
);
const settingsLayer = CodePreviewSettingsService.layer.pipe(Layer.provideMerge(hostLayer));
const syntaxLayer = CodePreviewSyntaxService.layer.pipe(Layer.provideMerge(ShikiAdapter.layer));
const sessionLayer = CodePreviewSession.layer.pipe(
  Layer.provideMerge(Layer.merge(settingsLayer, syntaxLayer)),
);

export const makeCodePreviewApplicationLayer = <E>(
  selectedSessionLayer: Layer.Layer<CodePreviewSession, E, never>,
) =>
  Layer.mergeAll(
    hostLayer,
    settingsLayer,
    syntaxLayer,
    CodePreviewWriteService.layer,
    CodePreviewSchedulerService.layer,
    selectedSessionLayer,
  );

export const codePreviewApplicationLayer = makeCodePreviewApplicationLayer(sessionLayer);

export type CodePreviewApplication = Layer.Success<typeof codePreviewApplicationLayer>;
export type CodePreviewRuntimeError = Layer.Error<typeof codePreviewApplicationLayer>;
