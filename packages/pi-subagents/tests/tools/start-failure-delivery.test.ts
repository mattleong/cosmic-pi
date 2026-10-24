import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { assert, describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import * as TestClock from "effect/testing/TestClock";
import { extensionApiFixture, yieldUntil } from "pi-cosmic-core/testing";
import { SubagentBackendRegistry } from "../../src/backend/service.ts";
import type { SubagentNotification } from "../../src/boundary/host-notifier.ts";
import { sessionReportArchive } from "../../src/boundary/report-archive.ts";
import { SubagentProfileService } from "../../src/profiles/service.ts";
import type { SubagentProjection } from "../../src/run/model.ts";
import { SubagentService, type SubagentServiceContract } from "../../src/run/service.ts";
import { executeSubagentActionEffect } from "../../src/tools/execute.ts";
import { executeWorkspaceAction } from "../../src/tools/execute-workspace.ts";
import { nodeFsPromises as fs } from "../support/node-builtins.ts";
import { temporaryDirectory } from "../workspace/fixtures/repository.ts";
import {
  acknowledgeCompletions,
  awaitObservations,
  fakeChildLayer,
  localServiceFixture,
  runViews,
  withService,
} from "../run/fixtures/service-harness.ts";
import { stoppedWriter, workspaceFixture } from "../run/fixtures/workspace-engine.ts";
import { context, fallbackProfileService, testBackendRegistry } from "./fixtures/tool-harness.ts";

// A rendered cause carries stack frames and dependency paths; a run's error never does.
const STACK_TRACE = /\n\s*at\s|node_modules|file:\/\//u;

const rejectedPrompt = (spawnIndex: number, error = "Prompt was rejected.") =>
  ({ spawnIndex, type: "prompt", error }) as const;

const resultText = (result: AgentToolResult<unknown>) =>
  Arr.join(
    Arr.map(result.content, (part) => (part.type === "text" ? part.text : "")),
    "\n",
  );

const startTasks = (service: SubagentServiceContract, tasks: ReadonlyArray<string>) =>
  executeSubagentActionEffect(
    extensionApiFixture({ getThinkingLevel: () => "high", getActiveTools: () => ["read"] }),
    { cwd: "/project", projectTrusted: true },
    { tool: "agent_start", args: { agents: Arr.map(tasks, (task) => ({ task })) } },
    undefined,
    context,
  ).pipe(
    Effect.provideService(SubagentService, service),
    Effect.provideService(SubagentProfileService, fallbackProfileService),
    Effect.provideService(SubagentBackendRegistry, testBackendRegistry),
  );

const noticedRuns = (notifications: ReadonlyArray<SubagentNotification>) =>
  Arr.flatMap(notifications, (notification) =>
    notification.type === "completed" ? notification.runs : [],
  );

const failedRunCount = (projections: ReadonlyArray<SubagentProjection>) =>
  Option.match(Arr.last(projections), {
    onNone: () => 0,
    onSome: (projection) => Arr.filter(projection.runs, (run) => run.state === "failed").length,
  });

describe("agent_start failures after admission", () => {
  it.effect("reports the failure once, in the start result, with a clean error", () => {
    const { layer, notifications } = localServiceFixture(
      { notify: acknowledgeCompletions },
      fakeChildLayer(Effect.void, { initialFailures: [rejectedPrompt(0)] }),
    );
    return withService(layer, function* (service) {
      const result = yield* startTasks(service, ["Map the auth flow"]);
      const [run] = yield* runViews(service);
      expect(run?.state).toBe("failed");
      expect(run?.error).toBeTruthy();
      expect(run?.error).not.toMatch(STACK_TRACE);
      // The run keeps the failure the start result reports.
      expect(result.structuredContent).toMatchObject({
        outcome: "failed",
        launches: [{ admittedRun: { runId: run?.id }, failure: { message: run?.error } }],
      });

      yield* TestClock.adjust("1 second");
      expect(noticedRuns(notifications)).toEqual([]);

      // An await returns the failed run at once, with no outcome left to deliver.
      const [observation] = yield* awaitObservations(service, [run!.id]);
      expect(observation?.run).toMatchObject({ state: "failed", error: run?.error });
      expect(observation?.completionReceipt).toBeUndefined();
      const read = yield* service.agentRead({ kind: "main" }, [run!.id]);
      expect(read.agents).toMatchObject([{ state: "failed", run: { error: run?.error } }]);

      yield* TestClock.adjust("1 second");
      expect(noticedRuns(notifications)).toEqual([]);
    });
  });

  it.effect("hands over a long failure's saved file and points the next step at the run", () =>
    Effect.gen(function* () {
      const agent = yield* temporaryDirectory("start-failure-");
      const detail = Fn.pipe("detail ", Str.repeat(100));
      const { layer, notifications } = localServiceFixture(
        { notify: acknowledgeCompletions, archiveReport: sessionReportArchive(agent, "session-1") },
        fakeChildLayer(Effect.void, {
          initialFailures: [rejectedPrompt(0, `Prompt was rejected. ${detail}`)],
        }),
      );
      yield* withService(layer, function* (service) {
        const result = yield* startTasks(service, ["Map the auth flow"]);
        const [run] = yield* runViews(service);
        const file = run?.errorArchive;
        assert(run !== undefined && file !== undefined);
        expect(yield* Effect.promise(() => fs.readFile(file.path, "utf8"))).toBe(run.error);
        // The notice it replaces pointed at the file; the start result does instead.
        const text = resultText(result);
        expect(text).toContain(file.path);
        expect(text).toContain(`agent_read ${run.id}`);
        expect(text).not.toContain(detail);
        expect(result.structuredContent).toMatchObject({
          launches: [{ admittedRun: { runId: run.id, errorFile: { path: file.path } } }],
        });
        yield* TestClock.adjust("1 second");
        expect(noticedRuns(notifications)).toEqual([]);
      });
    }).pipe(Effect.scoped),
  );

  it.effect(
    "reports a revision successor that fails during startup only in the revise result",
    () => {
      const notifications: SubagentNotification[] = [];
      const f = workspaceFixture({
        children: fakeChildLayer(Effect.void, { initialFailures: [rejectedPrompt(1)] }),
        serviceOptions: {
          notify: (notification) => {
            notifications.push(notification);
            return acknowledgeCompletions(notification);
          },
        },
      });
      return withService(f.layer, function* (service) {
        const writer = yield* stoppedWriter(service);
        const failure = yield* executeWorkspaceAction({
          action: "revise",
          workspaceId: writer.workspaceId!,
          message: "Handle the empty case.",
        }).pipe(Effect.provideService(SubagentService, service), Effect.flip);
        const successor = Option.getOrUndefined(
          Arr.findFirst(yield* runViews(service), (run) => run.id !== writer.id),
        );
        assert(successor !== undefined);
        expect(successor.state).toBe("failed");
        // The failure names the successor, since no notice follows it.
        expect(failure.message).toContain(successor.id);
        yield* TestClock.adjust("1 second");
        expect(noticedRuns(notifications)).toEqual([]);
        const [observation] = yield* awaitObservations(service, [successor.id]);
        expect(observation?.run.state).toBe("failed");
        expect(observation?.completionReceipt).toBeUndefined();
      });
    },
  );

  it.effect("notifies failures that an interrupted start call never reported", () => {
    const gates = [Deferred.makeUnsafe<void>(), Deferred.makeUnsafe<void>()];
    const fake = fakeChildLayer(Effect.void, {
      initialSendGates: Arr.map(gates, (gate, spawnIndex) => ({
        spawnIndex,
        type: "prompt" as const,
        gate,
      })),
      initialFailures: [rejectedPrompt(0), rejectedPrompt(1)],
    });
    const { layer, notifications, projections } = localServiceFixture(
      { notify: acknowledgeCompletions },
      fake,
    );
    return withService(layer, function* (service) {
      const call = yield* startTasks(service, ["Map the auth flow", "Map billing"]).pipe(
        Effect.forkChild,
      );
      yield* yieldUntil(
        () =>
          fake.controls.length === 2 &&
          Arr.every(fake.controls, (control) => control.sent("prompt")),
      );
      // One launch fails while the call still waits for the other, so the call holds its outcome.
      yield* Deferred.succeed(gates[0]!, undefined);
      yield* yieldUntil(() => failedRunCount(projections) === 1);
      yield* TestClock.adjust("1 second");
      expect(noticedRuns(notifications)).toEqual([]);

      yield* Fiber.interrupt(call);
      // The other fails after the call ended.
      yield* Deferred.succeed(gates[1]!, undefined);
      yield* yieldUntil(() => failedRunCount(projections) === 2);
      yield* TestClock.adjust("1 second");
      yield* yieldUntil(() => noticedRuns(notifications).length === 2);

      const runs = yield* runViews(service);
      expect(new Set(Arr.map(noticedRuns(notifications), (run) => run.id))).toEqual(
        new Set(Arr.map(runs, (run) => run.id)),
      );
      for (const run of noticedRuns(notifications)) {
        expect(run.outcome).toBe("failed");
        expect(run.error).not.toMatch(STACK_TRACE);
      }
    });
  });
});
