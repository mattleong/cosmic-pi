import type { ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, OverlayHandle, TUI } from "@earendil-works/pi-tui";
import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { expect, test, vi } from "vitest";
import { makeAskUserPromptGate } from "../src/boundary/host-prompt.ts";
import { makeAskUserHost } from "../src/boundary/host-dialogs.ts";
import { makeAskUserDialogBridge } from "../src/boundary/host-ui.ts";
import type { AskUserHostError } from "../src/questionnaire/errors.ts";
import type { AskUserOutcome } from "../src/questionnaire/model.ts";
import type { AskUserRequest } from "../src/questionnaire/schema.ts";

// SAFETY: These fixtures provide exactly the opaque Pi/TUI members exercised by this boundary.
const opaque = <A>(value: A): never => value as never;
const request: AskUserRequest = {
  questions: [
    {
      key: "k",
      title: "Title",
      prompt: "Choose",
      mode: "single",
      choices: [
        { value: "a", label: "A", description: "First" },
        { value: "b", label: "B", description: "Second" },
      ],
    },
  ],
};
type Factory = (
  tui: TUI,
  theme: Theme,
  keys: KeybindingsManager,
  done: (outcome: AskUserOutcome) => void,
) => Component;

type Mounted = { readonly onHandle: (handle: OverlayHandle) => void };

// Models the owned public UI boundary, including Pi 0.85's global-pop done bug.
const hostFixture = () => {
  const stack: Component[] = [];
  let mount: (() => void) | undefined;
  let component: Component | undefined;
  const theme = opaque({
    fg: (_c: string, s: string) => s,
    bg: (_c: string, s: string) => s,
    bold: (s: string) => s,
  });
  const showOverlay = (item: Component) => {
    stack.push(item);
    return opaque({
      hide: () => {
        const i = stack.indexOf(item);
        if (i >= 0) stack.splice(i, 1);
      },
      setHidden: vi.fn(),
      focus: vi.fn(),
    });
  };
  const tui: TUI = opaque({ requestRender: vi.fn(), showOverlay });
  const done = vi.fn();
  const custom = (factory: Factory, options: Mounted) => {
    // SAFETY: Supported Node versions provide withResolvers, omitted by the ES2023 lib.
    const completed = (
      Promise as PromiseConstructor & {
        withResolvers<A>(): { promise: Promise<A>; resolve: (value: A) => void };
      }
    ).withResolvers<AskUserOutcome>();
    component = factory(
      tui,
      theme,
      opaque({
        matches: (data: string, key: string) => data === "\r" && key === "tui.select.confirm",
      }),
      (outcome) => {
        done(outcome);
        stack.pop();
        completed.resolve(outcome);
      },
    );
    const owned = component;
    mount = () => options.onHandle(showOverlay(owned));
    return completed.promise;
  };
  const ctx: ExtensionContext = opaque({
    mode: "tui",
    hasUI: true,
    cwd: process.cwd(),
    ui: { custom },
    isProjectTrusted: () => true,
  });
  return {
    ctx,
    stack,
    showOverlay,
    done,
    get mount() {
      return mount;
    },
    get component() {
      return component;
    },
  };
};
const foreign: Component = { render: () => ["foreign"], invalidate: () => {} };

it.effect("the opening handshake waits for mounting, not just the custom factory", () =>
  Effect.gen(function* () {
    const h = hostFixture();
    const opened = yield* Deferred.make<void, AskUserHostError>();
    const controller = new AbortController();
    const pending = Effect.runPromise(
      makeAskUserHost(h.ctx, makeAskUserDialogBridge())(request, opened),
      { signal: controller.signal },
    );
    yield* Effect.promise(() => vi.waitFor(() => expect(h.mount).toBeDefined()));
    expect(yield* Deferred.isDone(opened)).toBe(false);
    h.mount!();
    expect(yield* Deferred.isDone(opened)).toBe(true);
    controller.abort();
    yield* Effect.promise(() => expect(pending).rejects.toBeDefined());
    expect(h.stack).toEqual([]);
  }),
);

