import { ordinalChoices, defaultQuestion } from "./support/questionnaire.ts";
import type { ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, OverlayHandle, TUI } from "@earendil-works/pi-tui";
import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as externalEditor from "../src/boundary/host-external-editor.ts";
import { makeQuestionnaireQueue } from "../src/questionnaire/queue.ts";
import { expect, test, vi } from "vitest";
import { makeAskUserPromptGate } from "../src/boundary/host-prompt.ts";
import { makeAskUserHost } from "../src/boundary/host-dialogs.ts";
import { makeAskUserDialogBridge } from "../src/boundary/host-ui.ts";
import { AskUserHostError } from "../src/questionnaire/errors.ts";
import type { AskUserOutcome } from "../src/questionnaire/model.ts";
import type { AskUserRequest } from "../src/questionnaire/schema.ts";

// SAFETY: These fixtures provide exactly the opaque Pi/TUI members exercised by this boundary.
const opaque = <A>(value: A): never => value as never;
const request: AskUserRequest = {
  questions: [
    {
      ...defaultQuestion,
      key: "k",
      title: "Title",
      prompt: "Choose",
      choices: ordinalChoices,
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
const hostFixture = (gate?: ReturnType<typeof makeAskUserPromptGate>) => {
  const stack: Component[] = [];
  const ownedHide = vi.fn();
  const guardHide = vi.fn();
  const createGuard = vi.fn();
  let customCalls = 0;
  let mount: (() => void) | undefined;
  let component: Component | undefined;
  const theme = opaque({
    fg: (_c: string, s: string) => s,
    bg: (_c: string, s: string) => s,
    bold: (s: string) => s,
  });
  const showOverlay = (item: Component, hide?: () => void) => {
    stack.push(item);
    return opaque({
      hide: () => {
        hide?.();
        const i = stack.indexOf(item);
        if (i >= 0) stack.splice(i, 1);
      },
      setHidden: vi.fn(),
      focus: vi.fn(),
    });
  };
  const tui: TUI = opaque({
    requestRender: vi.fn(),
    showOverlay: (item: Component) => {
      createGuard();
      return showOverlay(item, guardHide);
    },
  });
  const done = vi.fn();
  const custom = (factory: Factory, options: Mounted) => {
    customCalls++;
    gate?.started();
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
        matches: (data: string, key: string) =>
          (data === "\r" && key === "tui.select.confirm") ||
          (data === "external" && key === "app.editor.external") ||
          (data === "\u001b" && key === "tui.select.cancel"),
      }),
      (outcome) => {
        done(outcome);
        stack.pop();
        completed.resolve(outcome);
      },
    );
    const owned = component;
    mount = () => options.onHandle(showOverlay(owned, ownedHide));
    return completed.promise.finally(() => gate?.ended());
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
    ownedHide,
    guardHide,
    createGuard,
    get customCalls() {
      return customCalls;
    },
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

for (const fault of ["ownedHide", "createGuard", "done", "guardHide"] as const) {
  it.effect(`normal submission rejects a throwing ${fault} and releases its FIFO ticket`, () =>
    Effect.gen(function* () {
      const gate = makeAskUserPromptGate();
      const h = hostFixture(gate);
      const bridge = makeAskUserDialogBridge();
      const host = makeAskUserHost(h.ctx, bridge, gate);
      const queue = yield* makeQuestionnaireQueue;
      const first = yield* queue.admit;
      const second = yield* queue.admit;
      const firstFiber = yield* first
        .run(host(request))
        .pipe(Effect.ensuring(first.close), Effect.exit, Effect.forkChild);
      const successorAdmitted = yield* Deferred.make<void>();
      const secondFiber = yield* second
        .run(
          Deferred.succeed(successorAdmitted, undefined).pipe(
            Effect.andThen(host(request, undefined, true)),
          ),
        )
        .pipe(Effect.ensuring(second.close), Effect.forkChild);
      yield* Effect.promise(() => vi.waitFor(() => expect(h.mount).toBeDefined()));
      h.mount!();
      const oldComponent = h.component!;
      h.showOverlay(foreign);
      h[fault].mockImplementationOnce(() => {
        oldComponent.handleInput?.("\r"); // Reentrant finish must not acquire or pop twice.
        throw new Error("secret host path /private/questionnaire");
      });
      oldComponent.handleInput?.("1");
      expect(() => oldComponent.handleInput?.("\r")).not.toThrow();
      const result = yield* Fiber.join(firstFiber);
      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isFailure(result)) {
        const error = Cause.squash(result.cause);
        expect(error).toMatchObject({ _tag: "AskUserHostError" });
        expect(String(error)).not.toContain("secret");
        expect(error).toEqual(
          new AskUserHostError({
            operation: "render",
            message: "Unable to render the user questionnaire.",
          }),
        );
      }
      expect(h.stack).toEqual(fault === "ownedHide" ? [oldComponent, foreign] : [foreign]);
      expect(h.ownedHide).toHaveBeenCalledOnce();
      expect(h.done).toHaveBeenCalledTimes(fault === "done" || fault === "guardHide" ? 1 : 0);
      expect(h.guardHide).toHaveBeenCalledTimes(fault === "done" || fault === "guardHide" ? 1 : 0);
      expect(bridge.resume()).toBe(false);
      // The ticket advances independently of Pi's possibly nonsettling custom Promise.
      yield* Deferred.await(successorAdmitted);
      if (fault !== "guardHide") {
        expect(gate.canOpen()).toBe(false);
        expect(h.customCalls).toBe(1);
        // Only a real public end (e.g. host recovery) permits the next mount.
        // Never synthesize this in the boundary: a coalesced foreign prompt may own it.
        gate.ended();
      }
      yield* Effect.promise(() => vi.waitFor(() => expect(h.customCalls).toBe(2)));
      h.mount!();
      h.component!.handleInput?.("1");
      h.component!.handleInput?.("\r");
      expect((yield* Fiber.join(secondFiber)).outcome).toBe("submitted");
      expect(h.stack).toContain(foreign);
      oldComponent.handleInput?.("\r");
      expect(h.ownedHide).toHaveBeenCalledTimes(2);
    }),
  );
}

for (const fail of [false, true]) {
  it.effect(`a pre-mount answer finishes only after handle acquisition (failure: ${fail})`, () =>
    Effect.gen(function* () {
      const h = hostFixture();
      const pending = yield* makeAskUserHost(
        h.ctx,
        makeAskUserDialogBridge(),
      )(request).pipe(Effect.exit, Effect.forkChild);
      yield* Effect.promise(() => vi.waitFor(() => expect(h.mount).toBeDefined()));
      h.showOverlay(foreign);
      h.component!.handleInput?.("1");
      h.component!.handleInput?.("\r");
      expect(h.done).not.toHaveBeenCalled();
      expect(h.stack).toEqual([foreign]);
      if (fail)
        h.done.mockImplementationOnce(() => {
          throw new Error("private finish failure");
        });
      expect(() => h.mount!()).not.toThrow();
      const result = yield* Fiber.join(pending);
      if (fail) {
        expect(Exit.isFailure(result)).toBe(true);
        if (Exit.isFailure(result))
          expect(Cause.squash(result.cause)).toMatchObject({ _tag: "AskUserHostError" });
      } else {
        expect(Exit.isSuccess(result)).toBe(true);
        if (Exit.isSuccess(result)) expect(result.value.outcome).toBe("submitted");
      }
      expect(h.stack).toEqual([foreign]);
      expect(h.done).toHaveBeenCalledOnce();
      expect(h.ownedHide).toHaveBeenCalledOnce();
      expect(h.guardHide).toHaveBeenCalledOnce();
    }),
  );
}

for (const lateResult of ["success", "rejection"] as const) {
  it.effect(
    `finish failure joins admitted editor cleanup before FIFO progress (${lateResult})`,
    () =>
      Effect.gen(function* () {
        const h = hostFixture();
        const bridge = makeAskUserDialogBridge();
        const host = makeAskUserHost(h.ctx, bridge);
        const terminated = yield* Deferred.make<void>();
        const restored = yield* Deferred.make<void>();
        const runEditor = Effect.runPromiseWith(yield* Effect.context<never>());
        const cleanup: string[] = [];
        let editorSignal: AbortSignal | undefined;
        const edit = vi
          .spyOn(externalEditor, "editWithExternalEditor")
          .mockImplementation((_tui, _command, _value, signal) => {
            editorSignal = signal;
            return runEditor(
              Deferred.await(terminated).pipe(
                Effect.andThen(Effect.sync(() => cleanup.push("process", "file"))),
                Effect.andThen(Deferred.await(restored)),
                Effect.andThen(
                  Effect.sync(() => {
                    cleanup.push("tui");
                  }),
                ),
                Effect.andThen(
                  lateResult === "rejection"
                    ? Effect.fail(
                        new AskUserHostError({
                          operation: "editor",
                          message: "late editor failure",
                        }),
                      )
                    : Effect.succeed("late text"),
                ),
              ),
            );
          });
        yield* Effect.addFinalizer(() => Effect.sync(() => edit.mockRestore()));
        yield* Effect.gen(function* () {
          const queue = yield* makeQuestionnaireQueue;
          const first = yield* queue.admit;
          const second = yield* queue.admit;
          const firstFiber = yield* first
            .run(host(request))
            .pipe(Effect.ensuring(first.close), Effect.exit, Effect.forkChild);
          const secondFiber = yield* second
            .run(host(request))
            .pipe(Effect.ensuring(second.close), Effect.forkChild);
          yield* Effect.promise(() => vi.waitFor(() => expect(h.mount).toBeDefined()));
          h.mount!();
          const oldComponent = h.component!;
          oldComponent.handleInput?.("n");
          oldComponent.handleInput?.("external");
          expect(editorSignal?.aborted).toBe(false);
          oldComponent.handleInput?.("\u001b");
          oldComponent.handleInput?.("1");
          h.done.mockImplementationOnce(() => {
            throw new Error("finish failure");
          });
          expect(() => oldComponent.handleInput?.("\r")).not.toThrow();
          yield* Effect.promise(() => vi.waitFor(() => expect(editorSignal?.aborted).toBe(true)));
          expect(bridge.resume()).toBe(false);
          expect(h.customCalls).toBe(1);
          yield* Deferred.succeed(terminated, undefined);
          yield* Effect.promise(() =>
            vi.waitFor(() => expect(cleanup).toEqual(["process", "file"])),
          );
          expect(h.customCalls).toBe(1);
          yield* Deferred.succeed(restored, undefined);
          expect(Exit.isFailure(yield* Fiber.join(firstFiber))).toBe(true);
          expect(cleanup).toEqual(["process", "file", "tui"]);
          yield* Effect.promise(() => vi.waitFor(() => expect(h.customCalls).toBe(2)));
          oldComponent.handleInput?.("h");
          oldComponent.handleInput?.("n");
          oldComponent.handleInput?.("external");
          expect(edit).toHaveBeenCalledOnce();
          h.mount!();
          h.component!.handleInput?.("1");
          h.component!.handleInput?.("\r");
          expect((yield* Fiber.join(secondFiber)).outcome).toBe("submitted");
          expect(h.done).toHaveBeenCalledTimes(2);
        }).pipe(
          // Release the fake editor before child finalizers join its cleanup on failure.
          Effect.ensuring(
            Deferred.succeed(terminated, undefined).pipe(
              Effect.andThen(Deferred.succeed(restored, undefined)),
            ),
          ),
        );
      }),
  );
}

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
