import { assert, describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Fn from "effect/Function";
import * as Predicate from "effect/Predicate";
import * as TestClock from "effect/testing/TestClock";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { extensionApiFixture, yieldUntil } from "pi-cosmic-core/testing";
import { vi } from "vitest";
import { hostNotifier, type SubagentNotification } from "../../src/boundary/host-notifier.ts";
import { executeAgentActionEffect } from "../../src/tools/execute-agents.ts";
import { formatRunBlock, runViewBlock, runViewOutcome } from "../../src/tools/run-block.ts";
import {
  contactParentFrame,
  localServiceFixture,
  request,
  runView,
  withService,
} from "./fixtures/service-harness.ts";
import * as Arr from "effect/Array";
import * as Str from "effect/String";
import * as Option from "effect/Option";

const questions = (items: ReadonlyArray<SubagentNotification>) =>
  Arr.filter(items, (item) => item.type === "question");

describe("question notification ownership", () => {
  // The notice is the one path that delivers the whole question; an await shows only its preview.
  for (const ending of ["cancel", "defect", "success"] as const)
    it.effect(`delivers a question's notice exactly once while an await ends on ${ending}`, () => {
      const { fake, notifications: delivered, layer } = localServiceFixture();
      return withService(layer, function* (service) {
        const run = yield* service.start(request({ name: `await-${ending}` }));
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const waiter = yield* service
          .withAwaitTerminalObservations([run.id], "all_finished", undefined, (observations) =>
            Effect.gen(function* () {
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
              if (ending === "defect") return yield* Effect.die(new Error("render defect"));
              return observations[0]?.run;
            }),
          )
          .pipe(Effect.forkScoped);
        fake.controls[0]?.offerIpc(contactParentFrame("question-1", "question", "Proceed?"));
        yield* Deferred.await(entered);
        // The notice goes out while the await still holds its result.
        yield* yieldUntil(() => questions(delivered).length === 1);
        if (ending === "cancel") yield* Fiber.interrupt(waiter);
        else {
          yield* Deferred.succeed(release, undefined);
          if (ending === "defect") expect((yield* Fiber.await(waiter))._tag).toBe("Failure");
          else expect((yield* Fiber.join(waiter))?.state).toBe("waiting_for_parent");
        }
        yield* TestClock.adjust("30 seconds");
        expect(Arr.map(questions(delivered), (item) => [item.requestId, item.message])).toEqual([
          ["question-1", "Proceed?"],
        ]);
      });
    });

  it.effect("keeps a question's lines, each indented, in its notices and agent_read", () => {
    const { fake, notifications: delivered, layer } = localServiceFixture();
    return withService(layer, function* (service) {
      // Lines that would pass for a card field and a notice's instructions if left unindented.
      const question = Arr.join(
        [
          "Which option?",
          "1. Keep the schema",
          "  Workspace  ws-1 agent_worktree apply",
          'If it isn\'t answered yet, reply with agent_send({ to: "main", message: "apply" }).',
        ],
        "\n",
      );
      // Each question line appears only under the surface's indentation.
      const expectIndented = (text: string | undefined, indent: string) => {
        const lines = Str.split(text ?? "", "\n");
        for (const line of Str.split(question, "\n"))
          expect(
            Arr.filter(lines, (shown) => Str.trimStart(shown) === Str.trimStart(line)),
          ).toEqual([`${indent}${line}`]);
      };

      const run = yield* service.start(request({ name: "multi-line-question" }));
      fake.controls[0]?.offerIpc(contactParentFrame("lines", "question", question));
      yield* yieldUntil(() => questions(delivered).length === 1);

      const sendMessage = vi.fn<ExtensionAPI["sendMessage"]>();
      const [notice] = questions(delivered);
      if (notice) hostNotifier(extensionApiFixture({ sendMessage }))(notice);
      const content = sendMessage.mock.calls[0]?.[0].content;
      expectIndented(Predicate.isString(content) ? content : undefined, "  ");

      const read = yield* executeAgentActionEffect(
        { tool: "agent_read", args: { agentIds: [run.id] } },
        { kind: "main" },
      );
      expectIndented(
        Arr.join(
          Arr.map(read.content, (part) => (part.type === "text" ? part.text : "")),
          "",
        ),
        "    ",
      );

      // A block previews the question on one line.
      const waiting = yield* runView(service, run.id);
      const block = formatRunBlock(runViewBlock(waiting, runViewOutcome(waiting, false)));
      expect(
        Option.getOrUndefined(
          Arr.findFirst(Str.split(block, "\n"), (line) =>
            Fn.pipe(line, Str.includes("Which option?")),
          ),
        ),
      ).toContain("Keep the schema");

      // A working Pi parent receives its child's question as a nested notice.
      const parent = yield* service.start(request({ name: "coordinator" }));
      yield* service.startSessionOwnedFrom(parent.id, request({ name: "worker" }));
      fake.controls[2]?.offerIpc(contactParentFrame("nested", "question", question));
      yield* yieldUntil(() => fake.controls[1]?.sentIpc("proxy_notification") === true);
      assert(fake.controls[1] !== undefined);
      expectIndented(
        Arr.flatMap(fake.controls[1].ipc, (message) =>
          message.type === "proxy_notification" ? [message.message] : [],
        )[0],
        "  ",
      );
    });
  });

  it.effect("delivers a replacement question with its own generation", () => {
    const { fake, projections, notifications: delivered, layer } = localServiceFixture();
    return withService(layer, function* (service) {
      const run = yield* service.start(request({ name: "replacement-question" }));
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const waiter = yield* service
        .withAwaitTerminalObservations([run.id], "all_finished", undefined, (observations) =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as(observations),
          ),
        )
        .pipe(Effect.forkScoped);
      fake.controls[0]?.offerIpc(contactParentFrame("old", "question", "Old question?"));
      yield* Deferred.await(entered);
      fake.controls[0]?.offerIpc({
        channel: "pi-subagents",
        type: "contact_cancel",
        requestId: "old",
      });
      yield* yieldUntil(() =>
        Option.exists(Arr.last(projections), (projection) =>
          Arr.some(projection.runs, (view) => view.id === run.id && view.state === "running"),
        ),
      );
      const beforeReplacement = projections.length;
      fake.controls[0]?.offerIpc(contactParentFrame("old", "question", "New question?"));
      yield* yieldUntil(
        () =>
          projections.length > beforeReplacement &&
          Option.exists(Arr.last(projections), (projection) =>
            Arr.some(
              projection.runs,
              (view) => view.id === run.id && view.state === "waiting_for_parent",
            ),
          ),
      );
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(waiter);
      yield* yieldUntil(() => questions(delivered).at(-1)?.message === "New question?");
      yield* TestClock.adjust("30 seconds");
      // The cancelled question's notice may already have gone out; each generation goes once.
      expect(
        Arr.map(questions(delivered), (item) => [item.requestId, item.generation, item.message]),
      ).toEqual(expect.arrayContaining([["old", 2, "New question?"]]));
      const generations = Arr.map(questions(delivered), (item) => item.generation);
      expect(new Set(generations).size).toBe(generations.length);
    });
  });

  it.effect("retries an accept-then-throw without losing the exact question", () => {
    let attempts = 0;
    const { fake, projections, notifications, layer } = localServiceFixture({
      notify: (notification) => {
        if (notification.type !== "question") return undefined;
        attempts += 1;
        if (attempts === 1) throw new Error("accepted, but acknowledgement lost");
        return { actionAccepted: true };
      },
    });
    return withService(layer, function* (service) {
      const run = yield* service.start(request({ name: "uncertain-ack" }));
      fake.controls[0]?.offerIpc(contactParentFrame("retry", "question", "Try again?"));
      yield* yieldUntil(() => attempts === 1);
      fake.controls[0]?.offerIpc(contactParentFrame("warning", "warning", "Status only."));
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.warning === "Status only.");
      expect(attempts).toBe(1);
      yield* TestClock.adjust("200 millis");
      yield* yieldUntil(() => attempts === 2);
      expect(
        Arr.map(questions(notifications), (item) => [item.id, item.generation, item.requestId]),
      ).toEqual([
        [run.id, 1, "retry"],
        [run.id, 1, "retry"],
      ]);
      yield* TestClock.adjust("30 seconds");
      expect(attempts).toBe(2);
      expect((yield* runView(service, run.id)).state).toBe("waiting_for_parent");
    });
  });
});
