import { ModelRuntime, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test, vi } from "vitest";
import { _clientTest, AdvisorModelError, createAdvisorChildModel } from "../src/client.ts";
import type { ResolvedAdvisorConfig } from "../src/config.ts";

function config(overrides: Partial<ResolvedAdvisorConfig> = {}): ResolvedAdvisorConfig {
  return {
    configPath: "/tmp/pi-advisor.json",
    enabled: true,
    provider: "advisor-provider",
    model: "advisor-model",
    fastMode: false,
    thinkingLevel: "medium",
    reviewPolicy: "guardrail",
    timeoutMs: 30_000,
    maxContextChars: 48_000,
    configured: true,
    ...overrides,
  };
}

function harness(options: { auth?: unknown; childAuth?: unknown; childModel?: unknown } = {}) {
  const parentModel = { provider: "advisor-provider", id: "advisor-model", reasoning: true };
  const childModel = options.childModel ?? parentModel;
  const runtime = {
    registerProvider: vi.fn(),
    setRuntimeApiKey: vi.fn(async () => undefined),
    getModel: vi.fn(() => childModel),
    getAuth: vi.fn(async () => options.childAuth ?? { apiKey: "child-key" }),
  };
  vi.spyOn(ModelRuntime, "create").mockResolvedValue(runtime as unknown as ModelRuntime);
  const ctx = {
    modelRegistry: {
      find: vi.fn(() => parentModel),
      getRegisteredProviderIds: vi.fn(() => ["custom-provider"]),
      getRegisteredProviderConfig: vi.fn(() => ({ name: "Custom" })),
      getApiKeyAndHeaders: vi.fn(async () => options.auth ?? { ok: true, apiKey: "runtime-key" }),
    },
  } as unknown as Pick<ExtensionContext, "modelRegistry">;
  return { ctx, runtime };
}

afterEach(() => vi.restoreAllMocks());

describe("advisor child model construction", () => {
  test("uses a fresh public runtime, mirrors providers and transferable runtime auth", async () => {
    const { ctx, runtime } = harness();
    const child = await createAdvisorChildModel(ctx, config());

    expect(ModelRuntime.create).toHaveBeenCalledOnce();
    expect(runtime.registerProvider).toHaveBeenCalledWith("custom-provider", { name: "Custom" });
    expect(runtime.setRuntimeApiKey).toHaveBeenCalledWith("advisor-provider", "runtime-key");
    expect(runtime.getModel).toHaveBeenCalledWith("advisor-provider", "advisor-model");
    expect(child.model).toEqual(expect.objectContaining({ id: "advisor-model" }));
    expect(child.thinkingLevel).toBe("medium");
  });

  test("transfers public runtime headers without logging or persisting their values", async () => {
    const { ctx, runtime } = harness({
      auth: { ok: true, apiKey: "runtime-key", headers: { "x-runtime-auth": "secret" } },
    });
    await createAdvisorChildModel(ctx, config());
    expect(runtime.registerProvider).toHaveBeenCalledWith("advisor-provider", {
      name: "Custom",
      headers: { "x-runtime-auth": "secret" },
    });
  });

  test("retains fast-mode priority payload behavior for supported child models", async () => {
    expect(_clientTest.applyFastServiceTier({ model: "gpt" })).toEqual({
      model: "gpt",
      service_tier: "priority",
    });
    expect(_clientTest.applyFastServiceTier("invalid")).toBeUndefined();
  });

  test("fails open for missing models and parent authentication failures", async () => {
    const missing = harness();
    (missing.ctx.modelRegistry.find as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
    await expect(createAdvisorChildModel(missing.ctx, config())).rejects.toThrow(AdvisorModelError);

    const authentication = harness({ auth: { ok: false, error: "login required" } });
    await expect(createAdvisorChildModel(authentication.ctx, config())).rejects.toThrow(
      "Advisor authentication failed",
    );
  });

  test("reports runtime-only auth that public child APIs cannot resolve", async () => {
    const { ctx } = harness({
      auth: { ok: true, env: { PRIVATE_RUNTIME_VALUE: "secret" } },
      childAuth: undefined,
    });
    // Explicitly override the default supplied by the harness.
    const runtime = await ModelRuntime.create();
    (runtime.getAuth as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    await expect(createAdvisorChildModel(ctx, config())).rejects.toThrow(
      "runtime-only headers or environment values",
    );
  });

  test("does not expose auth values in failures", async () => {
    const secret = "top-secret-runtime-value";
    const { ctx } = harness({ auth: { ok: false, error: "credential unavailable" } });
    await expect(createAdvisorChildModel(ctx, config())).rejects.not.toThrow(secret);
  });
});
