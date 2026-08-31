import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import type {
  HerdrSplitPaneInput,
  HerdrStartSideSessionInput,
} from "../../src/boundary/herdr-client.ts";
import { HerdrBtwError } from "../../src/btw/errors.ts";

export type HerdrBtwClientCallInput =
  | HerdrSplitPaneInput
  | HerdrStartSideSessionInput
  | Readonly<{ paneId: string }>
  | Readonly<{ agentName: string; prompt: string }>
  | Readonly<{ agentName: string }>;

export interface HerdrBtwClientCall {
  readonly operation: string;
  readonly input?: HerdrBtwClientCallInput;
}

const MUTATING_OPERATIONS = new Set([
  "split BTW pane",
  "start side-session Pi",
  "prompt side-session Pi",
  "focus side-session Pi",
]);

const commandFailure = (operation: string): HerdrBtwError =>
  new HerdrBtwError({
    operation,
    code: `fixture_${operation.toLowerCase().replaceAll(" ", "_")}`,
    message: `Fixture failure during ${operation}.`,
    outcome: MUTATING_OPERATIONS.has(operation) ? "uncertain" : "confirmed",
  });

/** Fresh per-scenario Herdr call recording and failure injection. */
export const makeHerdrBtwCallRecorder = (failOperation?: string) => {
  const calls: HerdrBtwClientCall[] = [];

  const runEffect = <A>(
    operation: string,
    input: HerdrBtwClientCallInput | undefined,
    effect: () => Effect.Effect<A, HerdrBtwError>,
  ): Effect.Effect<A, HerdrBtwError> =>
    Effect.suspend(() => {
      calls.push(input === undefined ? { operation } : { operation, input });
      return operation === failOperation ? Effect.fail(commandFailure(operation)) : effect();
    });

  const run = <A>(
    operation: string,
    input: HerdrBtwClientCallInput | undefined,
    result: () => A,
  ): Effect.Effect<A, HerdrBtwError> => runEffect(operation, input, () => Effect.sync(result));

  return { calls, run, runEffect } as const;
};

export const operationNames = (calls: ReadonlyArray<HerdrBtwClientCall>): string[] =>
  calls.map((call) => call.operation);

export const operationInputs = <A>(
  calls: ReadonlyArray<HerdrBtwClientCall>,
  operation: string,
): A[] => {
  // SAFETY: Each fixture method records the semantic input paired with its fixed operation name.
  return calls.filter((call) => call.operation === operation).map((call) => call.input as A);
};

/** Advances through the bounded shell-readiness window before joining. */
export const withShellReadiness = <A, E>(workflow: Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const fiber = yield* workflow.pipe(Effect.forkScoped({ startImmediately: true }));
    for (let step = 0; step < 32; step += 1) yield* TestClock.adjust("200 millis");
    return yield* Fiber.join(fiber);
  });