it.effect("cancelling a hidden questionnaire preserves an unrelated overlay mounted above it", () =>
  Effect.gen(function* () {
    const h = hostFixture();
    const bridge = makeAskUserDialogBridge();
    const controller = new AbortController();
    const pending = Effect.runPromise(makeAskUserHost(h.ctx, bridge)(request), {
      signal: controller.signal,
    });
    yield* Effect.promise(() => vi.waitFor(() => expect(h.mount).toBeDefined()));
    h.mount!();
    h.component!.handleInput?.("b");
    h.showOverlay(foreign);
    controller.abort();
    yield* Effect.promise(() => expect(pending).rejects.toBeDefined());
    expect(h.stack).toEqual([foreign]);
    expect(h.done).toHaveBeenCalledOnce();
    expect(bridge.resume()).toBe(false);
  }),
);

it.effect(
  "abort before mounting never pops a foreign overlay and late mount cleans only its owner",
  () =>
    Effect.gen(function* () {
      const h = hostFixture();
      const bridge = makeAskUserDialogBridge();
      h.showOverlay(foreign);
      const controller = new AbortController();
      const pending = Effect.runPromise(makeAskUserHost(h.ctx, bridge)(request), {
        signal: controller.signal,
      });
      yield* Effect.promise(() => vi.waitFor(() => expect(h.mount).toBeDefined()));
      controller.abort();
      yield* Effect.promise(() => expect(pending).rejects.toBeDefined());
      expect(h.done).not.toHaveBeenCalled();
      expect(h.stack).toEqual([foreign]);
      h.mount!();
      expect(h.stack).toEqual([foreign]);
      expect(h.done).toHaveBeenCalledOnce();
      expect(bridge.resume()).toBe(false);
    }),
);

it.effect("a throwing host done still removes the guard and owned questionnaire", () =>
  Effect.gen(function* () {
    const h = hostFixture();
    h.done.mockImplementation(() => {
      throw new Error("host failure");
    });
    const controller = new AbortController();
    const pending = Effect.runPromise(makeAskUserHost(h.ctx, makeAskUserDialogBridge())(request), {
      signal: controller.signal,
    });
    yield* Effect.promise(() => vi.waitFor(() => expect(h.mount).toBeDefined()));
    h.mount!();
    h.showOverlay(foreign);
    controller.abort();
    yield* Effect.promise(() => expect(pending).rejects.toBeDefined());
    expect(h.stack).toEqual([foreign]);
  }),
);

it.effect(
  "normal submission also preserves an unrelated overlay and the authoritative answer",
  () =>
    Effect.gen(function* () {
      const h = hostFixture();
      const pending = Effect.runPromise(makeAskUserHost(h.ctx, makeAskUserDialogBridge())(request));
      yield* Effect.promise(() => vi.waitFor(() => expect(h.mount).toBeDefined()));
      h.mount!();
      h.showOverlay(foreign);
      h.component!.handleInput?.("1");
      h.component!.handleInput?.("\r");
      expect((yield* Effect.promise(() => pending)).outcome).toBe("submitted");
      expect(h.stack).toEqual([foreign]);
      expect(h.done).toHaveBeenCalledOnce();
    }),
);

it.effect(
  "a competing prompt during lazy loading prevents custom mounting without taking focus",
  () =>
    Effect.gen(function* () {
      const h = hostFixture();
      const gate = makeAskUserPromptGate();
      h.showOverlay(foreign);
      const opened = yield* Deferred.make<void, AskUserHostError>();
      expect(gate.canOpen()).toBe(true);
      const pending = Effect.runPromise(
        makeAskUserHost(h.ctx, makeAskUserDialogBridge(), gate)(request, opened),
      );
      gate.started();
      yield* Effect.promise(() =>
        expect(pending).rejects.toMatchObject({ _tag: "AskUserHostError" }),
      );
      expect(h.mount).toBeUndefined();
      expect(h.stack).toEqual([foreign]);
      expect(gate.canOpen()).toBe(false);
      gate.ended();
      expect(gate.canOpen()).toBe(true);
    }),
);

test("own prompt cleanup does not release a coalesced foreign prompt", () => {
  const gate = makeAskUserPromptGate();
  const release = gate.enter();
  gate.started();
  // A foreign nested prompt produces no second start event in Pi.
  release();
  expect(gate.canOpen()).toBe(false);
  gate.ended();
  expect(gate.canOpen()).toBe(true);
});
