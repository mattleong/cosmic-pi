import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, test, vi } from "vitest";
import {
  _clientTest,
  AdvisorModelError,
  requestAdvisorReview,
  type CompleteAdvisorRequest,
} from "../src/client.ts";
import type { ResolvedAdvisorConfig } from "../src/config.ts";

function config(overrides: Partial<ResolvedAdvisorConfig> = {}): ResolvedAdvisorConfig {
  return {
    configPath: "/tmp/pi-advisor.json",
    enabled: true,
    provider: "advisor-provider",
    model: "advisor-model",
    thinkingLevel: "medium",
    timeoutMs: 30_000,
    maxContextChars: 48_000,
    configured: true,
    ...overrides,
  };
}

function response(text: string, stopReason = "stop") {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    api: "openai-responses",
    provider: "advisor-provider",
    model: "advisor-model",
    timestamp: Date.now(),
  };
}

function context(options: { model?: unknown; auth?: unknown; signal?: AbortSignal } = {}) {
  const advisorModel = options.model ?? {
    provider: "advisor-provider",
    id: "advisor-model",
    reasoning: true,
  };
  return {
    signal: options.signal,
    model: { provider: "main-provider", id: "main-model" },
    modelRegistry: {
      find: vi.fn(() => advisorModel),
      getApiKeyAndHeaders: vi.fn(async () => options.auth ?? { ok: true, apiKey: "credential" }),
    },
  } as unknown as ExtensionContext;
}

const passJson = JSON.stringify({ verdict: "pass", summary: "Looks good.", findings: [] });

