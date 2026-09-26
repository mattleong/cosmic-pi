import type { Component } from "@earendil-works/pi-tui";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { yieldUntil } from "pi-cosmic-core/testing";
import { fakeCustomSurfaceHost } from "pi-cosmic-ui/testing";
import { describe, expect } from "vitest";
import type { McpAuthAttempt } from "../../src/auth/flow.ts";
import type { McpAuthProgress } from "../../src/auth/progress.ts";
import { presentMcpAuthPanel } from "../../src/boundary/host-auth-panel.ts";

const harness = () => {
  const host = fakeCustomSurfaceHost({ rows: 40 });
  let cancelled = 0;
  let reopened = 0;
  let active = true;
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
  let input: Component | undefined;
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
    host,
    ctx: { ...host.ctx, isProjectTrusted: () => true },
    attempt,
    current: () => active,
    revoke: () => {
      active = false;
    },
    /** Waits for the panel's dock, then mounts it and keeps its keyboard overlay. */
    open: Effect.gen(function* () {
      yield* yieldUntil(() => host.widgets.size > 0);
      const before = host.overlays;
      host.mount();
      input = host.overlays.find((overlay) => !before.includes(overlay));
    }),
    widget: () => [...host.widgets.values()][0]!,
    subscriptions: () => listeners.size,
    cancelled: () => cancelled,
    reopened: () => reopened,
    input: (data: string) => input?.handleInput?.(data),
    update: (change: Partial<McpAuthProgress>) => {
      snapshot = { ...snapshot, ...change };
      for (const listener of listeners) listener();
    },
  };
};
const foreignView = (): Component => ({ render: () => ["foreign"], invalidate() {} });

describe("owned auth panel", () => {
  it.effect("draws above the input while the overlay only captures keyboard input", () =>
    Effect.gen(function* () {
      const fixture = harness();
      const panel = yield* presentMcpAuthPanel(fixture.ctx, fixture.attempt, fixture.current).pipe(
        Effect.forkScoped,
      );
      yield* fixture.open;
      const widget = fixture.widget();
      const [input] = fixture.host.overlays;
      expect(widget.render(160).length).toBeGreaterThan(0);
      expect(input?.render(160)).toEqual([]);
      fixture.host.terminal.columns = 80;
      expect(widget.render(80).length).toBeGreaterThan(0);
      yield* Fiber.interrupt(panel);
      expect(fixture.host.widgets.size).toBe(0);
      expect(widget.render(80)).toEqual([]);
    }),
  );
  for (const mode of ["local", "manual"] as const)
    it.effect(`yields to stock scope consent and restores only its current ${mode} panel`, () =>
      Effect.gen(function* () {
        const fixture = harness();
        fixture.update({ mode, phase: "scope-approval" });
        const panel = yield* presentMcpAuthPanel(
          fixture.ctx,
          fixture.attempt,
          fixture.current,
        ).pipe(Effect.forkScoped);
        yield* fixture.open;
        expect(fixture.host.overlays).toEqual([]);
        const widget = fixture.widget();
        expect(widget.render(160)).toEqual([]);
        fixture.update({ phase: "registration" });
        expect(fixture.host.overlays).toHaveLength(1);
        expect(widget.render(160).length).toBeGreaterThan(0);
        fixture.update({ phase: "scope-approval" });
        const foreign = foreignView();
        fixture.host.showUnrelated(foreign);
        fixture.revoke();
        fixture.update({ phase: "registration" });
        expect(fixture.host.overlays).toEqual([foreign]);
        yield* Fiber.interrupt(panel);
        expect(fixture.host.overlays).toEqual([foreign]);
        expect(fixture.subscriptions()).toBe(0);
      }),
    );
  it.effect("cancels only its attempt and preserves a newer questionnaire overlay", () =>
    Effect.gen(function* () {
      const fixture = harness();
      const panel = yield* presentMcpAuthPanel(fixture.ctx, fixture.attempt, fixture.current).pipe(
        Effect.forkScoped,
      );
      yield* fixture.open;
      const foreign = foreignView();
      fixture.host.showUnrelated(foreign);
      fixture.input("\u001b");
      yield* Fiber.join(panel);
      expect(fixture.cancelled()).toBe(1);
      expect(fixture.host.overlays).toEqual([foreign]);
      expect(fixture.host.doneCalls).toBe(1);
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
      yield* fixture.open;
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

  it.effect("protects foreign overlays when cancelled between factory and mount", () =>
    Effect.gen(function* () {
      const fixture = harness();
      const panel = yield* presentMcpAuthPanel(fixture.ctx, fixture.attempt, fixture.current).pipe(
        Effect.forkScoped,
      );
      yield* yieldUntil(() => fixture.host.widgets.size > 0);
      yield* Fiber.interrupt(panel);
      const foreign = foreignView();
      fixture.host.showUnrelated(foreign);
      expect(fixture.host.doneCalls).toBe(0);
      expect(fixture.host.widgets.size).toBe(0);
      fixture.host.mount();
      expect(fixture.host.widgets.size).toBe(0);
      expect(fixture.host.overlays).toEqual([foreign]);
      expect(fixture.host.doneCalls).toBe(1);
      expect(fixture.subscriptions()).toBe(0);
      expect(fixture.cancelled()).toBe(0);
    }),
  );

  it.effect("fails closed if the owned-close guard cannot be installed", () =>
    Effect.gen(function* () {
      const fixture = harness();
      const panel = yield* presentMcpAuthPanel(fixture.ctx, fixture.attempt, fixture.current).pipe(
        Effect.flip,
        Effect.forkScoped,
      );
      yield* fixture.open;
      const foreign = foreignView();
      fixture.host.showUnrelated(foreign);
      fixture.host.fail("guardShow");
      fixture.input("\u001b");
      expect(yield* Fiber.join(panel)).toMatchObject({ kind: "unavailable" });
      expect(fixture.host.overlays).toEqual([foreign]);
      expect(fixture.host.doneCalls).toBe(0);
      expect(fixture.host.widgets.size).toBe(0);
      expect(fixture.subscriptions()).toBe(0);
    }),
  );

  it.effect("hides during private manual dialogs and revokes stale actions", () =>
    Effect.gen(function* () {
      const fixture = harness();
      const panel = yield* presentMcpAuthPanel(fixture.ctx, fixture.attempt, fixture.current).pipe(
        Effect.forkScoped,
      );
      yield* fixture.open;
      fixture.update({ mode: "manual" });
      expect(fixture.host.overlays).toEqual([]);
      fixture.update({ phase: "exchange" });
      expect(fixture.host.overlays).toHaveLength(1);
      fixture.revoke();
      fixture.input("\u001b");
      expect(fixture.cancelled()).toBe(0);
      yield* Fiber.interrupt(panel);
      expect(fixture.host.overlays).toEqual([]);
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
        expect(fixture.host.widgets.size).toBe(0);
      }
    }),
  );
});
