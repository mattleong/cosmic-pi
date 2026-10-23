import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { yieldUntil } from "pi-cosmic-core/testing";
import type { SubagentRunView } from "../../src/run/model.ts";
import type { SubagentRunObservation } from "../../src/run/service.ts";
import {
  contactParentFrame,
  localServiceFixture,
  request,
  withService,
} from "./fixtures/service-harness.ts";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";

const summarize = (
  observations: ReadonlyArray<SubagentRunObservation>,
  questions: ReadonlyArray<SubagentRunView> = [],
) =>
  Effect.succeed({
    targets: Arr.map(observations, (observation) => observation.run.id),
    questions: Arr.map(questions, (run) => run.id),
  });

const yieldTurns = Effect.gen(function* () {
  for (let turn = 0; turn < 25; turn += 1) yield* Effect.yieldNow;
});

describe("await and questions the caller is not awaiting", () => {
  it.effect("ends a root wait when another child asks the root a question", () => {
    const { fake, projections, layer } = localServiceFixture();
    return withService(layer, function* (service) {
      const awaited = yield* service.start(request({ name: "awaited" }));
      const asking = yield* service.start(request({ name: "asking" }));
      const waiting = yield* service
        .withAwaitTerminalObservations([awaited.id], "all_finished", undefined, summarize)
        .pipe(Effect.forkScoped);
      yield* yieldTurns;

      fake.controls[1]!.offerIpc(contactParentFrame("q-1", "question", "Which file?"));
      expect(yield* Fiber.join(waiting)).toEqual({
        targets: [awaited.id],
        questions: [asking.id],
      });
      expect(
        Arr.last(projections).pipe(
          Option.flatMap((projection) =>
            Arr.findFirst(projection.runs, (run) => run.id === awaited.id),
          ),
          Option.map((run) => run.state),
          Option.getOrUndefined,
        ),
      ).toBe("running");
    });
  });

  it.effect("leaves a question that a working Pi child receives to that child", () => {
    const { fake, layer } = localServiceFixture();
    return withService(layer, function* (service) {
      const parent = yield* service.start(request({ name: "coordinator" }));
      const child = yield* service.startSessionOwnedFrom(parent.id, request({ name: "worker" }));
      const waiting = yield* service
        .withAwaitTerminalObservations([parent.id], "all_finished", undefined, summarize)
        .pipe(Effect.forkScoped);

      fake.controls[1]!.offerIpc(contactParentFrame("q-1", "question", "Which file?"));
      yield* yieldUntil(() => fake.controls[0]!.sentIpc("proxy_notification"));
      yield* yieldTurns;
      expect(waiting.pollUnsafe()).toBeUndefined();

      const sibling = yield* service.startSessionOwnedFrom(parent.id, request({ name: "peer" }));
      const nestedWait = yield* service
        .withAwaitTerminalObservations(
          [sibling.id],
          "all_finished",
          undefined,
          summarize,
          parent.id,
        )
        .pipe(Effect.forkScoped);
      expect(yield* Fiber.join(nestedWait)).toEqual({
        targets: [sibling.id],
        questions: [child.id],
      });
      expect(waiting.pollUnsafe()).toBeUndefined();
    });
  });
});
