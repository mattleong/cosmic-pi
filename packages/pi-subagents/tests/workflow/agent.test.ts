import { describe, expect, it } from "@effect/vitest";
import { yieldUntil } from "pi-cosmic-core/testing";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Semaphore from "effect/Semaphore";
import { emptyUsage } from "../../src/run/model.ts";
import { SubagentCapacityError, SubagentWriterConflictError } from "../../src/run/errors.ts";
import type { OwnedRunHandle, OwnedRunOutcome, OwnedRunStart } from "../../src/run/owned-runs.ts";
import {
  makeWorkflowAgentCall,
  type WorkflowAgentRun,
  type WorkflowAgentServices,
} from "../../src/workflow/agent.ts";
import { makeWorkflowReplay, type WorkflowJournalEntry } from "../../src/workflow/journal.ts";
import type { WorkflowAgentView } from "../../src/workflow/model.ts";
import { workflowAgentJournalKey } from "../../src/workflow/options.ts";
import { view } from "../fixtures/run-view.ts";
import { testHost } from "./fixtures/workflow-harness.ts";

const unexpected = Effect.die(new Error("Unexpected subagent service call."));

interface Recorded {
  readonly journal: WorkflowJournalEntry[];
  readonly counted: Array<readonly [number, boolean]>;
  readonly updates: Array<Partial<WorkflowAgentView>>;
  readonly logs: string[];
}

const admitted = (owner: OwnedRunStart): OwnedRunHandle => ({
  runId: owner.runId ?? "agent-r1-1",
  ownerId: owner.ownerId,
  generation: 1,
  claimToken: "claim",
});

const harness = (
  run: Partial<WorkflowAgentRun>,
  outcome?: OwnedRunOutcome,
  subagents: Partial<WorkflowAgentServices["subagents"]> = {},
) => {
  const recorded: Recorded = { journal: [], counted: [], updates: [], logs: [] };
  const services: WorkflowAgentServices = {
    subagents: {
      reserveRunId: Effect.succeed("agent-r1-1"),
      projection: Effect.succeed({ revision: 0, runs: [] }),
      admissionRevision: Effect.succeed(0),
      waitForAdmissionChange: () => unexpected,
      queuedStartRefused: () => Effect.succeed(false),
      workspaceBindingStatus: () => Effect.succeed("pending"),
      startOwned: (_request, owner) => Effect.succeed(admitted(owner)),
      awaitOwned: () => (outcome ? Effect.succeed(outcome) : unexpected),
      ...subagents,
    },
    journal: {
      record: (_runId, entry) => Effect.sync(() => void recorded.journal.push(entry)),
      noteWorkspace: () => Effect.void,
    },
  };
  const call = makeWorkflowAgentCall(
    {
      workflowId: "wf-a-1",
      workflowName: "review",
      host: testHost(),
      replay: undefined,
      permits: Semaphore.makeUnsafe(1),
      nextCall: Effect.succeed(1),
      queue: () => Effect.void,
      update: (_runId, change) => Effect.sync(() => void recorded.updates.push(change)),
      forget: () => Effect.void,
      log: (_level, message) => Effect.sync(() => void recorded.logs.push(message)),
      count: (outputTokens) => Effect.sync(() => void recorded.counted.push([outputTokens, false])),
      reuse: (entry) => Effect.sync(() => void recorded.counted.push([entry.outputTokens, true])),
      ...run,
    },
    services,
  );
  return { call, recorded };
};

const completed = (text: string): OwnedRunOutcome => ({
  kind: "completed",
  text,
  usage: { ...emptyUsage(), output: 11 },
});

