// Tool Promise calls are test-runner boundaries.
import { initTheme } from "@earendil-works/pi-coding-agent";
import { beforeAll, describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as References from "effect/References";
import type { ProfileRouteContinuation } from "../src/profiles/model.ts";
import { runSessionOwned } from "../src/run/session-owned.ts";
import { subagentServiceDouble } from "./tools/fixtures/subagent-service-double.ts";
import { captureSubagentTools, executeTool, view } from "./tools/fixtures/tool-harness.ts";

const route: ProfileRouteContinuation = {
  profile: "reviewer",
  routeSource: "global",
  candidates: [0, 1].map(() => ({
    host: "local",
    runtime: "pi",
    model: "openai-codex/gpt-5.6-sol",
    effort: "high",
    context: "fresh",
    writeIntent: "read-only",
    openaiFastMode: false,
    closeOnReport: true,
  })),
  selectedCandidateIndex: 0,
  skippedCandidates: [],
};

describe("retry claim ownership", () => {
  beforeAll(() => initTheme("dark", false));

  for (const cancelBeforeOwnership of [true, false]) {
    it.effect(
      `releases retry claim on cancellation ${cancelBeforeOwnership ? "before" : "after"} ownership`,
      () => {
        const controller = new AbortController();
        return Effect.gen(function* () {
          const scope = yield* Effect.scope;
          const owned = yield* Deferred.make<void>();
          const finish = yield* Deferred.make<void>();
          const released = yield* Deferred.make<void>();
          let claimed = false;
          let committed = false;
          const release = Effect.sync(() => {
            claimed = false;
          }).pipe(Effect.andThen(Deferred.succeed(released, undefined)), Effect.asVoid);
          const service = subagentServiceDouble({
            claimRetryContinuation: () =>
              Effect.sync(() => {
                expect(claimed).toBe(false);
                claimed = true;
                return {
                  source: view({ state: "failed", profile: "reviewer" }),
                  continuation: route,
                  claimToken: "claim",
                };
              }),
            releaseRetryClaim: () => release,
            startRetrySessionOwned: (_request, onOwned) => {
              // Queue cancellation while the caller is constructing the service Effect.
              // An acknowledgement before the actual fork strands this claim.
              if (cancelBeforeOwnership) controller.abort();
              return runSessionOwned(
                scope,
                Effect.void,
                () =>
                  Deferred.await(finish).pipe(
                    Effect.andThen(
                      Effect.sync(() => {
                        committed = true;
                        return view({ id: "successor" });
                      }),
                    ),
                    Effect.ensuring(release),
                  ),
                () => {
                  onOwned?.();
                  Deferred.doneUnsafe(owned, Effect.void);
                },
              ).pipe(Effect.provideService(References.MaxOpsBeforeYield, 16));
            },
          });
          const tool = captureSubagentTools(service).get("subagent_lifecycle")!;
          const waiting = yield* Effect.tryPromise(() =>
            executeTool(
              tool,
              { action: "retry", runIds: ["agent-1"] },
              { callID: "retry", signal: controller.signal },
            ),
          ).pipe(Effect.exit, Effect.forkScoped);
          if (!cancelBeforeOwnership) {
            yield* Deferred.await(owned);
            controller.abort();
          }
          yield* Fiber.join(waiting);
          expect(committed).toBe(false);
          if (cancelBeforeOwnership) {
            yield* Deferred.await(released);
            expect(claimed).toBe(false);
            expect(yield* Deferred.isDone(owned)).toBe(false);
          } else {
            expect(claimed).toBe(true);
            yield* Deferred.succeed(finish, undefined);
            yield* Deferred.await(released);
            expect(committed).toBe(true);
            expect(claimed).toBe(false);
          }
        }).pipe(Effect.scoped);
      },
    );
  }
});
