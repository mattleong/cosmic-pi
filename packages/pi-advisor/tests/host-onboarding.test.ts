import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { vi } from "vitest";
import { selectAdvisorOnboardingAtHostBoundary } from "../src/boundary/host-onboarding.ts";

// SAFETY: The shared model picker uses only these Theme methods.
const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as Theme;

const context = (options: {
  readonly inputs: ReadonlyArray<string>;
  readonly models?: ReadonlyArray<{ readonly provider: string; readonly id: string }>;
  readonly scoped?: ReadonlyArray<{ readonly provider: string; readonly id: string }>;
  readonly manualMount?: boolean;
  readonly lateFactory?: boolean;
  readonly cleanupFailure?: "guard" | "owned-hide" | "guard-hide" | "done";
}) => {
  const models = [...(options.models ?? [])];
  const scoped = [...(options.scoped ?? [])];
  const stack: Component[] = [];
  const done = vi.fn();
  if (options.cleanupFailure === "done")
    done.mockImplementation(() => {
      throw new Error("host cleanup failed");
    });
  let mount: (() => void) | undefined;
  let invoke: (() => void) | undefined;
  let component: Component | undefined;
  const showOverlay = (item: Component, overlayOptions?: { nonCapturing?: boolean }) => {
    if (overlayOptions?.nonCapturing && options.cleanupFailure === "guard")
      throw new Error("host guard failed");
    stack.push(item);
    // SAFETY: The boundary uses only the handle's identity-removing hide method.
    return {
      hide: () => {
        const index = stack.indexOf(item);
        if (index >= 0) stack.splice(index, 1);
        if (
          (item === component && options.cleanupFailure === "owned-hide") ||
          (overlayOptions?.nonCapturing && options.cleanupFailure === "guard-hide")
        )
          throw new Error("host hide failed");
      },
    } as never;
  };
  const custom: ExtensionContext["ui"]["custom"] = (factory, customOptions) =>
    Effect.runPromise(
      Effect.callback((resume) => {
        let closed = false;
        const tuiFixture = { terminal: { rows: 14 }, requestRender: vi.fn(), showOverlay };
        // SAFETY: The picker reads only terminal rows and requestRender from this TUI fixture.
        const tui = tuiFixture as never;
        const keybindingsFixture = { matches: () => false, getKeys: () => [] };
        // SAFETY: The picker reads only matches and getKeys from this keybinding fixture.
        const keybindings = keybindingsFixture as never;
        invoke = () => {
          const created = factory(tui, theme, keybindings, (result) => {
            if (closed) return;
            closed = true;
            done(result);
            stack.pop(); // Pinned Pi's global-pop cleanup.
            resume(Effect.succeed(result));
          });
          Promise.resolve(created).then((ready) => {
            component = ready;
            mount = () => {
              if (closed) return;
              const handle = showOverlay(ready);
              customOptions?.onHandle?.(handle);
            };
            if (!options.manualMount) mount();
            for (const input of options.inputs) ready.handleInput?.(input);
          });
        };
        if (!options.lateFactory) invoke();
      }),
    );
  const fixture = {
    mode: "tui" as const,
    hasUI: true,
    model: models[0],
    scopedModels: scoped.map((model) => ({ model })),
    modelRegistry: { getAvailable: () => models },
    ui: { custom, notify: vi.fn(), select: vi.fn() },
    stack,
    done,
    showOverlay,
    get mount() {
      return mount;
    },
    get invoke() {
      return invoke;
    },
    get component() {
      return component;
    },
  };
  // SAFETY: This boundary fixture implements exactly the context members read by onboarding.
  return fixture as typeof fixture & ExtensionContext;
};

describe("Advisor model onboarding", () => {
  it.effect("starts scoped and can select from all authenticated models with Tab", () =>
    Effect.gen(function* () {
      const models = [
        { provider: "openai", id: "scoped" },
        { provider: "anthropic", id: "all-only" },
      ];
      const result = yield* selectAdvisorOnboardingAtHostBoundary(
        context({ inputs: ["\t", "k", "\r"], models, scoped: [models[0]!] }),
      );
      expect(result).toEqual({ type: "model", provider: "anthropic", model: "all-only" });
    }),
  );

  it.effect("keeps the explicit Not now action", () =>
    Effect.gen(function* () {
      const result = yield* selectAdvisorOnboardingAtHostBoundary(context({ inputs: ["\r"] }));
      expect(result).toEqual({ type: "not-now" });
    }),
  );

  it.effect("treats Esc as cancellation rather than dismissal", () =>
    Effect.gen(function* () {
      const result = yield* selectAdvisorOnboardingAtHostBoundary(
        context({ inputs: ["\x1b"], models: [{ provider: "openai", id: "model" }] }),
      );
      expect(result).toBeUndefined();
    }),
  );
});

