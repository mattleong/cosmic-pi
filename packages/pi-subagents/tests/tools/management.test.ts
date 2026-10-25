import { initTheme, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as Result from "effect/Result";
import * as Deferred from "effect/Deferred";
import { yieldUntil } from "pi-cosmic-core/testing";
import { beforeAll, describe, expect } from "vitest";
import { effectTest, step } from "../support/effect-test.ts";
import { InvalidSubagentRequestError } from "../../src/run/errors.ts";
import { decodeSubagentContract } from "../../src/tools/contract-schema.ts";
import { subagentServiceDouble } from "./fixtures/subagent-service-double.ts";
import {
  captureSubagentTools,
  executeTool,
  invokeOptionalTool,
  view,
} from "./fixtures/tool-harness.ts";
import * as Order from "effect/Order";
import * as Str from "effect/String";
import * as Option from "effect/Option";

const resultText = (result: {
  readonly content: ReadonlyArray<AgentToolResult<unknown>["content"][number]>;
}): string =>
  Arr.join(
    Arr.filterMap(result.content, (part) =>
      part.type === "text" ? Result.succeed(part.text) : Result.failVoid,
    ),
    "\n",
  );

describe("subagent tool", () => {
  beforeAll(() => initTheme("dark", false));

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
            agents: [
              {
                kind: "run",
                id: run.id,
                name: run.name,
                state: run.state,
                textStatus: "none",
                truncated: false,
                reportGeneration: 0,
                run,
              },
            ],
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
      expect(resultText(response)).toContain("openai/next-model:high");
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
      expect(resultText(result)).toContain("Children continue");
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

  effectTest("registers one agent_* family and answers questions with agent_send", function* () {
    const service = subagentServiceDouble({
      agentSend: (_caller, to) =>
        Effect.succeed({
          messageId: "message-1",
          to,
          name: "worker",
          disposition: "answered",
        }),
    });
    const tools = captureSubagentTools(service);
    // Questions are answered through agent_send; no separate reply or status tool is registered.
    expect(Arr.sort([...tools.keys()], Order.String)).toEqual([
      "agent_await",
      "agent_lifecycle",
      "agent_list",
      "agent_profiles",
      "agent_read",
      "agent_send",
      "agent_start",
      "agent_worktree",
    ]);
    const result = yield* invokeOptionalTool(tools.get("agent_send"), {
      to: "agent-2",
      message: "Yes, go ahead.",
    });
    expect(result?.details).toMatchObject({ action: "agent_send", disposition: "answered" });
  });

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
    const receipt = { id: completed.id, generation: 1, claimToken: "claim-1" };
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

  effectTest(
    "enforces the combined target count and aggregate detailed-output budget",
    function* () {
      const runs = Array.from({ length: 13 }, (_, index) =>
        view({
          id: `agent-${index + 1}`,
          name: `review-${index + 1}`,
          state: "completed",
          finalText: Fn.pipe("x", Str.repeat(32 * 1024)),
        }),
      );
      const consumed: Array<{ readonly id: string; readonly generation: number }> = [];
      const service = subagentServiceDouble({
        withAwaitTerminalObservations: (ids, _until, _onUpdate, use) =>
          use(
            Arr.map(ids, (id) => ({
              run: Option.getOrUndefined(Arr.findFirst(runs, (run) => run.id === id))!,
              completionReceipt: { id, generation: 1, claimToken: `claim-${id}` },
            })),
          ),
        consumeCompletions: (receipts) =>
          Effect.sync(() => {
            consumed.push(...receipts);
          }),
      });
      const tool = captureSubagentTools(service).get("agent_await")!;

      yield* step(() =>
        expect(
          executeTool(tool, { runIds: Arr.map(runs, (run) => run.id), until: "all_finished" }),
        ).rejects.toThrow("at most 12 targets"),
      );

      const result = yield* invokeOptionalTool(tool, {
        runIds: Arr.map(runs.slice(0, 12), (run) => run.id),
        until: "all_finished",
      });
      const text = result?.content[0]?.text ?? "";
      expect(text.length).toBeLessThanOrEqual(48_000);
      for (const run of runs.slice(0, 12)) expect(text).toContain(run.id);
      // Every run's block fits, so every claimed report is delivered and consumed.
      expect(Arr.map(consumed, (receipt) => receipt.id)).toEqual(
        Arr.map(runs.slice(0, 12), (run) => run.id),
      );
    },
  );
});
