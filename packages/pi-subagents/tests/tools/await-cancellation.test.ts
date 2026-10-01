// The registered tool and managed runtime are the Promise-shaped Pi host boundary.
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Duration from "effect/Duration";
import { makePiManagedRuntime } from "pi-cosmic-core";
import { expect } from "vitest";
import { SubagentService } from "../../src/run/service.ts";
import type { SubagentToolRuntime } from "../../src/tools/execute.ts";
import { registerSubagentTools } from "../../src/tools/subagent.ts";
import {
  nativeReportRequest,
  nativeReportServiceFixture,
} from "../run/fixtures/service-harness.ts";
import { extensionApiFixture } from "../fixtures/pi-host.ts";
import { step } from "../support/effect-test.ts";
import { executeTool } from "./fixtures/tool-harness.ts";

it.live("returns a parent question in the await result without a second notification", () =>
  Effect.gen(function* () {
    const fixture = nativeReportServiceFixture();
    const tools = new Map<string, ToolDefinition>();
    const pi = extensionApiFixture({
      registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
    });
    const runtime = yield* Effect.acquireRelease(
      Effect.sync(() =>
        makePiManagedRuntime(pi, Layer.merge(fixture.layer, fixture.backend.layer)),
      ),
      (owned) => step(() => owned.dispose()),
    );
    registerSubagentTools(pi, {
      environment: { cwd: "/project", projectTrusted: true },
      run: (effect, signal) => runtime.run(effect, signal),
    });
    const service = yield* step(() => runtime.run(SubagentService));
    const child = yield* step(() => runtime.run(service.startSessionOwned(nativeReportRequest())));
    const progress = Deferred.makeUnsafe<void>();
    const pending = executeTool(
      tools.get("subagent_await")!,
      { runIds: [child.id], until: "all_finished" },
      { callID: "question-await", update: () => Deferred.doneUnsafe(progress, Effect.void) },
    );
    yield* Deferred.await(progress);
    fixture.backend.controls[0]!.offer({
      type: "supervisor_contact",
      assignmentEpoch: 1,
      requestId: "question-from-child",
      kind: "question",
      message: "Which change should I make?",
    });
    const result = yield* step(() => pending);
    expect(result.details).toMatchObject({
      action: "await",
      cards: [{ id: child.id, state: "waiting_for_parent" }],
    });
    expect(result.content[0]).toMatchObject({
      text: expect.stringContaining("Which change should I make?"),
    });
    yield* Effect.sleep(Duration.millis(50));
    expect(fixture.notifications.filter((item) => item.type === "question")).toHaveLength(0);
  }),
);

it.live(
  "cancels a registered root await on the real revision stream without stopping its child",
  () =>
    Effect.gen(function* () {
      const fixture = nativeReportServiceFixture();
      const tools = new Map<string, ToolDefinition>();
      const pi = extensionApiFixture({
        registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
      });
      const runtime = yield* Effect.acquireRelease(
        Effect.sync(() =>
          makePiManagedRuntime(pi, Layer.merge(fixture.layer, fixture.backend.layer)),
        ),
        (owned) => step(() => owned.dispose()),
      );
      const exits: Exit.Exit<unknown, unknown>[] = [];
      const rejections: unknown[] = [];
      const run: SubagentToolRuntime["run"] = (effect, signal) =>
        runtime
          .run(
            effect.pipe(Effect.onExit((exit) => Effect.sync(() => void exits.push(exit)))),
            signal,
          )
          .catch((error) => {
            rejections.push(error);
            throw error;
          });
      let activePresentations = 0;
      registerSubagentTools(pi, {
        environment: { cwd: "/project", projectTrusted: true },
        run,
        toolPresentation: {
          beginStart: () => () => undefined,
          beginAwait: () => {
            activePresentations += 1;
            return () => {
              activePresentations -= 1;
            };
          },
          isLiveHierarchyAvailable: () => true,
        },
      });
      const service = yield* step(() => runtime.run(SubagentService));
      const child = yield* step(() =>
        runtime.run(service.startSessionOwned(nativeReportRequest())),
      );
      expect(child.state).toBe("running");
      const tool = tools.get("subagent_await")!;
      const progress = Deferred.makeUnsafe<void>();
      const updates: AgentToolResult<unknown>[] = [];
      const controller = new AbortController();
      const pending = executeTool(
        tool,
        { runIds: [child.id], until: "all_finished" },
        {
          callID: "cancelled-await",
          signal: controller.signal,
          update: (result) => {
            updates.push(result);
            Deferred.doneUnsafe(progress, Effect.void);
          },
        },
      );
      yield* Deferred.await(progress);
      expect(activePresentations).toBe(1);
      // The real service owns the claim while waiting on the SubscriptionRef revision source.
      const conflict = yield* step(() =>
        runtime.run(service.awaitTerminal([child.id], "all_finished").pipe(Effect.flip)),
      );
      expect(conflict).toMatchObject({ code: "completion_claim_conflict" });
      controller.abort();
      const result = yield* step(() => pending);
      expect(exits).toHaveLength(1);
      const exit = exits[0]!;
      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
      expect(rejections).toHaveLength(1);
      expect(result.details).toMatchObject({
        action: "await",
        cancelled: true,
        awaitedRunIds: [child.id],
        cards: [{ id: child.id, state: "running" }],
      });
      expect(result.details).not.toHaveProperty("cancellationCleanup");
      expect(updates.at(-1)).toEqual(result);
      const cancelledUpdateCount = updates.length;
      expect(activePresentations).toBe(0);
      expect(fixture.backend.controls[0]!.terminations).toEqual([]);
      expect((yield* step(() => runtime.run(service.status(child.id)))).state).toBe("running");

      // A replacement await must acquire the same report claim immediately after cancellation.
      const replacementProgress = Deferred.makeUnsafe<void>();
      const replacement = executeTool(
        tool,
        { runIds: [child.id], until: "all_finished" },
        {
          callID: "replacement-await",
          update: () => Deferred.doneUnsafe(replacementProgress, Effect.void),
        },
      );
      yield* Deferred.await(replacementProgress);
      fixture.backend.controls[0]!.offer({
        type: "report",
        runId: child.id,
        sequence: 1,
        deliveryId: "after-cancel",
        text: "Child finished normally.",
      });
      const completed = yield* step(() => replacement);
      expect(completed.details).toMatchObject({
        action: "await",
        cards: [{ id: child.id, state: "completed", finalText: "Child finished normally." }],
      });
      expect(completed.details).not.toHaveProperty("cancelled");
      expect(fixture.backend.controls[0]!.terminations).toEqual([]);
      expect(updates).toHaveLength(cancelledUpdateCount);
      expect(activePresentations).toBe(0);
      yield* step(() => runtime.dispose());
      expect(fixture.backend.controls[0]!.released()).toBe(1);
    }),
);
