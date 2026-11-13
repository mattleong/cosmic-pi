import { getTextContent } from "pi-code-previews";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import { yieldUntil } from "pi-cosmic-core/testing";
import { describe, expect } from "vitest";
import { effectTest, step } from "../support/effect-test.ts";
import { InvalidSubagentRequestError } from "../../src/run/errors.ts";
import { MAX_TARGET_RUNS } from "../../src/run/limits.ts";
import { decodeSubagentContract } from "../../src/tools/contract-schema.ts";
import { subagentServiceDouble } from "./fixtures/subagent-service-double.ts";
import {
  captureSubagentTools,
  executeTool,
  invokeOptionalTool,
  receiptFor,
  view,
} from "./fixtures/tool-harness.ts";
import { readoutOf } from "../fixtures/run-view.ts";

describe("subagent tool", () => {
  effectTest("names a failed root run's next candidate in await and read", function* () {
    const run = view({
      state: "failed",
      parentRunId: "root",
      nextCandidate: { model: "openai/next-model", effort: "high" },
    });
    const tools = captureSubagentTools(
      subagentServiceDouble({
        agentRead: () =>
          Effect.succeed({
            agents: [readoutOf(run)],
            missingIds: [],
          }),
        withAwaitTerminalObservations: (_ids, _until, _onUpdate, use) => use([{ run }]),
      }),
    );
    for (const [toolName, args] of [
      ["agent_read", { agentIds: [run.id] }],
      ["agent_await", { runIds: [run.id], until: "all_finished" }],
    ] as const) {
      const response = yield* step(() => executeTool(tools.get(toolName)!, args));
      expect(getTextContent(response.content)).toContain("openai/next-model:high");
    }
  });

  effectTest(
    "returns cancellation only after owned wait cleanup, without a progress callback",
    function* () {
      const started = Deferred.makeUnsafe<void>();
      const closing = Deferred.makeUnsafe<void>();
      const release = Deferred.makeUnsafe<void>();
      let released = false;
      let returned = false;
      const service = subagentServiceDouble({
        withAwaitTerminalObservations: () =>
          Effect.acquireUseRelease(
            Deferred.succeed(started, undefined),
            () => Effect.never,
            () =>
              Deferred.succeed(closing, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(
                  Effect.sync(() => {
                    released = true;
                  }),
                ),
              ),
          ),
      });
      const controller = new AbortController();
      const executing = executeTool(
        captureSubagentTools(service).get("agent_await")!,
        { runIds: ["agent-one"], until: "all_finished" },
        { signal: controller.signal },
      ).then((result) => {
        returned = true;
        return result;
      });
      yield* Deferred.await(started);
      controller.abort();
      yield* Deferred.await(closing);
      expect(returned).toBe(false);
      yield* Deferred.succeed(release, undefined);
      const result = yield* step(() => executing);
      expect(released).toBe(true);
      expect(result.details).not.toHaveProperty("cancellationCleanup");
      expect(result.details).toMatchObject({
        action: "await",
        cancelled: true,
        awaitedRunIds: ["agent-one"],
      });
      expect(getTextContent(result.content)).toContain("Children continue");
    },
  );

  for (const defect of [false, true]) {
    effectTest(
      `does not hide an await ${defect ? "defect" : "failure"} when the signal aborts during cleanup`,
      function* () {
        const controller = new AbortController();
        const error = InvalidSubagentRequestError.make({
          code: "test_failure",
          message: "Actual failure",
        });
        const service = subagentServiceDouble({
          withAwaitTerminalObservations: () =>
            (defect ? Effect.die(error) : Effect.fail(error)).pipe(
              Effect.ensuring(Effect.sync(() => controller.abort())),
            ),
        });
        const executing = executeTool(
          captureSubagentTools(service).get("agent_await")!,
          { runIds: ["agent-one"], until: "all_finished" },
          { signal: controller.signal },
        );
        yield* step(() => expect(executing).rejects.toBeDefined());
      },
    );
  }

  effectTest(
    "reports per-target management outcomes without hiding successful side effects",
    function* () {
      const interrupted: string[] = [];
      const service = subagentServiceDouble({
        interrupt: (id) =>
          id === "agent-2"
            ? Effect.fail(
                InvalidSubagentRequestError.make({
                  code: "already_paused",
                  message: "agent-2 is already paused",
                }),
              )
            : Effect.sync(() => (interrupted.push(id), view({ id, state: "paused" }))),
      });
      const tools = captureSubagentTools(service);

      const lifecycleResult = yield* invokeOptionalTool(tools.get("agent_lifecycle"), {
        action: "interrupt",
        runIds: ["agent-1", "agent-2"],
      });
      expect(interrupted).toEqual(["agent-1"]);
      expect(
        decodeSubagentContract("agent_lifecycle")(lifecycleResult?.structuredContent)?.results,
      ).toMatchObject([{ status: "succeeded", target: { runId: "agent-1", state: "paused" } }, {}]);
      expect(lifecycleResult?.content[0]?.text).toContain("Failed targets (1)");
      expect(lifecycleResult?.content[0]?.text).toContain("agent-2 is already paused");
      expect(lifecycleResult?.details).toMatchObject({
        version: 2,
        action: "interrupt",
        runCount: 1,
        actionFailures: [{ id: "agent-2", code: "already_paused" }],
      });
    },
  );

  effectTest("propagates defects instead of reporting them as target failures", function* () {
    const service = subagentServiceDouble({
      stop: () => Effect.die(new Error("broken invariant")),
    });
    const tool = captureSubagentTools(service).get("agent_lifecycle")!;
    yield* step(() =>
      expect(
        executeTool(tool, { action: "stop", runIds: ["agent-1"] }, { callID: "test" }),
      ).rejects.toThrow("broken invariant"),
    );
  });

  effectTest(
    "interrupts an in-flight batch rather than manufacturing action failures",
    function* () {
      let entered = false;
      let finalized = false;
      const service = subagentServiceDouble({
        stop: () =>
          Effect.sync(() => {
            entered = true;
          }).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(
              Effect.sync(() => {
                finalized = true;
              }),
            ),
          ),
      });
      const signal = new AbortController();
      const tool = captureSubagentTools(service).get("agent_lifecycle")!;
      const promise = executeTool(
        tool,
        { action: "stop", runIds: ["agent-1"] },
        { callID: "test", signal: signal.signal },
      );
      const settled = Promise.allSettled([promise]);
      yield* Effect.gen(function* () {
        yield* yieldUntil(() => entered).pipe(Effect.orDie);
        signal.abort();
        expect((yield* step(() => settled))[0]?.status).toBe("rejected");
        expect(finalized).toBe(true);
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => signal.abort()).pipe(Effect.andThen(step(() => settled))),
        ),
      );
    },
  );

  effectTest("keeps completion available when detailed result presentation fails", function* () {
    const completed = view({ state: "completed", endedAt: 2, finalText: "Report to deliver." });
    const receipt = receiptFor(completed.id);
    const consumed: Array<typeof receipt> = [];
    const service = subagentServiceDouble({
      withAwaitTerminalObservations: (_ids, _until, _onUpdate, use) =>
        use([{ run: completed, completionReceipt: receipt }]),
      consumeCompletions: (receipts) => Effect.sync(() => void consumed.push(...receipts)),
    });
    const tools = captureSubagentTools(service);
    Object.defineProperty(completed, "warningSource", {
      configurable: true,
      get: () => {
        throw new Error("detail projection failed");
      },
    });
    yield* step(() =>
      expect(
        executeTool(tools.get("agent_await")!, {
          runIds: [completed.id],
          until: "all_finished",
        }),
      ).rejects.toThrow("detail projection failed"),
    );
    expect(consumed).toEqual([]);

    Object.defineProperty(completed, "warningSource", { value: "child" });
    const delivered = yield* invokeOptionalTool(tools.get("agent_await"), {
      runIds: [completed.id],
      until: "all_finished",
    });
    expect(delivered?.content[0]?.text).toContain("Report to deliver.");
    expect(delivered?.details).toMatchObject({ action: "await", cards: [{ id: completed.id }] });
    expect(consumed).toEqual([receipt]);
  });

  effectTest("refuses more targets than one await delivers", function* () {
    const tool = captureSubagentTools(subagentServiceDouble({})).get("agent_await")!;
    yield* step(() =>
      expect(
        executeTool(tool, {
          runIds: Array.from({ length: MAX_TARGET_RUNS + 1 }, (_, index) => `agent-${index}`),
          until: "all_finished",
        }),
      ).rejects.toMatchObject({ code: "too_many_run_ids" }),
    );
  });
});
