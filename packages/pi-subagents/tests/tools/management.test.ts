// Promise assertions are test-runner boundaries.
import { initTheme, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import { yieldUntil } from "pi-cosmic-core/testing";
import { beforeAll, describe, expect, vi } from "vitest";
import { effectTest, step } from "../support/effect-test.ts";
import type { ProfileRouteContinuation } from "../../src/profiles/model.ts";
import {
  InvalidSubagentRequestError,
  SubagentNotFoundError,
  SubagentProcessError,
} from "../../src/run/errors.ts";
import {
  STEERING_DELIVERY_STATES,
  hasUnresolvedSteeringDelivery,
  type SubagentRunView,
} from "../../src/run/model.ts";
import { type SubagentServiceContract } from "../../src/run/service.ts";
import { subagentServiceDouble } from "./fixtures/subagent-service-double.ts";
import {
  captureSubagentTools,
  executeTool,
  invokeOptionalTool,
  view,
} from "./fixtures/tool-harness.ts";
import { containedWriter, violationAudit } from "../fixtures/run-view.ts";

const resultText = (result: {
  readonly content: ReadonlyArray<AgentToolResult<unknown>["content"][number]>;
}): string =>
  result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");

/** Awaits one run whose terminal observation is already available. */
const awaitSingle = (run: SubagentRunView) =>
  invokeOptionalTool(
    captureSubagentTools(
      subagentServiceDouble({
        withAwaitTerminalObservations: (_ids, _until, _onUpdate, use) => use([{ run }]),
      }),
    ).get("subagent_await"),
    { runIds: [run.id], until: "all_finished" },
  );

/** Asserts each needle's first occurrence in order, then `last` after the final needle. */
const expectInOrder = (text: string, needles: ReadonlyArray<string>, last: string) => {
  const indexes = needles.map((needle) => text.indexOf(needle));
  indexes.push(text.indexOf(last, indexes.at(-1)));
  expect(indexes.every((index) => index >= 0)).toBe(true);
  indexes.slice(1).forEach((index, position) => expect(indexes[position]).toBeLessThan(index));
};

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
        for (const toolName of ["subagent_status", "subagent_list", "subagent_await"]) {
          const response = yield* step(() =>
            executeTool(tools.get(toolName)!, { runIds: [run.id], until: "all_finished" }),
          );
          expect(response.details).toMatchObject({
            cards: [{ steeringDelivery, state: "failed" }],
          });
          const text = resultText(response);
          expect(text).toContain(`steeringDelivery=${steeringDelivery}`);
          if (toolName === "subagent_list") continue;
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

  effectTest("names the workflow that owns a run in list rows and status", function* () {
    const owned = view({
      id: "agent-42",
      workflow: { workflowId: "wf-k3c9-7", name: "review-changes", phase: "Verify" },
    });
    const tools = captureSubagentTools(
      subagentServiceDouble({
        list: Effect.succeed([owned, view({ id: "agent-43" })]),
        status: () => Effect.succeed(owned),
      }),
    );
    const listed = resultText(yield* step(() => executeTool(tools.get("subagent_list")!, {})));
    const ownedRow = listed.split("\n").find((line) => line.includes("agent-42"));
    const otherRow = listed.split("\n").find((line) => line.includes("agent-43"));
    expect(ownedRow).toContain("wf-k3c9-7");
    expect(ownedRow).toContain("review-changes");
    expect(otherRow).not.toContain("wf-");
    const status = resultText(
      yield* step(() => executeTool(tools.get("subagent_status")!, { runIds: ["agent-42"] })),
    );
    expect(status).toContain("wf-k3c9-7");
    expect(status).toContain("review-changes");
  });

  effectTest(
    "returns formatted status metadata and one final report without activity duplication",
    function* () {
      const completed = view({
        state: "completed",
        endedAt: 2,
        profile: "reviewer",
        openaiFastMode: true,
        selection: {
          source: "profile-candidate",
          candidateIndex: 1,
          reason: "Profile reviewer selected configured candidate 2.",
          skippedCandidates: [
            {
              candidateIndex: 0,
              candidate: "pi/old-model",
              code: "pi_model_unknown",
              reason: "Pi candidate is unknown or unauthenticated.",
            },
          ],
        },
        finalText: "Viewport report.",
        sessionEvents: [
          {
            type: "tool",
            toolCallId: "tool-1",
            toolName: "read",
            target: "README.md",
            state: "completed",
            startedAt: 1,
            endedAt: 2,
          },
          { type: "assistant", text: "Viewport report.", createdAt: 2 },
        ],
      });
      const service = subagentServiceDouble({
        list: Effect.succeed([completed]),
        status: () => Effect.succeed(completed),
      });
      const tool = captureSubagentTools(service).get("subagent_status");

      const result = yield* invokeOptionalTool(tool, { runIds: ["agent-1"] });
      const text = result?.content[0]?.text ?? "";
      expect(text).toContain("pi_model_unknown");
      expect(text).not.toContain("Activity:");
      expect(text.match(/Viewport report\./g)).toHaveLength(1);
      expect(result?.details).toMatchObject({
        version: 2,
        action: "status",
        runCount: 1,
        cards: [
          {
            id: completed.id,
            name: completed.name,
            profile: completed.profile,
            host: completed.host,
            runtime: completed.runtime,
            model: completed.model,
            effort: completed.effort,
            openaiFastMode: completed.openaiFastMode,
            closeOnReport: completed.closeOnReport,
            reportGeneration: completed.reportGeneration,
            selection: {
              source: "profile-candidate",
              candidateIndex: 1,
              reason: completed.selection.reason,
              skippedCandidates: [{ code: "pi_model_unknown" }],
            },
            capabilities: completed.capabilities,
            finalText: "Viewport report.",
          },
        ],
      });

      const listed = yield* invokeOptionalTool(
        captureSubagentTools(service).get("subagent_list"),
        {},
      );
      expect(listed?.details).toMatchObject({
        version: 2,
        action: "list",
        runCount: 1,
        cards: [{ id: "agent-1" }],
      });
      expect(listed?.details).not.toHaveProperty("cards.0.finalText");
    },
  );

  effectTest(
    "awaits a fleet in one live card and batches compact guidance acknowledgements",
    function* () {
      const completedOne = view({
        id: "agent-1",
        state: "completed",
        endedAt: 2,
        finalText: "First report.",
      });
      const completedTwo = view({
        id: "agent-2",
        name: "test-review",
        state: "completed",
        endedAt: 2,
        finalText: "Second report.",
      });
      const descendant = view({
        id: "agent-child",
        name: "nested-review",
        parentRunId: "agent-1",
        depth: 2,
      });
      const sent: string[] = [];
      const service = subagentServiceDouble({
        withAwaitTerminalObservations: (_ids, _until, onUpdate, use) =>
          Effect.sync(() =>
            onUpdate?.(
              [view(), view({ id: "agent-2", name: "test-review" })],
              [view(), descendant, view({ id: "agent-2", name: "test-review" })],
            ),
          ).pipe(Effect.andThen(use([{ run: completedOne }, { run: completedTwo }]))),
        send: (id) => Effect.sync(() => (sent.push(id), id === "agent-1" ? view() : view({ id }))),
      });
      const tools = captureSubagentTools(service);
      const awaitTool = tools.get("subagent_await");
      const sendTool = tools.get("subagent_send");

      const updates: string[] = [];
      const awaited = yield* invokeOptionalTool(
        awaitTool,
        { runIds: [" agent-1 ", "agent-1", "agent-2"], until: "all_finished" },
        { update: (result) => updates.push(resultText(result)) },
      );
      expect(updates).toHaveLength(1);
      const progress = updates[0] ?? "";
      expect(progress).toContain("0/2");
      expect(progress).not.toContain("finished");
      expect(progress).toMatch(/◎ .*auth-review \(agent-1\)/);
      expect(progress.indexOf("auth-review")).toBeLessThan(progress.indexOf("nested-review"));
      expect(progress).toContain("test-review (agent-2)");
      expect(awaited?.content[0]?.text).toContain("First report.");
      expect(awaited?.content[0]?.text).toContain("Second report.");
      expect(awaited?.details).toMatchObject({
        action: "await",
        awaitedRunIds: ["agent-1", "agent-2"],
        cards: [
          { id: "agent-1" },
          { id: "agent-2" },
          { id: "agent-child", parentRunId: "agent-1" },
        ],
      });

      const sentResult = yield* invokeOptionalTool(sendTool, {
        runIds: ["agent-1", "agent-2"],
        message: "Conclude now.",
      });
      expect([...sent].sort()).toEqual(["agent-1", "agent-2"]);
      expect(sentResult?.content[0]?.text).toBe(
        "Guidance delivered to 2 subagents: agent-1, agent-2.",
      );
      expect(sentResult?.content[0]?.text).not.toContain("Subagent status");
    },
  );

  effectTest("publishes descendant-only usage changes in live await context", function* () {
    const target = view({ id: "agent-parent", parentRunId: "root", depth: 1 });
    const child = view({
      id: "agent-child",
      parentRunId: target.id,
      depth: 2,
    });
    const childWithUsage = view({
      ...child,
      usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12, cost: 0 },
    });
    const completed = view({ ...target, state: "completed", endedAt: 2 });
    const service = subagentServiceDouble({
      withAwaitTerminalObservations: (_ids, _until, onUpdate, use) =>
        Effect.sync(() => {
          onUpdate?.([target], [target, child]);
          onUpdate?.([target], [target, childWithUsage]);
        }).pipe(Effect.andThen(use([{ run: completed }]))),
    });
    const updates: AgentToolResult<unknown>[] = [];
    yield* invokeOptionalTool(
      captureSubagentTools(service).get("subagent_await"),
      { runIds: [target.id], until: "all_finished" },
      { update: (result) => updates.push(result) },
    );
    expect(updates).toHaveLength(2);
    expect(updates[1]?.details).toMatchObject({
      action: "await",
      cards: [{ id: target.id }, { id: child.id, usage: { totalTokens: 12 } }],
    });
  });

  effectTest("handles tool-level await cancellation with retained attention", function* () {
    const noProgressService = subagentServiceDouble({
      withAwaitTerminalObservations: () => Effect.never,
    });
    const waiting = view({
      id: "agent-question",
      state: "waiting_for_parent",
      question: { requestId: "question", message: "Which fixture?", createdAt: 2 },
    });
    const cancelService = subagentServiceDouble({
      withAwaitTerminalObservations: (_ids, _until, onUpdate) =>
        Effect.sync(() => onUpdate?.([waiting])).pipe(Effect.andThen(Effect.never)),
    });
    const updates: string[] = [];
    const controller = new AbortController();
    const executing = executeTool(
      captureSubagentTools(cancelService).get("subagent_await")!,
      { runIds: [waiting.id], until: "all_finished" },
      { signal: controller.signal, update: (result) => updates.push(resultText(result)) },
    );
    yield* step(() => Promise.resolve());
    yield* step(() => Promise.resolve());
    controller.abort();
    const result = yield* step(() => executing);
    expect(result.details).toMatchObject({
      action: "await",
      cancelled: true,
      awaitedRunIds: [waiting.id],
      attentionRequired: true,
    });
    const cancelled = resultText(result);
    expect(cancelled).toContain("1 subagent is unfinished");
    expect(cancelled).toContain("Children continue");
    expect(updates.at(-1)).toBe(cancelled);
    expect(cancelled).toContain("Question from auth-review: Which fixture?");
    expect(cancelled).toContain('subagent_reply({ runId: "agent-question", message: "..." })');

    const immediateUpdates: string[] = [];
    const immediateController = new AbortController();
    immediateController.abort();
    const immediate = executeTool(
      captureSubagentTools(noProgressService).get("subagent_await")!,
      { runIds: [waiting.id], until: "all_finished" },
      {
        signal: immediateController.signal,
        update: (result) => immediateUpdates.push(resultText(result)),
      },
    );
    const immediateResult = yield* step(() => immediate);
    expect(immediateResult.details).toMatchObject({
      action: "await",
      cancelled: true,
      awaitedRunIds: [waiting.id],
    });
    expect(resultText(immediateResult)).toContain("states are unobserved");
    expect(resultText(immediateResult)).toContain(waiting.id);
    expect(immediateUpdates.at(-1)).toContain("Await cancelled before progress was observed");
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
      expect(resultText(result)).toContain("Wait cleanup is complete");
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

  effectTest("scopes persistent await presentation to tool execution", function* () {
    const service = subagentServiceDouble({ withAwaitTerminalObservations: () => Effect.never });
    const release = vi.fn();
    const presentation = {
      beginStart: vi.fn(() => () => undefined),
      beginAwait: vi.fn(() => release),
      isLiveHierarchyAvailable: vi.fn(() => true),
    };
    const controller = new AbortController();
    const executing = executeTool(
      captureSubagentTools(service, { toolPresentation: presentation }).get("subagent_await")!,
      { runIds: ["agent-1"], until: "all_finished" },
      { signal: controller.signal },
    );

    yield* step(() => Promise.resolve());
    expect(presentation.beginAwait).toHaveBeenCalledWith(["agent-1"], "all_finished");
    expect(release).not.toHaveBeenCalled();
    controller.abort();
    const cancelled = yield* step(() => executing);
    expect(cancelled.details).toMatchObject({ cancelled: true });
    expect(release).toHaveBeenCalledOnce();
  });

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
            : Effect.sync(() => (sent.push(id), view({ id }))),
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

  effectTest(
    "separates pending guidance from unconfirmed and failed targets in model text",
    function* () {
      const steering = (pendingDelivery: boolean) =>
        new SubagentProcessError({
          operation: "steer",
          code: "steer_outcome_uncertain",
          message: "Acknowledgement is pending.",
          ...(pendingDelivery && { pendingDelivery: true }),
        });
      const service = subagentServiceDouble({
        send: (id) =>
          id === "pending"
            ? Effect.fail(steering(true))
            : id === "unflagged"
              ? Effect.fail(steering(false))
              : id === "bad"
                ? Effect.fail(
                    new InvalidSubagentRequestError({ code: "not_running", message: "Paused." }),
                  )
                : Effect.succeed(view({ id })),
      });
      const result = yield* invokeOptionalTool(captureSubagentTools(service).get("subagent_send"), {
        runIds: ["good", "pending", "unflagged", "bad"],
        message: "Conclude.",
      });
      const sections = resultText(result!).split("\n\n");
      const section = (id: string) => sections.find((entry) => entry.includes(`  ${id} [`)) ?? "";
      // Only confirmed targets are acknowledged as delivered.
      expect(sections[0]).toContain("good");
      expect(sections[0]).not.toMatch(/pending|unflagged|bad/);
      expect(section("pending")).toContain("awaiting confirmation");
      expect(section("pending")).toContain("Do not resend");
      expect(section("pending")).toContain("stop remains available");
      expect(section("unflagged")).toContain("Unconfirmed targets");
      expect(section("unflagged")).toContain("Do not resend");
      expect(section("bad")).toContain("Failed targets");
      expect(new Set([section("pending"), section("unflagged"), section("bad")]).size).toBe(3);
      expect(result?.details).toMatchObject({
        actionFailures: [
          { id: "pending", pendingDelivery: true },
          { id: "unflagged", code: "steer_outcome_uncertain" },
          { id: "bad", code: "not_running" },
        ],
      });
      expect(result?.details).not.toHaveProperty("actionFailures.1.pendingDelivery");
    },
  );

  effectTest("rejects lifecycle messages for actions that cannot deliver them", function* () {
    const service = subagentServiceDouble({
      interrupt: () => Effect.succeed(view({ state: "paused" })),
    });
    const tool = captureSubagentTools(service).get("subagent_lifecycle")!;

    yield* step(() =>
      expect(
        executeTool(tool, {
          action: "interrupt",
          runIds: ["agent-1"],
          message: "Pause after this step.",
        }),
      ).rejects.toThrow('message is valid only when action="resume"'),
    );
  });

  effectTest(
    "deduplicates repeated target IDs before applying management operations",
    function* () {
      const sent: string[] = [];
      const service = subagentServiceDouble({
        send: (id) => Effect.sync(() => (sent.push(id), view({ id }))),
      });
      const tool = captureSubagentTools(service).get("subagent_send");

      yield* invokeOptionalTool(tool, { runIds: ["agent-1", "agent-1"], message: "Conclude." });

      expect(sent).toEqual(["agent-1"]);
    },
  );

  effectTest("preserves target order when mixed results finish in reverse order", function* () {
    const ids = ["success-1", "failure-1", "success-2", "failure-2"];
    const gates = yield* Effect.forEach(ids, () => Deferred.make<void>());
    const completed: string[] = [];
    const service = subagentServiceDouble({
      send: (id) =>
        Effect.gen(function* () {
          const index = ids.indexOf(id);
          if (index < ids.length - 1) yield* Deferred.await(gates[index + 1]!);
          completed.push(id);
          yield* Deferred.succeed(gates[index]!, undefined);
          return yield* id.startsWith("failure")
            ? Effect.fail(new InvalidSubagentRequestError({ code: "unavailable", message: id }))
            : Effect.succeed(view({ id }));
        }),
    });
    const result = yield* invokeOptionalTool(captureSubagentTools(service).get("subagent_send"), {
      runIds: ids,
      message: "Continue",
    });
    expect(completed).toEqual([...ids].reverse());
    expect(result?.details).toMatchObject({
      cards: [{ id: "success-1" }, { id: "success-2" }],
      actionFailures: [
        { id: "failure-1", code: "unavailable", message: "failure-1" },
        { id: "failure-2", code: "unavailable", message: "failure-2" },
      ],
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

  effectTest("renders state-aware stop acknowledgements for terminal no-ops", function* () {
    const service = subagentServiceDouble({
      stop: (id) =>
        Effect.succeed(
          view({
            id,
            state:
              id === "agent-complete" ? "completed" : id === "agent-failed" ? "failed" : "stopped",
          }),
        ),
    });
    const result = yield* invokeOptionalTool(
      captureSubagentTools(service).get("subagent_lifecycle"),
      {
        action: "stop",
        runIds: ["agent-complete", "agent-failed", "agent-stopped"],
      },
    );
    expect(result?.content[0]?.text).toContain("agent-complete was already finished");
    expect(result?.content[0]?.text).toContain("agent-failed had already failed");
    expect(result?.content[0]?.text).toContain("agent-stopped is stopped.");
  });

  effectTest(
    "returns structured failures for single-target reply and rename operations",
    function* () {
      const service = subagentServiceDouble({
        reply: (id) =>
          Effect.fail(
            new InvalidSubagentRequestError({
              code: "no_parent_question",
              message: `Subagent ${id} has no pending parent question.`,
            }),
          ),
        rename: (id) =>
          Effect.fail(new SubagentNotFoundError({ id, message: `Subagent run not found: ${id}` })),
      });
      const tools = captureSubagentTools(service);

      const replied = yield* invokeOptionalTool(tools.get("subagent_reply"), {
        runId: "agent-1",
        message: "Proceed.",
      });
      expect(replied?.content[0]?.text).toContain(
        "agent-1 [no_parent_question]: Subagent agent-1 has no pending parent question.",
      );
      expect(replied?.details).toMatchObject({
        actionFailures: [{ id: "agent-1", code: "no_parent_question" }],
      });

      const renamed = yield* invokeOptionalTool(tools.get("subagent_rename"), {
        runId: "agent-missing",
        name: "reviewer",
      });
      expect(renamed?.content[0]?.text).toContain(
        "agent-missing [SubagentNotFoundError]: Subagent run not found: agent-missing",
      );
    },
  );

  effectTest("routes focused reply, lifecycle, and rename operations", function* () {
    const operations: string[] = [];
    const service = subagentServiceDouble({
      reply: (id, message) =>
        Effect.sync(() => (operations.push(`reply:${id}:${message}`), view({ id }))),
      interrupt: (id) =>
        Effect.sync(() => (operations.push(`interrupt:${id}`), view({ id, state: "paused" }))),
      resume: (id, message) =>
        Effect.sync(() => (operations.push(`resume:${id}:${message ?? ""}`), view({ id }))),
      rename: (id, name) =>
        Effect.sync(() => (operations.push(`rename:${id}:${name}`), view({ id, name }))),
      stop: (id) =>
        Effect.sync(() => (operations.push(`stop:${id}`), view({ id, state: "stopped" }))),
    });
    const tools = captureSubagentTools(service);

    yield* invokeOptionalTool(tools.get("subagent_reply"), {
      runId: "agent-1",
      message: "Proceed.",
    });
    yield* invokeOptionalTool(tools.get("subagent_lifecycle"), {
      action: "interrupt",
      runIds: ["agent-1", "agent-2"],
    });
    yield* invokeOptionalTool(tools.get("subagent_lifecycle"), {
      action: "resume",
      runIds: ["agent-1"],
      message: "Continue carefully.",
    });
    yield* invokeOptionalTool(tools.get("subagent_lifecycle"), {
      action: "stop",
      runIds: ["agent-2"],
    });
    yield* invokeOptionalTool(tools.get("subagent_rename"), { runId: "agent-1", name: "reviewer" });

    expect(operations).toEqual([
      "reply:agent-1:Proceed.",
      "interrupt:agent-1",
      "interrupt:agent-2",
      "resume:agent-1:Continue carefully.",
      "stop:agent-2",
      "rename:agent-1:reviewer",
    ]);
  });

  effectTest("returns status for found IDs and model-visible failures for stale IDs", function* () {
    const completed = view({ state: "completed", finalText: "Done." });
    const service = subagentServiceDouble({
      withStatusObservations: (ids, use) =>
        use({
          observations: ids.includes("agent-1") ? [{ run: completed }] : [],
          missingIds: ids.filter((id) => id !== "agent-1"),
        }),
    });
    const tool = captureSubagentTools(service).get("subagent_status");

    const result = yield* invokeOptionalTool(tool, { runIds: ["agent-1", "agent-stale"] });

    expect(result?.content[0]?.text).toContain("Final report\nDone.");
    expect(result?.content[0]?.text).toContain(
      "agent-stale [SubagentNotFoundError]: Subagent run not found: agent-stale",
    );
    expect(result?.details).toMatchObject({
      action: "status",
      actionFailures: [{ id: "agent-stale", code: "SubagentNotFoundError" }],
    });
  });

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
    // Text formatting succeeds, but projection of the persisted details fails.
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

  effectTest("returns await immediately when a subagent needs a parent reply", function* () {
    const waiting = view({
      state: "waiting_for_parent",
      question: {
        requestId: "question-1",
        message: "Should I update the fixture?",
        createdAt: 2,
      },
    });
    const result = yield* awaitSingle(waiting);

    expect(result?.content[0]?.text).toContain(
      'Reply with subagent_reply({ runId: "agent-1", message: "..." }), then call subagent_await again.',
    );
    expect(result?.content[0]?.text).toContain("Needs reply Should I update the fixture?");
    expect(result?.details).toMatchObject({
      action: "await",
      attentionRequired: true,
      cards: [{ state: "waiting_for_parent" }],
    });
  });

  effectTest("returns ordered recovery for a contained paused writer", function* () {
    const paused = containedWriter({ id: "agent-writer", name: "paused-writer", state: "paused" });

    const result = yield* awaitSingle(paused);
    const text = result?.content[0]?.text ?? "";
    expectInOrder(
      text,
      [
        "subagent_status",
        'subagent_claims({ action: "grant"',
        'subagent_claims({ action: "resume_admission"',
        'subagent_lifecycle({ action: "resume"',
      ],
      "subagent_await",
    );
    expect(text).not.toContain("subagent_reply");
    expect(result?.details).toMatchObject({
      action: "await",
      attentionRequired: true,
      cards: [
        {
          id: paused.id,
          state: "paused",
          writeAdmissionPaused: true,
          writeViolationOffender: true,
        },
      ],
    });
  });

  effectTest("branches after status while offender containment is still in progress", function* () {
    const result = yield* awaitSingle(
      containedWriter({
        id: "agent-transitioning-writer",
        name: "transitioning-writer",
        state: "running",
      }),
    );
    const text = result?.content[0]?.text ?? "";

    expect(text).toContain("Containment is in progress");
    expect(text).toContain("If status is paused");
    expect(text).toContain("If status is terminal");
    expect(text).not.toContain("Stop the offender and wait for cleanup");
    expect(result?.details).toMatchObject({ action: "await" });
    expect(result?.details).not.toMatchObject({ attentionRequired: true });
  });

  effectTest("does not recommend granting an outside-workspace violation", function* () {
    const result = yield* awaitSingle(
      containedWriter({
        id: "agent-outside",
        name: "outside-writer",
        state: "stopped",
        capabilities: ["interrupt"],
        writeAudit: violationAudit("<outside workspace>"),
      }),
    );
    const text = result?.content[0]?.text ?? "";

    expect(text).toContain("<outside workspace>");
    expect(text).not.toContain('action: "grant"');
    expectInOrder(
      text,
      [
        "Confirm process and writer cleanup",
        'subagent_claims({ action: "resume_admission"',
        "subagent_start",
      ],
      "subagent_await",
    );
    expect(result?.details).toMatchObject({ action: "await", attentionRequired: true });
  });

  effectTest("does not treat a peer's historical audit as the current offender", function* () {
    const result = yield* awaitSingle(
      view({
        id: "agent-repaired-peer",
        name: "repaired-peer",
        state: "running",
        writeIntent: "writer",
        writeClaims: ["src/a.ts", "src/old.ts"],
        writeAdmissionPaused: true,
        writeAudit: violationAudit("src/old.ts", 1),
      }),
    );
    const text = result?.content[0]?.text ?? "";

    expect(text).toContain("Do not change this peer's claims");
    expect(text).not.toContain('action: "grant"');
    expect(text).not.toContain("Stop the offender and wait for cleanup");
    expect(result?.details).toMatchObject({ action: "await", attentionRequired: true });
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

  effectTest("continues a failed run on the next frozen profile candidate", function* () {
    const failed = view({
      id: "agent-1",
      state: "failed",
      profile: "reviewer",
      error: "Claude usage exhausted.",
      remainingCandidateCount: 1,
      selection: {
        source: "profile-candidate",
        routeSource: "global",
        host: "local",
        runtime: "claude",
        closeOnReport: true,
        candidateIndex: 0,
        reason: "Profile reviewer selected candidate 1.",
        skippedCandidates: [],
      },
    });
    const route = {
      profile: "reviewer",
      routeSource: "global",
      candidates: [
        {
          host: "local",
          runtime: "claude",
          model: "claude-fable-5",
          effort: "medium",
          context: "fresh",
          writeIntent: "read-only",
          openaiFastMode: false,
          closeOnReport: true,
        },
        {
          host: "local",
          runtime: "pi",
          model: "openai-codex/gpt-5.6-sol",
          effort: "xhigh",
          context: "fresh",
          writeIntent: "read-only",
          openaiFastMode: true,
          closeOnReport: true,
        },
      ],
      selectedCandidateIndex: 0,
      skippedCandidates: [],
    } satisfies ProfileRouteContinuation;
    const requests: Array<Parameters<SubagentServiceContract["startRetrySessionOwned"]>[0]> = [];
    const service = subagentServiceDouble({
      claimRetryContinuation: () =>
        Effect.succeed({ source: failed, continuation: route, claimToken: "retry-1" }),
      startRetrySessionOwned: (request, onOwned) =>
        Effect.sync(() => {
          onOwned?.();
          requests.push(request);
          return view({
            id: "agent-2",
            name: request.name ?? failed.name,
            task: request.task,
            profile: request.profile ?? "reviewer",
            predecessorRunId: request.supersedes.runId,
            selection: request.selection ?? failed.selection,
          });
        }),
    });
    const tool = captureSubagentTools(service).get("subagent_lifecycle");

    // Root retry accepts and ignores a message; only interrupt, stop, and resume reject one.
    const result = yield* invokeOptionalTool(tool, {
      action: "retry",
      runIds: ["agent-1"],
      message: "Ignored by retry.",
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      task: failed.task,
      profile: "reviewer",
      model: "openai-codex/gpt-5.6-sol",
      openaiFastMode: true,
      supersedes: { runId: "agent-1", claimToken: "retry-1" },
      routeContinuation: { selectedCandidateIndex: 1 },
      selection: {
        candidateIndex: 1,
        skippedCandidates: [{ candidateIndex: 0, code: "previous_run_failed" }],
      },
    });
    expect(result?.content[0]?.text).toContain(
      "Continued agent-1 as agent-2 on profile reviewer candidate 2.",
    );
    expect(result?.details).toMatchObject({
      action: "retry",
      cards: [{ id: "agent-2" }],
    });
  });

  effectTest(
    "routes dedicated claim operations through the parent-only coordination tool",
    function* () {
      const grants: Array<{ readonly id: string; readonly paths: ReadonlyArray<string> }> = [];
      const claimed = view({
        id: "agent-claims",
        writeIntent: "writer",
        writeClaims: ["src/a.ts", "src/b.ts"],
        writeAdmissionPaused: true,
      });
      const service = subagentServiceDouble({
        withStatusObservations: (_ids, use) =>
          use({ observations: [{ run: claimed }], missingIds: [] }),
        grantWriteClaims: (id, paths) =>
          Effect.sync(() => {
            grants.push({ id, paths });
            return claimed;
          }),
        resumeWriterAdmission: () =>
          Effect.succeed(
            view({
              ...claimed,
              state: "stopped",
              writeAdmissionPaused: undefined,
              writeViolationOffender: undefined,
              writeAudit: violationAudit("src/b.ts"),
            }),
          ),
      });
      const tool = captureSubagentTools(service).get("subagent_claims");
      const result = yield* invokeOptionalTool(tool, {
        action: "grant",
        runId: "agent-claims",
        paths: ["src/b.ts"],
      });
      expect(grants).toEqual([{ id: "agent-claims", paths: ["src/b.ts"] }]);
      expect(result?.content[0]?.text).toContain("src/a.ts, src/b.ts");
      expect(result?.content[0]?.text).toContain("Do not use subagent_reply for containment");
      expect(result?.content[0]?.text).not.toContain("send the resulting authoritative claim set");
      expect(result?.details).toMatchObject({
        version: 2,
        action: "claims",
        cards: [{ id: "agent-claims", writeClaims: ["src/a.ts", "src/b.ts"] }],
      });

      const listed = yield* invokeOptionalTool(tool, { action: "list", runIds: ["agent-claims"] });
      expect(listed?.content[0]?.text).toContain("Do not use subagent_reply for containment");
      expect(listed?.content[0]?.text).not.toContain("send the resulting authoritative claim set");

      const reopened = yield* invokeOptionalTool(tool, {
        action: "resume_admission",
        runId: "agent-claims",
      });
      expect(reopened?.content[0]?.text).toContain("stop and replace");
      expect(reopened?.content[0]?.text).not.toContain(
        "send the resulting authoritative claim set",
      );
    },
  );

  effectTest(
    "enforces the final model-visible output bound for list, zero-run, and all-failure paths",
    function* () {
      const oversizedRuns = Array.from({ length: 12 }, (_, index) =>
        view({
          id: `agent-${index + 1}`,
          name: `run-${index + 1}`,
          model: `provider/${"m".repeat(8_000)}`,
        }),
      );
      const failStart: SubagentServiceContract["start"] = () =>
        Effect.fail(
          new InvalidSubagentRequestError({
            code: "all_failed",
            message: "f".repeat(64_000),
          }),
        );
      const service = subagentServiceDouble({
        list: Effect.succeed(oversizedRuns),
        start: failStart,
        startSessionOwned: failStart,
      });
      const tools = captureSubagentTools(service);
      const listed = yield* invokeOptionalTool(tools.get("subagent_list"), {});
      expect(listed?.content[0]?.text.length).toBeLessThanOrEqual(48_000);
      expect(listed?.content[0]?.text).toContain("tool output truncated; narrow the request");

      const emptyService = subagentServiceDouble({ list: Effect.succeed([]) });
      const empty = yield* invokeOptionalTool(
        captureSubagentTools(emptyService).get("subagent_list"),
        {},
      );
      expect(empty?.content[0]?.text).toBe("No subagent runs.");
      expect(empty?.content[0]?.text.length).toBeLessThanOrEqual(48_000);

      const failed = yield* invokeOptionalTool(tools.get("subagent_start"), {
        agents: Array.from({ length: 12 }, (_, index) => ({
          task: `Fail ${index + 1}`,
        })),
      });
      expect(failed?.content[0]?.text.length).toBeLessThanOrEqual(48_000);
      expect(failed?.content[0]?.text).toContain("Failed starts (12)");
    },
  );
});
