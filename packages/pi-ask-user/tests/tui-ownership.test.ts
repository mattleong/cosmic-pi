import { routeRequest as request } from "./support/questionnaire.ts";
import {
  eventually,
  foreign,
  makeTuiHost as hostFixture,
  openPresentation,
  waitMounted,
} from "./support/host.ts";
import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as externalEditor from "../src/boundary/host-external-editor.ts";
import { makeQuestionnaireQueue } from "../src/questionnaire/queue.ts";
import { expect, vi } from "vitest";
import { makeAskUserPromptGate } from "../src/boundary/host-prompt.ts";
import { makeAskUserHost } from "../src/boundary/host-dialogs.ts";
import { makeAskUserDialogBridge } from "../src/boundary/host-ui.ts";
import { AskUserHostError } from "../src/questionnaire/errors.ts";
import type { QuestionnairePresence } from "../src/questionnaire/service.ts";

const open = (h: ReturnType<typeof hostFixture>, presence?: QuestionnairePresence) =>
  openPresentation(h, (bridge) => makeAskUserHost(h.ctx, bridge)(request, presence));

it.effect(
  "docks the questionnaire without painting over the editor and retains hidden drafts",
  () =>
    Effect.gen(function* () {
      const h = hostFixture();
      const { bridge, pending } = yield* open(h);
      h.mount!();
      const widget = [...h.widgets.values()][0]!;
      expect(widget.render(200).length).toBeGreaterThan(0);
      expect(h.component!.render(200)).toEqual([]);
      h.component!.handleInput?.("1");
      const draft = widget.render(200);
      h.component!.handleInput?.("b");
      expect(widget.render(200)).toEqual([]);
      h.tui.terminal.columns = 80;
      h.tui.terminal.rows = 24;
      expect(bridge.resume()).toBe(true);
      expect(widget.render(80).length).toBeGreaterThan(0);
      expect(widget.render(80).length).toBeLessThan(h.tui.terminal.rows);
      h.tui.terminal.columns = 200;
      h.tui.terminal.rows = 60;
      expect(widget.render(200)).toEqual(draft);
      h.component!.handleInput?.("\r");
      expect((yield* Effect.promise(() => pending)).outcome).toBe("submitted");
      expect(h.widgets.size).toBe(0);
      expect(widget.render(200)).toEqual([]);
    }),
);

it.effect("the opening handshake waits for mounting and reports each hide and resume", () =>
  Effect.gen(function* () {
    const h = hostFixture();
    const presence = {
      opened: yield* Deferred.make<void, AskUserHostError>(),
      visibility: yield* Queue.unbounded<"open" | "hidden">(),
    };
    const { bridge, controller, pending } = yield* open(h, presence);
    expect(yield* Deferred.isDone(presence.opened)).toBe(false);
    h.mount!();
    expect(yield* Deferred.isDone(presence.opened)).toBe(true);
    h.component!.handleInput?.("b");
    expect(bridge.resume()).toBe(true);
    expect(yield* Queue.clear(presence.visibility)).toEqual(["open", "hidden", "open"]);
    controller.abort();
    yield* Effect.promise(() => expect(pending).rejects.toBeDefined());
    expect(h.stack).toEqual([]);
  }),
);

it.effect("cancelling a hidden questionnaire preserves an unrelated overlay mounted above it", () =>
  Effect.gen(function* () {
    const h = hostFixture();
    const { bridge, controller, pending } = yield* open(h);
    h.mount!();
    h.component!.handleInput?.("b");
    h.showOverlay(foreign);
    controller.abort();
    yield* Effect.promise(() => expect(pending).rejects.toBeDefined());
    expect(h.stack).toEqual([foreign]);
    expect(h.widgets.size).toBe(0);
    expect(h.done).toHaveBeenCalledOnce();
    expect(bridge.resume()).toBe(false);
  }),
);

it.effect(
  "abort before mounting never pops a foreign overlay and late mount cleans only its owner",
  () =>
    Effect.gen(function* () {
      const h = hostFixture();
      h.showOverlay(foreign);
      const { bridge, controller, pending } = yield* open(h);
      controller.abort();
      yield* Effect.promise(() => expect(pending).rejects.toBeDefined());
      expect(h.done).not.toHaveBeenCalled();
      expect(h.stack).toEqual([foreign]);
      expect(h.widgets.size).toBe(0);
      h.mount!();
      expect(h.widgets.size).toBe(0);
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
    const { controller, pending } = yield* open(h);
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
      yield* waitMounted(h);
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
            message: "Couldn't show the questionnaire.",
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
      yield* eventually(() => expect(h.customCalls).toBe(2));
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
      yield* waitMounted(h);
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
          yield* waitMounted(h);
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
          yield* eventually(() => expect(editorSignal?.aborted).toBe(true));
          expect(bridge.resume()).toBe(false);
          expect(h.customCalls).toBe(1);
          yield* Deferred.succeed(terminated, undefined);
          yield* eventually(() => expect(cleanup).toEqual(["process", "file"]));
          expect(h.customCalls).toBe(1);
          yield* Deferred.succeed(restored, undefined);
          expect(Exit.isFailure(yield* Fiber.join(firstFiber))).toBe(true);
          expect(cleanup).toEqual(["process", "file", "tui"]);
          yield* eventually(() => expect(h.customCalls).toBe(2));
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
      const { pending } = yield* open(h);
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
      expect(gate.canOpen()).toBe(true);
      const pending = Effect.runPromise(
        makeAskUserHost(h.ctx, makeAskUserDialogBridge(), gate)(request),
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