const foreign: Component = { render: () => [], invalidate: () => {} };

for (const input of ["\r", "\x1b"]) {
  it.effect(`picker completion preserves foreign overlays (${JSON.stringify(input)})`, () =>
    Effect.gen(function* () {
      const h = context({ inputs: [], manualMount: true });
      const pending = Effect.runPromise(selectAdvisorOnboardingAtHostBoundary(h));
      yield* Effect.promise(() => vi.waitFor(() => expect(h.mount).toBeDefined()));
      h.mount!();
      h.showOverlay(foreign);
      h.component!.handleInput?.(input);
      const result = yield* Effect.promise(() => pending);
      expect(result).toEqual(input === "\r" ? { type: "not-now" } : undefined);
      expect(h.stack).toEqual([foreign]);
      expect(h.done).toHaveBeenCalledOnce();
    }),
  );
}

for (const lateFactory of [false, true]) {
  it.effect(
    `cancellation before mount latches identity cleanup (late factory: ${lateFactory})`,
    () =>
      Effect.gen(function* () {
        const h = context({ inputs: [], manualMount: true, lateFactory });
        h.showOverlay(foreign);
        const controller = new AbortController();
        const pending = Effect.runPromise(selectAdvisorOnboardingAtHostBoundary(h), {
          signal: controller.signal,
        });
        yield* Effect.promise(() =>
          vi.waitFor(() => expect(lateFactory ? h.invoke : h.mount).toBeDefined()),
        );
        controller.abort();
        yield* Effect.promise(() => expect(pending).rejects.toBeDefined());
        expect(h.stack).toEqual([foreign]);
        expect(h.done).not.toHaveBeenCalled();
        if (lateFactory) h.invoke!();
        yield* Effect.promise(() => vi.waitFor(() => expect(h.mount).toBeDefined()));
        h.mount!();
        h.component!.handleInput?.("\r");
        expect(h.stack).toEqual([foreign]);
        expect(h.done).toHaveBeenCalledExactlyOnceWith(undefined);
      }),
  );
}

for (const cleanupFailure of ["guard", "owned-hide", "guard-hide", "done"] as const) {
  for (const input of ["\x1b", "\r"]) {
    it.effect(
      `normal completion settles typed cleanup failure (${cleanupFailure}, ${JSON.stringify(input)})`,
      () =>
        Effect.gen(function* () {
          const h = context({ inputs: [], manualMount: true, cleanupFailure });
          const pending = Effect.runPromise(Effect.flip(selectAdvisorOnboardingAtHostBoundary(h)));
          yield* Effect.promise(() => vi.waitFor(() => expect(h.mount).toBeDefined()));
          h.mount!();
          h.showOverlay(foreign);
          h.component!.handleInput?.(input);
          const failure = yield* Effect.promise(() => pending);
          expect(failure).toMatchObject({ _tag: "PiCommandError", operation: "model selection" });
          expect(failure.message).not.toContain("host");
          h.component!.handleInput?.(input);
          expect(h.stack).toEqual([foreign]);
          if (cleanupFailure === "guard" || cleanupFailure === "owned-hide")
            expect(h.done).not.toHaveBeenCalled();
          else expect(h.done).toHaveBeenCalledOnce();
        }),
    );
  }
}

it.effect("interruption contains throwing done and releases only owned overlays once", () =>
  Effect.gen(function* () {
    const h = context({ inputs: [], manualMount: true });
    h.done.mockImplementation(() => {
      throw new Error("host failure");
    });
    const controller = new AbortController();
    const pending = Effect.runPromise(selectAdvisorOnboardingAtHostBoundary(h), {
      signal: controller.signal,
    });
    yield* Effect.promise(() => vi.waitFor(() => expect(h.mount).toBeDefined()));
    h.mount!();
    h.showOverlay(foreign);
    controller.abort();
    yield* Effect.promise(() => expect(pending).rejects.toBeDefined());
    controller.abort();
    h.component!.handleInput?.("\r");
    expect(h.stack).toEqual([foreign]);
    expect(h.done).toHaveBeenCalledOnce();
  }),
);
