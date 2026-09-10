import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, OverlayHandle, TUI } from "@earendil-works/pi-tui";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { yieldUntil } from "pi-cosmic-core/testing";
import { describe, expect } from "vitest";
import type { McpAuthAttempt } from "../../src/auth/flow.ts";
import type { McpAuthProgress } from "../../src/auth/progress.ts";
import { presentMcpAuthPanel } from "../../src/boundary/host-auth-panel.ts";

type Factory = Parameters<ExtensionContext["ui"]["custom"]>[0];
type Options = Parameters<ExtensionContext["ui"]["custom"]>[1];
const harness = () => {
  const stack: OverlayHandle[] = [];
  let factory: Factory | undefined;
  let options: Options;
  let doneCount = 0;
  let cancelled = 0;
  let reopened = 0;
  let hidden = false;
  let failGuard = false;
  let active = true;
  let mounted: Component | undefined;
  let snapshot: McpAuthProgress = {
    attemptId: 1,
    server: "owned",
    mode: "local",
    phase: "awaiting-callback",
    startedAt: 0,
    updatedAt: 0,
    deadline: 5_000,
    canReopen: true,
    credentialsSaved: false,
    mutation: "idle",
  };
  const listeners = new Set<() => void>();
  const result = Promise.withResolvers<unknown>();
  const handle = (): OverlayHandle => {
    // SAFETY: This owned overlay fixture is exercised only through hide/setHidden.
    const owned = {
      hide() {
        const index = stack.indexOf(owned);
        if (index !== -1) stack.splice(index, 1);
      },
      setHidden(value: boolean) {
        hidden = value;
      },
    } as OverlayHandle;
    return owned;
  };
  const tuiFixture: Pick<TUI, "requestRender" | "showOverlay"> = {
    requestRender() {},
    showOverlay() {
      if (failGuard) throw new Error("PRIVATE_ERROR");
      const owned = handle();
      stack.push(owned);
      return owned;
    },
  };
  // SAFETY: The auth host uses only these two fixture TUI methods.
  const tui = tuiFixture as TUI;
  // SAFETY: The pure auth view calls only fg/bold on the injected theme.
  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as Theme;
  const keysFixture: Pick<Parameters<Factory>[2], "matches" | "getKeys"> = {
    matches: () => false,
    getKeys: () => [],
  };
  // SAFETY: The manager keymap calls only matches/getKeys on this fixture.
  const keys = keysFixture as Parameters<Factory>[2];
  // SAFETY: Presentation uses mode, trust, UI availability and the owned custom factory only.
  const ctx = {
    mode: "tui",
    hasUI: true,
    isProjectTrusted: () => true,
    ui: {
      custom(fn: Factory, settings: Options) {
        factory = fn;
        options = settings;
        return result.promise;
      },
    },
  } as ExtensionContext;
  const attempt: McpAuthAttempt = {
    snapshot: () => snapshot,
    now: () => 1_000,
    cancel: Effect.sync(() => {
      cancelled++;
    }),
    reopen: Effect.sync(() => {
      reopened++;
    }),
    subscribe: (listener) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          listeners.add(listener);
        }),
        () =>
          Effect.sync(() => {
            listeners.delete(listener);
          }),
      ),
  };
  return {
    ctx,
    attempt,
    stack,
    ready: () => factory !== undefined,
    current: () => active,
    revoke: () => {
      active = false;
    },
    subscriptions: () => listeners.size,
    cancelled: () => cancelled,
    reopened: () => reopened,
    done: () => doneCount,
    hidden: () => hidden,
    failGuard: () => {
      failGuard = true;
    },
    factory: () => {
      const value = factory!(tui, theme, keys, (value) => {
        doneCount++;
        stack.pop();
        result.resolve(value);
      });
      if (!("render" in value)) throw new Error("Unexpected asynchronous auth factory");
      mounted = value;
      return value;
    },
    mount: () => {
      const owned = handle();
      stack.push(owned);
      options?.onHandle?.(owned);
    },
    foreign: () => {
      const owned = handle();
      stack.push(owned);
      return owned;
    },
    input: (data: string) => mounted?.handleInput?.(data),
    update: (change: Partial<McpAuthProgress>) => {
      snapshot = { ...snapshot, ...change };
      for (const listener of listeners) listener();
    },
  };
};

