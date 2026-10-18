import { initTheme, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import { yieldUntil } from "pi-cosmic-core/testing";
import { beforeAll, describe, expect } from "vitest";
import { effectTest, step } from "../support/effect-test.ts";
import { InvalidSubagentRequestError } from "../../src/run/errors.ts";
import { STEERING_DELIVERY_STATES, hasUnresolvedSteeringDelivery } from "../../src/run/model.ts";
import { subagentServiceDouble } from "./fixtures/subagent-service-double.ts";
import {
  captureSubagentTools,
  executeTool,
  invokeOptionalTool,
  view,
} from "./fixtures/tool-harness.ts";

const resultText = (result: {
  readonly content: ReadonlyArray<AgentToolResult<unknown>["content"][number]>;
}): string =>
  result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");

describe("subagent tool", () => {
  beforeAll(() => initTheme("dark", false));

  effectTest(
    "keeps native steering evidence in status/list/await without authorizing an uncertain retry",
    function* () {
      for (const steeringDelivery of STEERING_DELIVERY_STATES) {
        const run = view({
          state: "failed",
          steeringDelivery,
          remainingCandidateCount: 2,
          retryExhausted: true,
        });
        const tools = captureSubagentTools(
          subagentServiceDouble({
            list: Effect.succeed([run]),
            status: () => Effect.succeed(run),
            withAwaitTerminalObservations: (_ids, _until, _onUpdate, use) => use([{ run }]),
          }),
        );
        for (const [toolName, args] of [
          ["subagent_status", { runIds: [run.id] }],
          ["subagent_status", {}],
          ["subagent_await", { runIds: [run.id], until: "all_finished" }],
        ] as const) {
          const listed = !("runIds" in args);
          const response = yield* step(() => executeTool(tools.get(toolName)!, args));
          expect(response.details).toMatchObject({
            cards: [{ steeringDelivery, state: "failed" }],
          });
          const text = resultText(response);
          expect(text).toContain(`steeringDelivery=${steeringDelivery}`);
          if (listed) continue;
          if (hasUnresolvedSteeringDelivery(run)) {
            expect(text).toContain("Do not resend");
            expect(text).not.toContain("action=retry");
            expect(text).not.toContain("consider a generalist replacement");
          }
          if (steeringDelivery === "confirmed")
            expect(text).toContain("does not prove the model incorporated");
        }
      }
    },
  );

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
        captureSubagentTools(service).get("subagent_await")!,
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
      expect(resultText(result)).toContain("Children continue");
    },
  );

  for (const defect of [false, true]) {
    effectTest(
      `does not hide an await ${defect ? "defect" : "failure"} when the signal aborts during cleanup`,
      function* () {
        const controller = new AbortController();
        const error = new InvalidSubagentRequestError({
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
          captureSubagentTools(service).get("subagent_await")!,
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
      const sent: string[] = [];
      const interrupted: string[] = [];
      const service = subagentServiceDouble({
        send: (id) =>
          id === "agent-2"
            ? Effect.fail(
                new InvalidSubagentRequestError({
                  code: "not_running",
                  message: "agent-2 is paused",
                }),
              )
            : Effect.sync(
                () => (sent.push(id), { delivery: "guided" as const, run: view({ id }) }),
              ),
        interrupt: (id) =>
          id === "agent-2"
            ? Effect.fail(
                new InvalidSubagentRequestError({
                  code: "already_paused",
                  message: "agent-2 is already paused",
                }),
              )
            : Effect.sync(() => (interrupted.push(id), view({ id, state: "paused" }))),
      });
      const tools = captureSubagentTools(service);

      const sendResult = yield* invokeOptionalTool(tools.get("subagent_send"), {
        runIds: ["agent-1", "agent-2"],
        message: "Conclude.",
      });
      expect(sent).toEqual(["agent-1"]);
      expect(sendResult?.content[0]?.text).toContain("Guidance delivered to 1 subagent: agent-1.");
      expect(sendResult?.content[0]?.text).toContain("Failed targets (1)");
      expect(sendResult?.content[0]?.text).toContain("agent-2 [not_running]: agent-2 is paused");
      expect(sendResult?.details).toMatchObject({
        version: 2,
        action: "send",
        runCount: 1,
        actionFailures: [{ id: "agent-2", code: "not_running" }],
      });

      const lifecycleResult = yield* invokeOptionalTool(tools.get("subagent_lifecycle"), {
        action: "interrupt",
        runIds: ["agent-1", "agent-2"],
      });
      expect(interrupted).toEqual(["agent-1"]);
      expect(lifecycleResult?.content[0]?.text).toContain("Interrupted agent-1; state is paused.");
      expect(lifecycleResult?.content[0]?.text).toContain("agent-2 is already paused");
      expect(lifecycleResult?.details).toMatchObject({
        action: "interrupt",
        actionFailures: [{ id: "agent-2", code: "already_paused" }],
      });
    },
  );

  effectTest("reports which send targets were answered and which were guided", function* () {
    const service = subagentServiceDouble({
      send: (id) =>
        Effect.succeed({
          delivery: id === "agent-2" ? ("answered" as const) : ("guided" as const),
          run: view({ id }),
        }),
    });
    const tools = captureSubagentTools(service);
    // Questions are answered through subagent_send; no separate reply tool is registered.
    expect([...tools.keys()].toSorted()).toEqual([
      "agent_list",
      "agent_read",
      "agent_send",
      "subagent_await",
      "subagent_lifecycle",
      "subagent_models",
      "subagent_send",
      "subagent_start",
      "subagent_status",
      "subagent_workspace",
    ]);
    const result = yield* invokeOptionalTool(tools.get("subagent_send"), {
      runIds: ["agent-1", "agent-2", "agent-3"],
      message: "Yes, go ahead.",
    });
    expect(result?.details).toMatchObject({
      action: "send",
      runCount: 3,
      answeredRunIds: ["agent-2"],
    });
  });

  effectTest("propagates defects instead of reporting them as target failures", function* () {
    const service = subagentServiceDouble({
      send: () => Effect.die(new Error("broken invariant")),
    });
    const tool = captureSubagentTools(service).get("subagent_send")!;
    yield* step(() =>
      expect(
        executeTool(tool, { runIds: ["agent-1"], message: "Continue" }, { callID: "test" }),
      ).rejects.toThrow("broken invariant"),
    );
  });

  effectTest(
    "interrupts an in-flight batch rather than manufacturing action failures",
    function* () {
      let entered = false;
      let finalized = false;
      const service = subagentServiceDouble({
        send: () =>
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
      const tool = captureSubagentTools(service).get("subagent_send")!;
      const promise = executeTool(
        tool,
        { runIds: ["agent-1"], message: "Continue" },
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
    const receipt = { id: completed.id, generation: 1, claimToken: "claim-1" };
    const consumed: Array<typeof receipt> = [];
    const service = subagentServiceDouble({
      withStatusObservations: (_ids, use) =>
        use({ observations: [{ run: completed, completionReceipt: receipt }], missingIds: [] }),
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
        executeTool(tools.get("subagent_status")!, { runIds: [completed.id] }),
      ).rejects.toThrow("detail projection failed"),
    );
    yield* step(() =>
      expect(
        executeTool(tools.get("subagent_await")!, {
          runIds: [completed.id],
          until: "all_finished",
        }),
      ).rejects.toThrow("detail projection failed"),
    );
    expect(consumed).toEqual([]);

    Object.defineProperty(completed, "warningSource", { value: "child" });
    const delivered = yield* invokeOptionalTool(tools.get("subagent_await"), {
      runIds: [completed.id],
      until: "all_finished",
    });
    expect(delivered?.content[0]?.text).toContain("Report to deliver.");
    expect(delivered?.details).toMatchObject({ action: "await", cards: [{ id: completed.id }] });
    expect(consumed).toEqual([receipt]);
  });

  effectTest(
    "enforces the combined target count and aggregate detailed-output budget",
    function* () {
      const runs = Array.from({ length: 13 }, (_, index) =>
        view({
          id: `agent-${index + 1}`,
          name: `review-${index + 1}`,
          state: "completed",
          finalText: "x".repeat(32 * 1024),
        }),
      );
      const consumed: Array<{ readonly id: string; readonly generation: number }> = [];
      const service = subagentServiceDouble({
        status: (id) => Effect.succeed(runs.find((run) => run.id === id)!),
        observeStatus: (id) =>
          Effect.succeed({
            run: runs.find((run) => run.id === id)!,
            completionReceipt: { id, generation: 1, claimToken: `claim-${id}` },
          }),
        consumeCompletions: (receipts) =>
          Effect.sync(() => {
            consumed.push(...receipts);
          }),
      });
      const tool = captureSubagentTools(service).get("subagent_status")!;

      yield* step(() =>
        expect(executeTool(tool, { runIds: runs.map((run) => run.id) })).rejects.toThrow(
          "at most 12 targets",
        ),
      );

      const result = yield* invokeOptionalTool(tool, {
        runIds: runs.slice(0, 12).map((run) => run.id),
      });
      const text = result?.content[0]?.text ?? "";
      expect(text.length).toBeLessThanOrEqual(48_000);
      for (const run of runs.slice(0, 12)) expect(text).toContain(run.id);
      expect(text).toContain("[run output truncated]");
      expect(consumed).toEqual([]);

      yield* invokeOptionalTool(tool, { runIds: ["agent-1"] });
      expect(consumed).toEqual([{ id: "agent-1", generation: 1, claimToken: "claim-agent-1" }]);
    },
  );
});
