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
import { acquireQuestionnaireQueue } from "../src/questionnaire/queue.ts";
import { expect, vi } from "vitest";
import { createAskUserPromptGate } from "../src/boundary/host-prompt.ts";
import { askUserHost } from "../src/boundary/host-dialogs.ts";
import { createAskUserDialogBridge } from "../src/boundary/host-ui.ts";
import { AskUserHostError, type AskUserRuntimeClosedError } from "../src/questionnaire/errors.ts";
import type { QuestionnairePresence } from "../src/questionnaire/service.ts";

const open = (h: ReturnType<typeof hostFixture>, presence?: QuestionnairePresence) =>
  openPresentation(h, (bridge) => askUserHost(h.ctx, bridge)(request, presence));

it.effect("the opening handshake waits for mounting and reports each hide and resume", () =>
  Effect.gen(function* () {
    const h = hostFixture();
    const presence = {
      opened: yield* Deferred.make<void, AskUserHostError | AskUserRuntimeClosedError>(),
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

it.effect("a failed close rejects yet ends the host prompt so the next questionnaire opens", () =>
  Effect.gen(function* () {
    const gate = createAskUserPromptGate();
    const h = hostFixture(gate);
    const bridge = createAskUserDialogBridge();
    const host = askUserHost(h.ctx, bridge, gate);
    const queue = yield* acquireQuestionnaireQueue;
    const first = yield* queue.admit;
    const second = yield* queue.admit;
    const firstFiber = yield* first
      .run(host(request))
      .pipe(Effect.ensuring(first.close), Effect.exit, Effect.forkChild);
    const secondFiber = yield* second
      .run(host(request, undefined, true))
      .pipe(Effect.ensuring(second.close), Effect.forkChild);
    yield* waitMounted(h);
    h.mount!();
    const oldComponent = h.component!;
    h.showOverlay(foreign);
    h.ownedHide.mockImplementationOnce(() => {
      oldComponent.handleInput?.("\r");
      throw new Error("secret host path /private/questionnaire");
    });
    oldComponent.handleInput?.("1");
    expect(() => oldComponent.handleInput?.("\r")).not.toThrow();
    const result = yield* Fiber.join(firstFiber);
    expect(Exit.isFailure(result)).toBe(true);
    if (Exit.isFailure(result)) {
      const error = Cause.squash(result.cause);
      expect(error).toBeInstanceOf(AskUserHostError);
      expect(String(error)).not.toContain("secret");
      expect(error).toEqual(
        new AskUserHostError({
          operation: "render",
          message: "Couldn't show the questionnaire.",
        }),
      );
    }
    expect(h.stack).toEqual([foreign]);
    expect(h.done).toHaveBeenCalledOnce();
    expect(bridge.resume()).toBe(false);
    yield* eventually(() => expect(h.customCalls).toBe(2));
    h.mount!();
    h.component!.handleInput?.("1");
    h.component!.handleInput?.("\r");
    expect((yield* Fiber.join(secondFiber)).outcome).toBe("submitted");
    expect(h.stack).toEqual([foreign]);
    expect(gate.canOpen()).toBe(true);
    oldComponent.handleInput?.("\r");
    expect(h.stack).toEqual([foreign]);
    expect(h.done).toHaveBeenCalledTimes(2);
  }),
);

for (const fail of [false, true]) {
  it.effect(`a pre-mount answer finishes only after handle acquisition (failure: ${fail})`, () =>
    Effect.gen(function* () {
      const h = hostFixture();
      const pending = yield* askUserHost(
        h.ctx,
        createAskUserDialogBridge(),
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
          expect(Cause.squash(result.cause)).toBeInstanceOf(AskUserHostError);
      } else {
        expect(Exit.isSuccess(result)).toBe(true);
        if (Exit.isSuccess(result)) expect(result.value.outcome).toBe("submitted");
      }
      expect(h.stack).toEqual([foreign]);
      expect(h.done).toHaveBeenCalledOnce();
    }),
  );
}

for (const [lateResult, failFinish] of [
  ["success", false],
  ["rejection", true],
] as const) {
  it.effect(
    `finish (${failFinish ? "failure" : "success"}) joins admitted editor cleanup before FIFO progress (${lateResult})`,
    () =>
      Effect.gen(function* () {
        const h = hostFixture();
        const bridge = createAskUserDialogBridge();
        const host = askUserHost(h.ctx, bridge);
        const terminated = yield* Deferred.make<void>();
        const restored = yield* Deferred.make<void>();
        const runEditor = Effect.runPromiseWith(yield* Effect.context());
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
          const queue = yield* acquireQuestionnaireQueue;
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
          if (failFinish)
            h.done.mockImplementationOnce(() => {
              throw new Error("finish failure");
            });
          expect(() => oldComponent.handleInput?.("\r")).not.toThrow();
          yield* eventually(() => expect(editorSignal?.aborted).toBe(true));
          yield* eventually(() => expect(bridge.resume()).toBe(false));
          expect(h.customCalls).toBe(1);
          yield* Deferred.succeed(terminated, undefined);
          yield* eventually(() => expect(cleanup).toEqual(["process", "file"]));
          expect(h.customCalls).toBe(1);
          yield* Deferred.succeed(restored, undefined);
          const firstResult = yield* Fiber.join(firstFiber);
          expect(Exit.isFailure(firstResult)).toBe(failFinish);
          if (Exit.isSuccess(firstResult)) expect(firstResult.value.outcome).toBe("submitted");
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
  "a competing prompt during lazy loading prevents custom mounting without taking focus",
  () =>
    Effect.gen(function* () {
      const h = hostFixture();
      const gate = createAskUserPromptGate();
      h.showOverlay(foreign);
      expect(gate.canOpen()).toBe(true);
      const pending = Effect.runPromise(
        askUserHost(h.ctx, createAskUserDialogBridge(), gate)(request),
      );
      gate.started();
      yield* Effect.promise(() => expect(pending).rejects.toBeInstanceOf(AskUserHostError));
      expect(h.mount).toBeUndefined();
      expect(h.stack).toEqual([foreign]);
      expect(gate.canOpen()).toBe(false);
      gate.ended();
      expect(gate.canOpen()).toBe(true);
    }),
);
