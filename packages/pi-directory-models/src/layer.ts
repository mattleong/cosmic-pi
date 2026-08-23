import { getAgentDir } from "@earendil-works/pi-coding-agent";
import * as Layer from "effect/Layer";
import { AgentDirectory, nodeFilePlatformLayer } from "pi-cosmic-core";
import { DirectoryModelStore } from "./config/store.ts";
import {
  DirectoryModelPreferenceService,
  type DirectoryModelPreferenceServiceOptions,
  type DirectoryModelSessionInput,
} from "./preference/service.ts";

export const makeDirectoryModelsLayer = (
  input: DirectoryModelSessionInput,
  options: DirectoryModelPreferenceServiceOptions,
) => {
  const platform = Layer.merge(
    nodeFilePlatformLayer,
    AgentDirectory.layerFromHost(() => getAgentDir()),
  );
  const store = DirectoryModelStore.layer.pipe(Layer.provide(platform));
  return DirectoryModelPreferenceService.layer(input, options).pipe(Layer.provide(store));
};

export type DirectoryModelsLayer = ReturnType<typeof makeDirectoryModelsLayer>;
export type DirectoryModelsApplication = Layer.Success<DirectoryModelsLayer>;
export type DirectoryModelsRuntimeError = Layer.Error<DirectoryModelsLayer>;