describe("owned auth overlay", () => {
  it.effect("cancels only its attempt and preserves a newer questionnaire overlay", () =>
    Effect.gen(function* () {
      const fixture = harness();
      const panel = yield* presentMcpAuthPanel(fixture.ctx, fixture.attempt, fixture.current).pipe(
        Effect.forkScoped,
      );
      yield* yieldUntil(fixture.ready);
      fixture.factory();
      fixture.mount();
      const foreign = fixture.foreign();
      fixture.input("\u001b");
      yield* Fiber.join(panel);
      expect(fixture.cancelled()).toBe(1);
      expect(fixture.stack).toEqual([foreign]);
      expect(fixture.done()).toBe(1);
      expect(fixture.subscriptions()).toBe(0);
      fixture.input("\r");
      expect(fixture.cancelled()).toBe(1);
    }),
  );

  it.effect("cancellation bypasses an in-flight reopen and duplicate clicks never queue", () =>
    Effect.gen(function* () {
      const fixture = harness();
      let opening = false;
      let released = false;
      const attempt: McpAuthAttempt = {
        ...fixture.attempt,
        reopen: fixture.attempt.reopen.pipe(
          Effect.andThen(
            Effect.sync(() => {
              opening = true;
            }),
          ),
          Effect.andThen(Effect.never),
          Effect.ensuring(
            Effect.sync(() => {
              released = true;
            }),
          ),
        ),
      };
      const panel = yield* presentMcpAuthPanel(fixture.ctx, attempt, fixture.current).pipe(
        Effect.forkScoped,
      );
      yield* yieldUntil(fixture.ready);
      fixture.factory();
      fixture.mount();
      fixture.input("j");
      fixture.input("\r");
      yield* yieldUntil(() => opening);
      fixture.input("\r");
      fixture.input("\r");
      fixture.input("\u001b");
      yield* Fiber.join(panel);
      expect(fixture.cancelled()).toBe(1);
      expect(fixture.reopened()).toBe(1);
      expect(released).toBe(true);
      expect(fixture.subscriptions()).toBe(0);
      fixture.input("\r");
      fixture.input("\u001b");
      expect(fixture.reopened()).toBe(1);
      expect(fixture.cancelled()).toBe(1);
    }),
  );

  for (const afterFactory of [false, true])
    it.effect(
      `protects foreign overlays when cancelled ${afterFactory ? "between factory and mount" : "before a late factory"}`,
      () =>
        Effect.gen(function* () {
          const fixture = harness();
          const panel = yield* presentMcpAuthPanel(
            fixture.ctx,
            fixture.attempt,
            fixture.current,
          ).pipe(Effect.forkScoped);
          yield* yieldUntil(fixture.ready);
          if (afterFactory) fixture.factory();
          yield* Fiber.interrupt(panel);
          const foreign = fixture.foreign();
          expect(fixture.done()).toBe(0);
          if (!afterFactory) expect(fixture.factory().render(40)).toEqual([]);
          fixture.mount();
          expect(fixture.stack).toEqual([foreign]);
          expect(fixture.done()).toBe(1);
          expect(fixture.subscriptions()).toBe(0);
          fixture.input("\r");
          expect(fixture.cancelled()).toBe(0);
        }),
    );

  it.effect("fails closed if the owned-close guard cannot be installed", () =>
    Effect.gen(function* () {
      const fixture = harness();
      const panel = yield* presentMcpAuthPanel(fixture.ctx, fixture.attempt, fixture.current).pipe(
        Effect.result,
        Effect.forkScoped,
      );
      yield* yieldUntil(fixture.ready);
      fixture.factory();
      fixture.mount();
      const foreign = fixture.foreign();
      fixture.failGuard();
      fixture.input("\u001b");
      expect((yield* Fiber.join(panel))._tag).toBe("Failure");
      expect(fixture.stack).toEqual([foreign]);
      expect(fixture.done()).toBe(0);
      expect(fixture.subscriptions()).toBe(0);
    }),
  );

  it.effect("hides during private manual dialogs and revokes stale actions", () =>
    Effect.gen(function* () {
      const fixture = harness();
      const panel = yield* presentMcpAuthPanel(fixture.ctx, fixture.attempt, fixture.current).pipe(
        Effect.forkScoped,
      );
      yield* yieldUntil(fixture.ready);
      fixture.factory();
      fixture.mount();
      fixture.update({ mode: "manual" });
      expect(fixture.hidden()).toBe(true);
      fixture.update({ phase: "exchange" });
      expect(fixture.hidden()).toBe(false);
      fixture.revoke();
      fixture.input("\u001b");
      expect(fixture.cancelled()).toBe(0);
      yield* Fiber.interrupt(panel);
      expect(fixture.stack).toEqual([]);
    }),
  );

  it.effect("never calls custom in RPC or noninteractive modes", () =>
    Effect.gen(function* () {
      for (const mode of ["rpc", "print", "json"] as const) {
        const fixture = harness();
        expect(
          yield* presentMcpAuthPanel(
            { ...fixture.ctx, mode },
            fixture.attempt,
            fixture.current,
          ).pipe(Effect.flip),
        ).toMatchObject({ kind: "unavailable" });
        expect(fixture.ready()).toBe(false);
      }
    }),
  );
});
