import type { ExtensionHandler } from "@earendil-works/pi-coding-agent";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { extensionApiFixture, extensionContextFixture } from "pi-cosmic-core/testing";
import { describe, expect, vi } from "vitest";
import { registerHerdrBtwApplication } from "../src/application.ts";

type Handler = ExtensionHandler<any, any>;

const harness = () => {
  const handlers = new Map<string, Handler[]>();
  const notify = vi.fn();
  const pi = extensionApiFixture({
    on(name: string, handler: Handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerCommand() {},
    registerFlag() {},
    getFlag: () => undefined,
    appendEntry() {},
  });
  const ctx = extensionContextFixture({
    cwd: "/project",
    mode: "tui" as const,
    hasUI: true,
    sessionManager: {
      getSessionFile: () => "/sessions/parent.jsonl",
      getSessionId: () => "parent-session",
      getSessionDir: () => "/sessions",
      getEntries: () => [],
      getHeader: () => null,
    },
    ui: { notify },
  });
  registerHerdrBtwApplication(pi);
  const invokeAll = <EventInput>(name: string, event: EventInput) =>
    Promise.all((handlers.get(name) ?? []).map((handler) => handler(event, ctx)));
  return {
    ctx,
    notify,
    start: () => invokeAll("session_start", { type: "session_start" }),
    shutdown: () => invokeAll("session_shutdown", { reason: "quit" }),
  };
};

describe("herdr-btw session host capture", () => {
  it.effect("materializes cwd and signal once without rereading raw host values", () =>
    Effect.gen(function* () {
      const h = harness();
      const controller = new AbortController();
      let cwdReads = 0;
      let signalReads = 0;
      Object.defineProperties(h.ctx, {
        cwd: {
          configurable: true,
          get() {
            cwdReads++;
            if (cwdReads > 1) throw new Error("host-cwd-reread-secret");
            return "/project";
          },
        },
        signal: {
          configurable: true,
          get() {
            signalReads++;
            if (signalReads > 1) throw new Error("host-signal-reread-secret");
            return controller.signal;
          },
        },
      });

      yield* Effect.promise(() => h.start());

      expect(cwdReads).toBe(1);
      expect(signalReads).toBe(1);
      expect(h.notify).not.toHaveBeenCalled();
      yield* Effect.promise(() => h.shutdown());
    }),
  );

  it.effect("fails closed when the host signal cannot be captured safely", () =>
    Effect.gen(function* () {
      const setups: ReadonlyArray<(ctx: ReturnType<typeof harness>["ctx"]) => void> = [
        (ctx) =>
          void Object.defineProperty(ctx, "signal", {
            configurable: true,
            get() {
              throw new Error("host-signal-secret");
            },
          }),
        (ctx) => {
          const controller = new AbortController();
          controller.abort();
          ctx.signal = controller.signal;
        },
        (ctx) =>
          void Object.defineProperty(ctx, "signal", {
            configurable: true,
            value: Object.defineProperty({}, "aborted", {
              get() {
                throw new Error("host-aborted-secret");
              },
            }),
          }),
      ];

      for (const setup of setups) {
        const h = harness();
        setup(h.ctx);
        yield* Effect.promise(() => h.start());
        expect(h.notify).toHaveBeenCalledOnce();
        expect(h.notify).toHaveBeenCalledWith(expect.any(String), "error");
      }
    }),
  );
});
