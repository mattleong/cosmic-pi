import type { ProviderHeaders } from "@earendil-works/pi-ai";
import { expect, it, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { nodeFilePlatformLayer } from "pi-cosmic-core";
import { afterEach, vi } from "vitest";
import { applyCodexRoutingHint } from "pi-better-openai/fast-models";
import { extensionHarness } from "./extension-harness.ts";
import { testContext, testModel } from "./helpers.ts";
import { fastModeFooterPrimitive } from "../src/ui/primitives.ts";

const sol = {
  ...testModel("gpt-6.2-sol", "openai-codex", "openai-codex-responses"),
  baseUrl: "https://chatgpt.com/backend-api/codex",
};

afterEach(() => vi.unstubAllEnvs());

it("adds tier hints only to eligible models on canonical Codex endpoints", () => {
  const headers: ProviderHeaders = { keep: "untouched" };
  const original = { ...headers };
  for (const baseUrl of [
    "http://chatgpt.com/backend-api/codex",
    "https://chatgpt.com.example.com/backend-api/codex",
    "https://chatgpt.com:9000/backend-api/codex",
    "https://name@chatgpt.com/backend-api/codex",
    "https://chatgpt.com/backend-api/other",
    sol.baseUrl + "?redirect=1",
    sol.baseUrl + "#tool",
    "invalid",
  ])
    applyCodexRoutingHint(headers, { ...sol, baseUrl }, "ultrafast");
  applyCodexRoutingHint(headers, { ...sol, id: "gpt-6.2-sol-preview" }, "ultrafast");
  applyCodexRoutingHint(headers, { ...sol, provider: "openai" }, "ultrafast");
  applyCodexRoutingHint(headers, { ...sol, api: "openai-responses" }, "priority");
  applyCodexRoutingHint(headers, sol, undefined);
  expect(headers).toEqual(original);
  for (const tier of ["priority", "ultrafast"] as const) {
    applyCodexRoutingHint(headers, sol, tier);
    expect(headers["x-codex-routing-hint"]).toContain(`tier=${tier}`);
    expect(headers.keep).toBe(original.keep);
  }
});

it("distinguishes active tiers in one footer contribution and removes it on an ineligible model", () => {
  const ctx = testContext({ model: () => sol });
  const fast = fastModeFooterPrimitive(ctx, { desiredActive: true, active: true });
  const ultra = fastModeFooterPrimitive(ctx, { desiredActive: "ultrafast", active: true });
  expect(ultra?.id).toBe(fast?.id);
  expect(ultra?.text).not.toBe(fast?.text);
  expect(ultra?.compactText).not.toBe(fast?.compactText);
  expect(
    fastModeFooterPrimitive(testContext(), { desiredActive: "ultrafast", active: true }),
  ).toBeUndefined();
});

const fastHost = Effect.fnUntraced(function* (options: Parameters<typeof extensionHarness>[0]) {
  const h = yield* extensionHarness(options);
  const ctx = { ...h.ctx, model: sol };
  const run = (args: string) =>
    Effect.promise(() => Promise.resolve(h.commands.get("openai")!.handler(args, ctx)));
  const request = (model = sol) =>
    Effect.promise(() =>
      Promise.resolve(
        h.handlers.get("before_provider_request")[0]!(
          {
            type: "before_provider_request",
            payload: { input: [] },
          },
          { ...ctx, model },
        ),
      ),
    );
  const headers = Effect.gen(function* () {
    const outgoing: ProviderHeaders = {};
    yield* h.deliver(
      "before_provider_headers",
      { type: "before_provider_headers", headers: outgoing },
      ctx,
    );
    return outgoing;
  });
  return { ...h, ctx, run, request, headers };
});

layer(nodeFilePlatformLayer)("Main session speed selection", (test) => {
  test.effect(
    "toggles directly between tiers, pauses without downgrading, and turns the selected mode off",
    () =>
      Effect.gen(function* () {
        const h = yield* fastHost({});
        yield* h.emit("session_start", h.ctx);
        for (const [command, tier] of [
          ["fast", "priority"],
          ["ultrafast", "ultrafast"],
          ["fast", "priority"],
          ["settings fast.enabled ULTRAFAST", "ultrafast"],
        ] as const) {
          yield* h.run(command);
          expect(yield* h.request()).toMatchObject({ service_tier: tier });
          expect((yield* h.headers)["x-codex-routing-hint"]).toContain(`tier=${tier}`);
        }
        expect(yield* h.request({ ...sol, id: "gpt-6.1-sol" })).toBeUndefined();
        expect(yield* h.request({ ...sol, provider: "openai" })).toBeUndefined();
        expect(yield* h.request()).toMatchObject({ service_tier: "ultrafast" });
        yield* h.run("ultrafast");
        expect(yield* h.request()).toBeUndefined();
        expect(yield* h.headers).toEqual({});
        yield* h.emit("session_shutdown", h.ctx);
      }),
  );

  test.effect(
    "restores the selected tier; flags override persisted intent and ultrafast wins a flag conflict",
    () =>
      Effect.gen(function* () {
        const h = yield* fastHost({ config: { persistState: true, desiredActive: true } });
        h.getFlag.mockReturnValue(true);
        yield* h.emit("session_start", h.ctx);
        expect(yield* h.request()).toMatchObject({ service_tier: "ultrafast" });
        yield* h.emit("session_shutdown", h.ctx);
        h.getFlag.mockReturnValue(false);
        yield* h.emit("session_start", h.ctx);
        expect(yield* h.request()).toMatchObject({ service_tier: "ultrafast" });
        yield* h.emit("session_shutdown", h.ctx);
        h.getFlag.mockImplementation((name) => name === "fast");
        yield* h.emit("session_start", h.ctx);
        expect(yield* h.request()).toMatchObject({ service_tier: "priority" });
        yield* h.run("settings fast.enabled false");
        expect(yield* h.request()).toBeUndefined();
        yield* h.run("settings fast.enabled true");
        expect(yield* h.request()).toMatchObject({ service_tier: "priority" });
        yield* h.emit("session_shutdown", h.ctx);
      }),
  );

  test.effect(
    "leaves child request routing to the child bridge and does not write back its profile",
    () =>
      Effect.gen(function* () {
        vi.stubEnv("PI_SUBAGENT_OPENAI_FAST_MODE", "ultrafast");
        const h = yield* fastHost({
          child: true,
          config: { persistState: true, desiredActive: true },
        });
        h.getFlag.mockReturnValue(true);
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const config = path.join(h.cwd, ".pi", "extensions", "pi-better-openai.json");
        const original = yield* fs.readFileString(config);
        yield* h.emit("session_start", h.ctx);
        yield* h.run("settings status");
        expect(h.notify.mock.lastCall?.[0]).toContain("ultrafast");
        yield* h.run("settings fast.enabled false");
        yield* h.run("fast");
        expect(yield* h.request()).toBeUndefined();
        expect(yield* h.headers).toEqual({});
        expect(yield* fs.readFileString(config)).toBe(original);
        yield* h.emit("session_shutdown", h.ctx);
      }),
  );
});
