import { getAgentDir } from "@earendil-works/pi-coding-agent";
import * as Layer from "effect/Layer";
import { AgentDirectory } from "pi-cosmic-core/platform/agent-directory";
import { nodeFilePlatformLayer } from "pi-cosmic-core/platform/node-file";
import { DirectoryModelStore } from "./config/store.ts";
import {
  DirectoryModelPreferenceService,
  type DirectoryModelSessionInput,
  type DirectoryModelNotify,
} from "./preference/service.ts";

export const directoryModelsLayer = (
  input: DirectoryModelSessionInput,
  notify: DirectoryModelNotify,
) => {
  const platform = Layer.merge(nodeFilePlatformLayer, AgentDirectory.layerFromHost(getAgentDir));
  const store = Layer.effect(DirectoryModelStore, DirectoryModelStore.make).pipe(
    Layer.provide(platform),
  );
  return Layer.effect(
    DirectoryModelPreferenceService,
    DirectoryModelPreferenceService.make(input, notify),
  ).pipe(Layer.provide(store));
};
