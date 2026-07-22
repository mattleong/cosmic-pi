// Test harness boundary: only the diagnostics used by this file are suppressed.
// @effect-diagnostics effect/asyncFunction:off
import { ModelRuntime, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test, vi } from "vitest";
import { _clientTest, AdvisorModelError, createAdvisorChildModel } from "../src/runtime/client.ts";
import type { ResolvedAdvisorConfig } from "../src/config/resolve.ts";

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

function harness(
  options: {
    auth?: unknown;
    childAuth?: unknown;
    childModel?: unknown;
    usingOAuth?: boolean;
  } = {},
) {
  const parentModel = {
    provider: "advisor-provider",
    id: "advisor-model",
    api: "openai-responses" as const,
    reasoning: true,
  };
  const childModel = options.childModel ?? parentModel;
  const runtime = {
    registerProvider: vi.fn(),
    setRuntimeApiKey: vi.fn(async () => undefined),
    getModel: vi.fn(() => childModel),
    getAuth: vi.fn(
      async () => options.childAuth ?? { auth: { apiKey: "child-key" }, source: "test" },
    ),
  };
  vi.spyOn(ModelRuntime, "create").mockResolvedValue(runtime as unknown as ModelRuntime);
  const ctx = {
    modelRegistry: {
      find: vi.fn(() => parentModel),
      getRegisteredProviderIds: vi.fn(() => ["custom-provider"]),
      getRegisteredProviderConfig: vi.fn(() => ({ name: "Custom" })),
      getApiKeyAndHeaders: vi.fn(async () => options.auth ?? { ok: true, apiKey: "runtime-key" }),
      isUsingOAuth: vi.fn(() => options.usingOAuth ?? false),
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

  test("preserves child OAuth refresh instead of pinning the resolved access token", async () => {
    const { ctx, runtime } = harness({
      auth: { ok: true, apiKey: "ephemeral-oauth-token" },
      usingOAuth: true,
    });
    await createAdvisorChildModel(ctx, config());

    expect(runtime.setRuntimeApiKey).not.toHaveBeenCalled();
    expect(runtime.getAuth).toHaveBeenCalledOnce();
  });

  test("registers the selected model API for fast-mode builtin providers", async () => {
    const { ctx, runtime } = harness({ usingOAuth: true });
    await createAdvisorChildModel(
      ctx,
      config({ provider: "openai-codex", model: "gpt-5.6-sol", fastMode: true }),
    );

    expect(runtime.registerProvider).toHaveBeenCalledWith(
      "openai-codex",
      expect.objectContaining({ api: "openai-responses", streamSimple: expect.any(Function) }),
    );
  });

  test("retains fast-mode priority payload behavior for supported child models", async () => {
    expect(_clientTest.applyFastServiceTier({ model: "gpt" })).toEqual({
      model: "gpt",
      service_tier: "priority",
    });
    expect(_clientTest.applyFastServiceTier("invalid")).toBeUndefined();
  });

  test("rejects hostile authentication accessors before Schema access", async () => {
    const auth = Object.defineProperty({}, "ok", {
      enumerable: true,
      get() {
        throw new Error("getter executed");
      },
    });
    const { ctx } = harness({ auth });
    await expect(createAdvisorChildModel(ctx, config())).rejects.toThrow(/invalid response/i);
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

  test.each([
    "find",
    "getRegisteredProviderIds",
    "getRegisteredProviderConfig",
    "isUsingOAuth",
  ] as const)("maps a throwing model-registry %s callback to AdvisorModelError", async (method) => {
    const secret = `sensitive-${method}`;
    const { ctx } = harness();
    const registry = ctx.modelRegistry as unknown as Record<string, ReturnType<typeof vi.fn>>;
    registry[method]?.mockImplementation(() => {
      throw new Error(secret);
    });

    const failure = createAdvisorChildModel(ctx, config());
    await expect(failure).rejects.toThrow(AdvisorModelError);
    await expect(failure).rejects.not.toThrow(secret);
  });

  test.each(["registerProvider", "getModel"] as const)(
    "maps a throwing child-runtime %s callback to AdvisorModelError",
    async (method) => {
      const secret = `sensitive-${method}`;
      const { ctx, runtime } = harness();
      runtime[method].mockImplementation(() => {
        throw new Error(secret);
      });

      const failure = createAdvisorChildModel(ctx, config());
      await expect(failure).rejects.toThrow(AdvisorModelError);
      await expect(failure).rejects.not.toThrow(secret);
    },
  );

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
