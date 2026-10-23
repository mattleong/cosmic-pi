import { registerSessionResourceCleanup } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { expect, layer } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import { nodeFilePlatformLayer } from "pi-cosmic-core";
import {
  extensionContextFixture,
  type ExtensionEventName,
  type ExtensionEventNamed,
} from "pi-cosmic-core/testing";
import { afterEach, vi } from "vitest";
import { resetOpenAICodexTransport } from "../src/boundary/host-codex-transport.ts";
import { extensionHarness } from "./extension-harness.ts";
import { testModel } from "./helpers.ts";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const transportHarness = Effect.gen(function* () {
  const reset = vi.fn<(ctx: ExtensionContext) => void>();
  const h = yield* extensionHarness({ dependencies: { resetOpenAICodexTransport: reset } });
  let idle = true;
  const ctx = { ...h.ctx, isIdle: () => idle };
  const deliver = <Name extends ExtensionEventName>(name: Name, event: ExtensionEventNamed<Name>) =>
    Effect.promise(() =>
      Promise.all(Arr.map(h.handlers.get(name), (handler) => Promise.resolve(handler(event, ctx)))),
    ).pipe(Effect.asVoid);
  yield* h.emit("session_start", ctx);
  reset.mockClear();
  return {
    ...h,
    ctx,
    reset,
    deliver,
    setIdle: (value: boolean) => {
      idle = value;
    },
    toggleFast: Effect.promise(() =>
      Promise.resolve(h.commands.get("openai")?.handler("fast", ctx)),
    ),
    selectModel: deliver("model_select", {
      type: "model_select",
      model: testModel(),
      previousModel: undefined,
      source: "set",
    }),
    providerRequest: deliver("before_provider_headers", {
      type: "before_provider_headers",
      headers: {},
    }),
  };
});

layer(nodeFilePlatformLayer)("Codex transport reset", (it) => {
  it.effect("resets immediately when fast mode changes while the session is idle", () =>
    Effect.gen(function* () {
      const h = yield* transportHarness;
      yield* h.toggleFast;
      expect(h.reset).toHaveBeenCalledOnce();
      expect(h.reset).toHaveBeenCalledWith(h.ctx);
      yield* h.providerRequest;
      expect(h.reset).toHaveBeenCalledOnce();
      yield* h.emit("session_shutdown", h.ctx);
    }),
  );

  it.effect("defers resets requested during a reply until the next provider request", () =>
    Effect.gen(function* () {
      const h = yield* transportHarness;
      h.setIdle(false);
      yield* h.toggleFast;
      yield* h.selectModel;
      expect(h.reset).not.toHaveBeenCalled();
      yield* h.providerRequest;
      expect(h.reset).toHaveBeenCalledOnce();
      yield* h.providerRequest;
      expect(h.reset).toHaveBeenCalledOnce();
      yield* h.emit("session_shutdown", h.ctx);
    }),
  );

  it.effect("keeps a deferred reset across an aborted run", () =>
    Effect.gen(function* () {
      const h = yield* transportHarness;
      h.setIdle(false);
      yield* h.toggleFast;
      yield* h.emit("agent_end", h.ctx);
      yield* h.deliver("agent_settled", { type: "agent_settled", aborted: true });
      h.setIdle(true);
      yield* h.providerRequest;
      expect(h.reset).toHaveBeenCalledOnce();
      yield* h.providerRequest;
      expect(h.reset).toHaveBeenCalledOnce();
      yield* h.emit("session_shutdown", h.ctx);
    }),
  );

  it.effect("cleans up only the requesting session's provider resources", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const cleaned: Array<string | undefined> = [];
        const unregister = registerSessionResourceCleanup((sessionId) => {
          cleaned.push(sessionId);
        });
        return { cleaned, unregister };
      }),
      ({ cleaned }) =>
        Effect.sync(() => {
          for (const sessionId of ["", "session-a"])
            resetOpenAICodexTransport(
              extensionContextFixture({ sessionManager: { getSessionId: () => sessionId } }),
            );
          expect(cleaned).toEqual(["session-a"]);
        }),
      ({ unregister }) => Effect.sync(unregister),
    ),
  );

  it.effect("drops a deferred reset when its session shuts down", () =>
    Effect.gen(function* () {
      const h = yield* transportHarness;
      h.setIdle(false);
      yield* h.toggleFast;
      yield* h.emit("session_shutdown", h.ctx);
      yield* h.providerRequest;
      expect(h.reset).not.toHaveBeenCalled();
    }),
  );
});
