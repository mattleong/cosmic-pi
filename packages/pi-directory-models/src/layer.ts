import { getAgentDir } from "@earendil-works/pi-coding-agent";
import * as Layer from "effect/Layer";
import { AgentDirectory, nodeFilePlatformLayer } from "pi-cosmic-core";
import { DirectoryModelStore } from "./config/store.ts";
import {
  DirectoryModelPreferenceService,
  type DirectoryModelSessionInput,
  type DirectoryModelWarn,
} from "./preference/service.ts";

export const makeDirectoryModelsLayer = (
  input: DirectoryModelSessionInput,
  warn: DirectoryModelWarn,
) => {
  const platform = Layer.merge(nodeFilePlatformLayer, AgentDirectory.layerFromHost(getAgentDir));
  const store = Layer.effect(DirectoryModelStore, DirectoryModelStore.make).pipe(
    Layer.provide(platform),
  );
  return Layer.effect(
    DirectoryModelPreferenceService,
    DirectoryModelPreferenceService.make(input, warn),
  ).pipe(Layer.provide(store));
};
