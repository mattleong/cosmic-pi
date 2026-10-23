import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import {
  deferredPromise,
  extensionContextFixture,
  recordingExtensionHost,
  yieldUntil,
} from "pi-cosmic-core/testing";
import { afterEach, describe, expect, vi } from "vitest";
import { registerHerdrBtwApplication } from "../src/application.ts";
import { HERDR_ENVIRONMENT_UNAVAILABLE_MESSAGE } from "../src/btw/admission.ts";

afterEach(() => {
  vi.unstubAllEnvs();
});

type WorkflowLoader = NonNullable<Parameters<typeof registerHerdrBtwApplication>[1]>;
const harness = (load?: WorkflowLoader) => {
  const notify = vi.fn();
  const host = recordingExtensionHost(
    {},
    { registerFlag() {}, getFlag: () => undefined, appendEntry() {} },
  );
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
  registerHerdrBtwApplication(host.pi, load);
  return {
    ctx,
    notify,
    open: () => host.commands.get("herdr-btw")!.handler("", ctx),
    start: () => host.emit("session_start", ctx),
    shutdown: () => host.emit("session_shutdown", ctx),
  };
};

describe("herdr-btw session host capture", () => {
  it.effect("revokes a pending workflow load on shutdown and can start again", () =>
    Effect.gen(function* () {
      vi.stubEnv("HERDR_ENV", "1");
      const pending = deferredPromise<Awaited<ReturnType<WorkflowLoader>>>();
      const load = vi.fn<WorkflowLoader>(() => pending.promise);
      const h = harness(load);
      const starting = h.start();
      yield* yieldUntil(() => load.mock.calls.length > 0);
      yield* Effect.promise(() => h.shutdown());
      yield* Effect.promise(() => starting);
      pending.resolve(
        yield* Effect.promise(() =>
          Promise.all([import("../src/layer.ts"), import("../src/btw/service.ts")]),
        ),
      );
      yield* Effect.promise(() => h.start());
      yield* Effect.promise(() => h.shutdown());
      expect(h.notify).not.toHaveBeenCalled();
    }),
  );

  it.effect("reports an admitted workflow load failure without activating commands", () =>
    Effect.gen(function* () {
      vi.stubEnv("HERDR_ENV", "1");
      const h = harness(() => Promise.reject(new Error("unavailable module")));
      yield* Effect.promise(() => h.start());
      expect(h.notify).toHaveBeenCalled();
      yield* Effect.promise(() => h.shutdown());
    }),
  );

  it.effect("does not report command settlement after the owning session shuts down", () =>
    Effect.gen(function* () {
      vi.stubEnv("HERDR_ENV", "1");
      const h = harness();
      yield* Effect.promise(() => h.start());
      const pending = h.open();
      yield* Effect.promise(() => h.shutdown());
      yield* Effect.promise(() => Promise.resolve(pending));
      expect(h.notify).not.toHaveBeenCalled();
    }),
  );

  it.effect("explains that commands need a Herdr pane when the session runs elsewhere", () =>
    Effect.gen(function* () {
      vi.stubEnv("HERDR_ENV", undefined);
      const load = vi.fn<WorkflowLoader>(() => Promise.reject(new Error("must not load")));
      const h = harness(load);
      yield* Effect.promise(() => h.start());
      yield* Effect.promise(() => Promise.resolve(h.open()));
      expect(load).not.toHaveBeenCalled();
      expect(h.notify).toHaveBeenCalledExactlyOnceWith(
        HERDR_ENVIRONMENT_UNAVAILABLE_MESSAGE,
        "error",
      );
    }),
  );
});