describe("advisor client", () => {
  test("uses the explicitly configured model, auth, prompt, and output limit", async () => {
    const ctx = context();
    const completeRequest = vi.fn(async () =>
      response(passJson),
    ) as unknown as CompleteAdvisorRequest;

    await expect(
      requestAdvisorReview(ctx, config(), "review transcript", { completeRequest }),
    ).resolves.toEqual({ verdict: "pass", summary: "Looks good.", findings: [] });

    expect(ctx.modelRegistry.find).toHaveBeenCalledWith("advisor-provider", "advisor-model");
    expect(completeRequest).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "advisor-provider", id: "advisor-model" }),
      expect.objectContaining({
        systemPrompt: expect.stringContaining("independent response advisor"),
        messages: [
          expect.objectContaining({
            role: "user",
            content: [
              expect.objectContaining({
                type: "text",
                text: expect.stringContaining(JSON.stringify("review transcript")),
              }),
            ],
          }),
        ],
      }),
      expect.objectContaining({
        apiKey: "credential",
        maxTokens: _clientTest.ADVISOR_MAX_OUTPUT_TOKENS,
        reasoning: "medium",
      }),
    );
    expect(_clientTest.ADVISOR_MAX_OUTPUT_TOKENS).toBe(2_048);
  });

  test("clamps the configured reasoning level to model capabilities", async () => {
    const ctx = context({
      model: {
        provider: "advisor-provider",
        id: "advisor-model",
        reasoning: true,
        thinkingLevelMap: { medium: null, high: "high" },
      },
    });
    const completeRequest = vi.fn(async () =>
      response(passJson),
    ) as unknown as CompleteAdvisorRequest;

    await requestAdvisorReview(ctx, config({ thinkingLevel: "medium" }), "transcript", {
      completeRequest,
    });

    expect(completeRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ reasoning: "high" }),
    );
  });

  test("omits reasoning for non-reasoning models", async () => {
    const ctx = context({
      model: {
        provider: "advisor-provider",
        id: "advisor-model",
        reasoning: false,
      },
    });
    const completeRequestMock = vi.fn(
      async (_model: unknown, _context: unknown, _options?: Record<string, unknown>) =>
        response(passJson),
    );
    const completeRequest = completeRequestMock as unknown as CompleteAdvisorRequest;

    await requestAdvisorReview(ctx, config({ thinkingLevel: "high" }), "transcript", {
      completeRequest,
    });

    expect(completeRequestMock.mock.calls[0]?.[2]).not.toHaveProperty("reasoning");
  });

  test("rejects missing model and authentication errors without making a provider call", async () => {
    const completeRequest = vi.fn() as unknown as CompleteAdvisorRequest;
    const missingModelCtx = context({ model: null });
    (missingModelCtx.modelRegistry.find as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
    await expect(
      requestAdvisorReview(missingModelCtx, config(), "transcript", { completeRequest }),
    ).rejects.toThrow(AdvisorModelError);

    const authErrorCtx = context({ auth: { ok: false, error: "login required" } });
    await expect(
      requestAdvisorReview(authErrorCtx, config(), "transcript", { completeRequest }),
    ).rejects.toThrow("Advisor authentication failed");
    expect(completeRequest).not.toHaveBeenCalled();
  });

  test.each([
    ["environment", { ok: true, env: { ANTHROPIC_API_KEY: "test-environment-key" } }],
    ["ambient", { ok: true }],
  ])("allows %s auth without an explicit API key", async (_kind, auth) => {
    const ctx = context({ auth });
    const completeRequest = vi.fn(async () =>
      response(passJson),
    ) as unknown as CompleteAdvisorRequest;

    await expect(
      requestAdvisorReview(ctx, config(), "transcript", { completeRequest }),
    ).resolves.toEqual({ verdict: "pass", summary: "Looks good.", findings: [] });

    expect(completeRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        apiKey: undefined,
        env: "env" in auth ? auth.env : undefined,
      }),
    );
  });

  test("does not start authentication for a pre-aborted request", async () => {
    const controller = new AbortController();
    controller.abort();
    const ctx = context({ signal: controller.signal });
    const getAuth = ctx.modelRegistry.getApiKeyAndHeaders as ReturnType<typeof vi.fn>;
    getAuth.mockImplementation(() => Promise.reject(new Error("must not be started")));
    const completeRequest = vi.fn() as unknown as CompleteAdvisorRequest;

    await expect(
      requestAdvisorReview(ctx, config(), "transcript", { completeRequest }),
    ).rejects.toThrow("Advisor review was aborted.");

    expect(getAuth).not.toHaveBeenCalled();
    expect(completeRequest).not.toHaveBeenCalled();
  });

  test("rejects when synchronous credential work overruns the absolute deadline", async () => {
    let monotonicTime = 100;
    const now = vi.spyOn(performance, "now").mockImplementation(() => monotonicTime);
    try {
      const ctx = context();
      (ctx.modelRegistry.getApiKeyAndHeaders as ReturnType<typeof vi.fn>).mockImplementation(() => {
        monotonicTime += 6;
        return Promise.resolve({ ok: true, apiKey: "credential" });
      });
      const completeRequest = vi.fn() as unknown as CompleteAdvisorRequest;

      await expect(
        requestAdvisorReview(ctx, config({ timeoutMs: 5 }), "transcript", {
          completeRequest,
        }),
      ).rejects.toThrow("Advisor review timed out.");

      expect(completeRequest).not.toHaveBeenCalled();
    } finally {
      now.mockRestore();
    }
  });

  test("rejects when synchronous provider work overruns the absolute deadline", async () => {
    let monotonicTime = 100;
    const now = vi.spyOn(performance, "now").mockImplementation(() => monotonicTime);
    try {
      const completeRequest = vi.fn(() => {
        monotonicTime += 6;
        return Promise.resolve(response(passJson));
      }) as unknown as CompleteAdvisorRequest;

      await expect(
        requestAdvisorReview(context(), config({ timeoutMs: 5 }), "transcript", {
          completeRequest,
        }),
      ).rejects.toThrow("Advisor review timed out.");
    } finally {
      now.mockRestore();
    }
  });

  test("passes the provider only the time remaining after authentication", async () => {
    let monotonicTime = 100;
    const now = vi.spyOn(performance, "now").mockImplementation(() => monotonicTime);
    try {
      const ctx = context();
      (ctx.modelRegistry.getApiKeyAndHeaders as ReturnType<typeof vi.fn>).mockImplementation(
        async () => {
          monotonicTime += 250;
          return { ok: true, apiKey: "credential" };
        },
      );
      const completeRequest = vi.fn(async () =>
        response(passJson),
      ) as unknown as CompleteAdvisorRequest;

      await expect(
        requestAdvisorReview(ctx, config({ timeoutMs: 1_000 }), "transcript", {
          completeRequest,
        }),
      ).resolves.toEqual({ verdict: "pass", summary: "Looks good.", findings: [] });

      expect(completeRequest).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ timeoutMs: 750 }),
      );
    } finally {
      now.mockRestore();
    }
  });

  test.each([
    ["aborted", "Advisor review was aborted"],
    ["error", "Advisor review failed"],
  ])("rejects a provider %s response", async (stopReason, expected) => {
    const completeRequest = vi.fn(async () =>
      response("", stopReason),
    ) as unknown as CompleteAdvisorRequest;
    await expect(
      requestAdvisorReview(context(), config(), "transcript", { completeRequest }),
    ).rejects.toThrow(expected);
  });

  test("rejects malformed or empty advisor content", async () => {
    for (const text of ["", "not json"]) {
      const completeRequest = vi.fn(async () =>
        response(text),
      ) as unknown as CompleteAdvisorRequest;
      await expect(
        requestAdvisorReview(context(), config(), "transcript", { completeRequest }),
      ).rejects.toThrow();
    }
  });

  test("passes a timeout signal to the provider and rejects when it expires", async () => {
    const completeRequest = vi.fn(
      async (_model, _requestContext, options) =>
        await new Promise<never>((_resolve, reject) => {
          const signal = options?.signal;
          if (!signal) return reject(new Error("missing signal"));
          const abort = () => reject(new AdvisorModelError("timed out"));
          if (signal.aborted) abort();
          else signal.addEventListener("abort", abort, { once: true });
        }),
    ) as unknown as CompleteAdvisorRequest;

    await expect(
      requestAdvisorReview(context(), config({ timeoutMs: 5 }), "transcript", {
        completeRequest,
      }),
    ).rejects.toThrow("timed out");
  });

  test("times out and observes a late failure when the provider ignores the signal", async () => {
    vi.useFakeTimers();
    try {
      let rejectCompletion!: (error: Error) => void;
      const pendingCompletion = new Promise<never>((_resolve, reject) => {
        rejectCompletion = reject;
      });
      const completeRequest = vi.fn(() => pendingCompletion) as unknown as CompleteAdvisorRequest;

      const review = requestAdvisorReview(context(), config({ timeoutMs: 5 }), "transcript", {
        completeRequest,
      });
      const rejection = expect(review).rejects.toThrow("Advisor review timed out.");
      await vi.advanceTimersByTimeAsync(5);
      await rejection;

      expect(completeRequest).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({
          signal: expect.any(AbortSignal),
          timeoutMs: expect.any(Number),
        }),
      );
      rejectCompletion(new Error("late provider failure"));
      await Promise.resolve();
    } finally {
      vi.useRealTimers();
    }
  });

  test("times out while credentials are still resolving", async () => {
    vi.useFakeTimers();
    try {
      let rejectAuth!: (error: Error) => void;
      const pendingAuth = new Promise<never>((_resolve, reject) => {
        rejectAuth = reject;
      });
      const ctx = context();
      (ctx.modelRegistry.getApiKeyAndHeaders as ReturnType<typeof vi.fn>).mockReturnValue(
        pendingAuth,
      );
      const completeRequest = vi.fn() as unknown as CompleteAdvisorRequest;

      const review = requestAdvisorReview(ctx, config({ timeoutMs: 5 }), "transcript", {
        completeRequest,
      });
      const rejection = expect(review).rejects.toThrow("Advisor review timed out.");
      await vi.advanceTimersByTimeAsync(5);
      await rejection;

      expect(completeRequest).not.toHaveBeenCalled();
      rejectAuth(new Error("late credential failure"));
      await Promise.resolve();
    } finally {
      vi.useRealTimers();
    }
  });

  test("honors context abort while credentials are still resolving", async () => {
    let rejectAuth!: (error: Error) => void;
    const pendingAuth = new Promise<never>((_resolve, reject) => {
      rejectAuth = reject;
    });
    const controller = new AbortController();
    const ctx = context({ signal: controller.signal });
    (ctx.modelRegistry.getApiKeyAndHeaders as ReturnType<typeof vi.fn>).mockReturnValue(
      pendingAuth,
    );
    const completeRequest = vi.fn() as unknown as CompleteAdvisorRequest;

    const review = requestAdvisorReview(ctx, config(), "transcript", { completeRequest });
    const rejection = expect(review).rejects.toThrow("Advisor review was aborted.");
    controller.abort();
    await rejection;

    expect(completeRequest).not.toHaveBeenCalled();
    rejectAuth(new Error("late credential failure"));
    await Promise.resolve();
  });
});