describe("workflow agent call", () => {
  it.effect("rejects calls past the run's agent limit before reserving a run", () =>
    Effect.gen(function* () {
      const { call } = harness({ nextCall: Effect.sync(() => undefined) });
      const error = yield* call(["task", {}]).pipe(Effect.flip);
      expect(error.message).toContain("1000");
    }),
  );

  it.effect("replays an identical earlier result without starting an agent", () =>
    Effect.gen(function* () {
      const key = workflowAgentJournalKey("task", {}, undefined);
      const { call, recorded } = harness({
        replay: makeWorkflowReplay([{ key, result: "cached", outputTokens: 7, chars: 6 }]),
        nextCall: unexpected,
      });
      expect(yield* call(["task", { label: "any label" }])).toEqual({
        result: "cached",
        outputTokens: 7,
      });
      expect(recorded.journal).toEqual([expect.objectContaining({ key, result: "cached" })]);
      expect(recorded.counted).toEqual([[7, true]]);
    }),
  );

  it.effect("returns the final text and journals it with its output tokens", () =>
    Effect.gen(function* () {
      const { call, recorded } = harness({}, completed("All good."));
      expect(yield* call(["task", {}])).toEqual({ result: "All good.", outputTokens: 11 });
      expect(recorded.journal).toEqual([
        expect.objectContaining({ result: "All good.", outputTokens: 11 }),
      ]);
      expect(recorded.updates.at(-1)).toMatchObject({ state: "completed" });
    }),
  );

  it.effect("resolves null with a warning when a structured result isn't JSON", () =>
    Effect.gen(function* () {
      const { call, recorded } = harness({}, completed("not json"));
      const schema = { type: "object", properties: { ok: { type: "boolean" } } };
      expect(yield* call(["task", { schema }])).toEqual({ result: null, outputTokens: 11 });
      expect(recorded.journal).toEqual([]);
      expect(recorded.updates.at(-1)).toMatchObject({ state: "failed" });
      expect(recorded.logs).toHaveLength(1);
    }),
  );

  it.effect("waits for an admission change behind a writer conflict that clears by itself", () =>
    Effect.gen(function* () {
      const released = yield* Deferred.make<void>();
      let attempts = 0;
      const { call } = harness({}, completed("Migrated."), {
        startOwned: (_request, owner) =>
          ++attempts === 1
            ? Effect.fail(
                new SubagentWriterConflictError({
                  activeId: "agent-r1-0",
                  activeName: "previous writer",
                  message: "Writer previous writer is still cleaning up; retry shortly.",
                  transient: true,
                }),
              )
            : Effect.succeed(admitted(owner)),
        waitForAdmissionChange: () => Deferred.await(released),
      });
      const fiber = yield* call(["migrate", { profile: "worker" }]).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      expect(attempts).toBe(1);
      yield* Deferred.succeed(released, undefined);
      expect(yield* Fiber.join(fiber)).toEqual({ result: "Migrated.", outputTokens: 11 });
      expect(attempts).toBe(2);
    }),
  );

  it.effect("gives its permit back while queued, so other agents keep starting", () =>
    Effect.gen(function* () {
      const released = yield* Deferred.make<void>();
      const started: string[] = [];
      const { call, recorded } = harness({}, completed("Done."), {
        startOwned: (request, owner) =>
          request.task === "migrate" && !started.includes("migrate-refused")
            ? Effect.sync(() => void started.push("migrate-refused")).pipe(
                Effect.andThen(
                  Effect.fail(
                    new SubagentWriterConflictError({
                      activeId: "agent-r1-0",
                      activeName: "root writer",
                      message: "Writer root writer (agent-r1-0) owns the shared cwd exclusively.",
                      transient: true,
                    }),
                  ),
                ),
              )
            : Effect.sync(() => void started.push(request.task)).pipe(Effect.as(admitted(owner))),
        waitForAdmissionChange: () => Deferred.await(released),
      });
      // One permit: a queued writer that kept it would block the reader until it ran.
      const writer = yield* call(["migrate", { profile: "worker" }]).pipe(Effect.forkChild);
      yield* yieldUntil(() => started.includes("migrate-refused"));
      const reader = yield* call(["review", {}]).pipe(Effect.forkChild);
      yield* yieldUntil(() => reader.pollUnsafe() !== undefined);
      expect(yield* Fiber.join(reader)).toEqual({ result: "Done.", outputTokens: 11 });
      expect(writer.pollUnsafe()).toBeUndefined();
      // The wait names the writer it is queued behind.
      expect(recorded.logs.some((line) => line.includes("agent-r1-0"))).toBe(true);
      yield* Deferred.succeed(released, undefined);
      expect(yield* Fiber.join(writer)).toEqual({ result: "Done.", outputTokens: 11 });
      expect(started).toEqual(["migrate-refused", "review", "migrate"]);
    }),
  );

  it.effect("resolves null at once behind a writer conflict nothing will clear", () =>
    Effect.gen(function* () {
      const { call, recorded } = harness({}, undefined, {
        startOwned: () =>
          Effect.fail(
            new SubagentWriterConflictError({
              activeId: "shared-writer-pool",
              activeName: "shared writer pool",
              message: "New writers are paused for this cwd after a write-claim violation.",
            }),
          ),
      });
      expect(yield* call(["migrate", { profile: "worker" }])).toEqual({
        result: null,
        outputTokens: 0,
      });
      expect(recorded.updates.at(-1)).toMatchObject({ state: "failed" });
      expect(recorded.logs.join("\n")).toContain("paused");
    }),
  );

  it.effect("journals a writer's worktree and reports it again when the result is reused", () =>
    Effect.gen(function* () {
      const { call, recorded } = harness({}, completed("Fixed."), {
        projection: Effect.succeed({
          revision: 1,
          runs: [view({ id: "agent-r1-1", workspaceId: "workspace-9" })],
        }),
      });
      yield* call(["fix", { profile: "worker", isolation: "worktree", label: "fixer" }]);
      expect(recorded.journal).toEqual([
        expect.objectContaining({ workspaceId: "workspace-9", label: "fixer" }),
      ]);
      const reused: Array<string | undefined> = [];
      const resumed = harness({
        replay: makeWorkflowReplay(recorded.journal),
        nextCall: unexpected,
        reuse: (entry) => Effect.sync(() => void reused.push(entry.workspaceId)),
      });
      yield* resumed.call(["fix", { profile: "worker", isolation: "worktree" }]);
      expect(reused).toEqual(["workspace-9"]);
    }),
  );

  it.effect("counts a reused result in the call's display phase", () =>
    Effect.gen(function* () {
      const key = workflowAgentJournalKey("task", {}, undefined);
      const phases: Array<string | undefined> = [];
      const { call } = harness({
        replay: makeWorkflowReplay([{ key, result: "cached", outputTokens: 7, chars: 6 }]),
        nextCall: unexpected,
        reuse: (_entry, phase) => Effect.sync(() => void phases.push(phase)),
      });
      yield* call(["task", { phase: "Find" }]);
      expect(phases).toEqual(["Find"]);
    }),
  );

  for (const status of ["unbound", "closed"] as const)
    it.effect(`runs a worktree writer again when its worktree is ${status}`, () =>
      Effect.gen(function* () {
        const options = { profile: "worker", isolation: "worktree" as const };
        const key = workflowAgentJournalKey("fix", options, undefined);
        const { call, recorded } = harness(
          {
            replay: makeWorkflowReplay([
              { key, result: "Fixed.", outputTokens: 7, chars: 6, workspaceId: "workspace-9" },
            ]),
          },
          completed("Fixed again."),
          { workspaceBindingStatus: () => Effect.succeed(status) },
        );
        expect(yield* call(["fix", options])).toEqual({ result: "Fixed again.", outputTokens: 11 });
        expect(recorded.counted).toEqual([[11, false]]);
        expect(recorded.logs.some((line) => line.includes("workspace-9"))).toBe(true);
      }),
    );

  it.effect("reuses an integrated writer's result without listing its worktree", () =>
    Effect.gen(function* () {
      const options = { profile: "worker", isolation: "worktree" as const };
      const key = workflowAgentJournalKey("fix", options, undefined);
      const entry = {
        key,
        result: "Fixed.",
        outputTokens: 7,
        chars: 6,
        workspaceId: "workspace-9",
      };
      const reused: Array<string | undefined> = [];
      const { call, recorded } = harness(
        {
          replay: makeWorkflowReplay([entry]),
          nextCall: unexpected,
          reuse: (counted) => Effect.sync(() => void reused.push(counted.workspaceId)),
        },
        undefined,
        { workspaceBindingStatus: () => Effect.succeed("integrated") },
      );
      expect(yield* call(["fix", options])).toEqual({ result: "Fixed.", outputTokens: 7 });
      expect(reused).toEqual([undefined]);
      // The journal keeps the worktree, so resuming this run checks it again.
      expect(recorded.journal).toEqual([entry]);
    }),
  );

  it.effect("checks a queued start's refusal before starting it again after a release", () =>
    Effect.gen(function* () {
      let blocked = true;
      let attempts = 0;
      let revision = 0;
      const releases: Array<Deferred.Deferred<void>> = [];
      const release = (index: number) =>
        Effect.suspend(() => {
          revision += 1;
          return Deferred.succeed(releases[index]!, undefined);
        });
      const { call } = harness({}, completed("Done."), {
        admissionRevision: Effect.sync(() => revision),
        waitForAdmissionChange: (after) =>
          after < revision
            ? Effect.void
            : Deferred.make<void>().pipe(
                Effect.tap((released) => Effect.sync(() => void releases.push(released))),
                Effect.flatMap(Deferred.await),
              ),
        queuedStartRefused: () => Effect.sync(() => blocked),
        startOwned: (_request, owner) =>
          Effect.suspend(() => {
            attempts += 1;
            return blocked
              ? Effect.fail(
                  new SubagentCapacityError({
                    limit: 1,
                    code: "direct_child_capacity",
                    message: "Direct-child capacity reached.",
                  }),
                )
              : Effect.succeed(admitted(owner));
          }),
      });
      const fiber = yield* call(["review", {}]).pipe(Effect.forkChild);
      yield* yieldUntil(() => releases.length === 1);
      expect(attempts).toBe(1);
      // A release that leaves the root full wakes the call, which waits again without a start.
      yield* release(0);
      yield* yieldUntil(() => releases.length === 2);
      expect(attempts).toBe(1);
      blocked = false;
      yield* release(1);
      expect(yield* Fiber.join(fiber)).toEqual({ result: "Done.", outputTokens: 11 });
      expect(attempts).toBe(2);
    }),
  );

  it.effect("retries at once when a release lands while it checks its refusal", () =>
    Effect.gen(function* () {
      let revision = 0;
      let checks = 0;
      let attempts = 0;
      const { call } = harness({}, completed("Done."), {
        admissionRevision: Effect.sync(() => revision),
        // Only a revision read before the check sees the release that lands during it.
        waitForAdmissionChange: (after) => (after < revision ? Effect.void : Effect.never),
        queuedStartRefused: () =>
          Effect.sync(() => {
            checks += 1;
            if (checks > 1) return false;
            revision += 1;
            return true;
          }),
        startOwned: (_request, owner) =>
          Effect.suspend(() => {
            attempts += 1;
            if (attempts > 1) return Effect.succeed(admitted(owner));
            revision += 1;
            return Effect.fail(
              new SubagentCapacityError({
                limit: 1,
                code: "direct_child_capacity",
                message: "Direct-child capacity reached.",
              }),
            );
          }),
      });
      expect(yield* call(["review", {}])).toEqual({ result: "Done.", outputTokens: 11 });
      expect(attempts).toBe(2);
    }),
  );

  it.effect("resolves null for a failed agent and keeps its spent tokens", () =>
    Effect.gen(function* () {
      const { call, recorded } = harness(
        {},
        { kind: "failed", reason: "Model refused.", usage: { ...emptyUsage(), output: 3 } },
      );
      expect(yield* call(["task", {}])).toEqual({ result: null, outputTokens: 3 });
      expect(recorded.counted).toEqual([[3, false]]);
      expect(recorded.logs.join("\n")).toContain("Model refused.");
    }),
  );
});
