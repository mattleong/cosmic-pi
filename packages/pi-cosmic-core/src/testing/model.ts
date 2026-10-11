import {
  ModelRegistry,
  ModelRuntime,
  type CreateModelRuntimeOptions,
} from "@earendil-works/pi-coding-agent";
import { overlay, unavailable } from "./overlay.ts";

export type HostModel = ReturnType<ModelRegistry["getAll"]>[number];
export type HostModelRegistry = Pick<ModelRegistry, keyof ModelRegistry>;
type ModelCredentials = NonNullable<CreateModelRuntimeOptions["credentials"]>;
type ModelCatalogStore = NonNullable<CreateModelRuntimeOptions["modelsStore"]>;
type RequestAuth = Awaited<ReturnType<ModelRegistry["getApiKeyAndHeaders"]>>;
type ProviderAuthStatus = ReturnType<ModelRegistry["getProviderAuthStatus"]>;
type RefreshResult = Awaited<ReturnType<ModelRegistry["refresh"]>>;

const emptyCredentials: ModelCredentials = {
  read: () => Promise.resolve(undefined),
  list: () => Promise.resolve([]),
  modify: () => Promise.resolve(undefined),
  delete: () => Promise.resolve(),
};

const emptyCatalog: ModelCatalogStore = {
  read: () => Promise.resolve(undefined),
  write: () => Promise.resolve(),
  delete: () => Promise.resolve(),
};

const offlineModelRuntime = await ModelRuntime.create({
  credentials: emptyCredentials,
  modelsStore: emptyCatalog,
  modelsPath: null,
  refreshOnCreate: false,
  allowModelNetwork: false,
});

class OfflineModelRegistry extends ModelRegistry {
  override refresh(): Promise<RefreshResult> {
    return Promise.resolve({ aborted: false, errors: new Map() });
  }

  override getAvailable(): Array<HostModel> {
    return [];
  }

  override getAvailableOfType(): Promise<ReadonlyArray<never>> {
    return Promise.resolve([]);
  }

  override hasConfiguredAuth(): boolean {
    return false;
  }

  override isUsingOAuth(): boolean {
    return false;
  }

  override getProviderAuthStatus(): ProviderAuthStatus {
    return { configured: false };
  }

  override getApiKeyAndHeaders(): Promise<RequestAuth> {
    return Promise.resolve({ ok: false, error: "No credentials are configured in this fixture." });
  }

  override getProviderAuth(): Promise<undefined> {
    return Promise.resolve(undefined);
  }

  override getApiKeyForProvider(): Promise<undefined> {
    return Promise.resolve(undefined);
  }

  override stream(): never {
    throw unavailable("Model streaming");
  }

  override streamSimple(): never {
    throw unavailable("Model streaming");
  }

  override complete(): Promise<never> {
    return Promise.reject(unavailable("Model completion"));
  }

  override classify(): Promise<never> {
    return Promise.reject(unavailable("Model classification"));
  }

  override generateImages(): Promise<never> {
    return Promise.reject(unavailable("Image generation"));
  }

  override registerProvider(): void {}

  override unregisterProvider(): void {}

  override registerVirtualModel(): void {}

  override unregisterVirtualModel(): void {}
}

export const modelRegistryFixture = (overrides: Partial<HostModelRegistry> = {}): ModelRegistry =>
  overlay<ModelRegistry>(new OfflineModelRegistry(offlineModelRuntime), overrides);

export const modelFixture = (overrides: Partial<HostModel> = {}): HostModel =>
  overlay<HostModel>(
    {
      id: "test-model",
      name: "Test Model",
      api: "openai-responses",
      provider: "test-provider",
      baseUrl: "https://models.invalid",
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      reasoning: false,
      contextWindow: 128_000,
      maxTokens: 16_384,
    },
    overrides,
  );
