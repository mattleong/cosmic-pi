import { describe, expect, it } from "@effect/vitest";
import { yieldUntil } from "pi-cosmic-core/testing";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { emptyUsage } from "../../src/run/model.ts";
import { InvalidSubagentRequestError, SubagentWriterConflictError } from "../../src/run/errors.ts";
import type { OwnedRunHandle, OwnedRunOutcome, OwnedRunStart } from "../../src/run/owned-runs.ts";
import {
  makeWorkflowAgentCall,
  type WorkflowAgentRun,
  type WorkflowAgentServices,
} from "../../src/workflow/agent.ts";
import { makeWorkflowSlots } from "../../src/workflow/admission-queue.ts";
import { makeWorkflowBudget } from "../../src/workflow/budget.ts";
import { makeWorkflowReplay, type WorkflowJournalEntry } from "../../src/workflow/journal.ts";
import type { WorkflowAgentSpend, WorkflowAgentView } from "../../src/workflow/model.ts";
import { workflowAgentJournalKey, type WorkflowAgentOptions } from "../../src/workflow/options.ts";
import type { WorkflowResultLine } from "../../src/workflow/results.ts";
import { workflowAgentFromDraft } from "../../src/workflow/state.ts";
import { view } from "../fixtures/run-view.ts";
import { testHost } from "./fixtures/workflow-harness.ts";

const unexpected = Effect.die(new Error("Unexpected subagent service call."));

interface Recorded {
  readonly journal: WorkflowJournalEntry[];
  readonly counted: Array<readonly [number, boolean]>;
  readonly updates: Array<Partial<WorkflowAgentView>>;
  readonly logs: string[];
  readonly results: WorkflowResultLine[];
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
  const recorded: Recorded = { journal: [], counted: [], updates: [], logs: [], results: [] };
  const services: WorkflowAgentServices = {
    subagents: {
      projection: Effect.succeed({ revision: 0, runs: [] }),
      admissionRevision: Effect.succeed(0),
      waitForAdmissionChange: () => unexpected,
      waitForRevision: () => Effect.never,
      queuedWriterConflict: () => Effect.undefined,
      workspaceBindingStatus: () => Effect.succeed("pending"),
      workspaceDiscardUnchanged: () => Effect.succeed(false),
      startOwned: (_request, owner) => Effect.succeed(admitted(owner)),
      awaitOwned: () => (outcome ? Effect.succeed(outcome) : unexpected),
      ...subagents,
    },
    journal: {
      record: (_runId, entry) => Effect.sync(() => void recorded.journal.push(entry)),
      noteWorkspace: () => Effect.void,
      dropWorkspace: () => Effect.void,
    },
  };
  const call = makeWorkflowAgentCall(
    {
      workflowId: "wf-a-1",
      workflowName: "review",
      host: testHost(),
      replay: undefined,
      slots: makeWorkflowSlots(1),
      budget: makeWorkflowBudget(undefined, {
        subagents: services.subagents,
        warn: (message) => Effect.sync(() => void recorded.logs.push(message)),
        show: () => Effect.void,
      }),
      nextCall: Effect.succeed(1),
      failRun: () => Effect.void,
      queue: (draft) => Effect.succeed(workflowAgentFromDraft(draft, "agent-r1-1")),
      claimSkipped: () => Effect.undefined,
      update: (_runId, change) => Effect.sync(() => void recorded.updates.push(change)),
      forget: () => Effect.void,
      log: (_level, message) => Effect.sync(() => void recorded.logs.push(message)),
      stopRequested: Deferred.makeUnsafe<void>(),
      count: (spend) => Effect.sync(() => void recorded.counted.push([spend.usage.output, false])),
      reuse: (entry) => Effect.sync(() => void recorded.counted.push([entry.outputTokens, true])),
      writeResult: (line) => Effect.sync(() => void recorded.results.push(line)),
      ...run,
    },
    services,
  );
  return { call, recorded };
};

/** A writer conflict that clears once the root writer is released. */
const rootWriterConflict = new SubagentWriterConflictError({
  activeId: "agent-r1-0",
  activeName: "root writer",
  message: "Writer root writer (agent-r1-0) owns the shared cwd exclusively.",
  transient: true,
});

/** The resume journal entry of an earlier `prompt` call, which spent 7 output tokens. */
const entry = (
  prompt: string,
  options: WorkflowAgentOptions,
  result: string,
  workspaceId?: string,
): WorkflowJournalEntry => ({
  key: workflowAgentJournalKey(prompt, options, undefined),
  result,
  outputTokens: 7,
  chars: result.length,
  ...(workspaceId !== undefined && { workspaceId }),
});

const worktreeWriter = { profile: "worker", isolation: "worktree" } as const;

const completed = (text: string): OwnedRunOutcome => ({
  kind: "completed",
  text,
  usage: { ...emptyUsage(), output: 11 },
  toolUses: 0,
});

describe("workflow agent call", () => {
  it.effect("fails the run for a call past its agent limit before reserving a run", () =>
    Effect.gen(function* () {
      const failures: string[] = [];
      const { call } = harness({
        nextCall: Effect.undefined,
        failRun: (message) => Effect.sync(() => void failures.push(message)),
      });
      const error = yield* call(["task", {}]).pipe(Effect.flip);
      expect(error.message).toContain("1000");
      expect(failures).toEqual([error.message]);
    }),
  );

  it.effect("replays an identical earlier result without starting an agent", () =>
    Effect.gen(function* () {
      const cached = entry("task", {}, "cached");
      const { call, recorded } = harness({
        replay: makeWorkflowReplay([cached]),
        nextCall: unexpected,
      });
      // A reused result costs nothing in this run.
      expect(yield* call(["task", { label: "any label" }])).toEqual({
        result: "cached",
        outputTokens: 0,
      });
      expect(recorded.journal).toEqual([cached]);
      expect(recorded.counted).toEqual([[7, true]]);
    }),
  );

  it.effect(
    "returns the final text and journals it with its output tokens, label and worktree",
    () =>
      Effect.gen(function* () {
        const { call, recorded } = harness({}, completed("All good."), {
          projection: Effect.succeed({
            revision: 1,
            runs: [view({ id: "agent-r1-1", workspaceId: "workspace-9" })],
          }),
        });
        expect(yield* call(["task", { ...worktreeWriter, label: "fixer" }])).toEqual({
          result: "All good.",
          outputTokens: 11,
        });
        // A resume names a reused worktree, and its results line, by the journaled label.
        expect(recorded.journal).toEqual([
          expect.objectContaining({
            result: "All good.",
            outputTokens: 11,
            label: "fixer",
            workspaceId: "workspace-9",
          }),
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

  it.effect("gives its permit back while queued, so other agents keep starting", () =>
    Effect.gen(function* () {
      const released = yield* Deferred.make<void>();
      const started: string[] = [];
      const { call, recorded } = harness({}, completed("Done."), {
        startOwned: (request, owner) =>
          request.task === "migrate" && !started.includes("migrate-refused")
            ? Effect.sync(() => void started.push("migrate-refused")).pipe(
                Effect.andThen(Effect.fail(rootWriterConflict)),
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

  it.effect("settles a call whose launch can't resolve and gives its slot back", () =>
    Effect.gen(function* () {
      const host = testHost();
      const { call, recorded } = harness(
        {
          host: {
            ...host,
            resolveAgent: (spec) =>
              spec.task === "unroutable"
                ? Effect.fail(new InvalidSubagentRequestError({ message: "no route" }))
                : host.resolveAgent(spec),
          },
        },
        completed("Done."),
      );
      expect(yield* call(["unroutable", {}])).toEqual({ result: null, outputTokens: 0 });
      expect(recorded.updates.at(-1)).toMatchObject({
        state: "failed",
        reason: "couldn't start: no route",
      });
      // The run has one slot, so the next call runs only if the failed launch released it.
      expect(yield* call(["routable", {}])).toEqual({ result: "Done.", outputTokens: 11 });
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

  it.effect("reuses an integrated writer's result without listing its worktree", () =>
    Effect.gen(function* () {
      const integrated = entry("fix", worktreeWriter, "Fixed.", "workspace-9");
      const reused: Array<string | undefined> = [];
      const { call, recorded } = harness(
        {
          replay: makeWorkflowReplay([integrated]),
          nextCall: unexpected,
          reuse: (counted) => Effect.sync(() => void reused.push(counted.workspaceId)),
        },
        undefined,
        { workspaceBindingStatus: () => Effect.succeed("integrated") },
      );
      expect(yield* call(["fix", worktreeWriter])).toEqual({ result: "Fixed.", outputTokens: 0 });
      expect(reused).toEqual([undefined]);
      // Like the results file, the journal leaves the integrated worktree out, so neither a
      // later resume nor a teardown notice treats it as an unreviewed proposal.
      const { workspaceId: _integrated, ...journaled } = integrated;
      expect(recorded.journal).toEqual([journaled]);
    }),
  );

  it.effect("journals a result taken from the replay even when the run stops meanwhile", () =>
    Effect.gen(function* () {
      const taken = entry("fix", worktreeWriter, "Fixed.", "w-9");
      const reading = yield* Deferred.make<void>();
      const read = yield* Deferred.make<void>();
      const { call, recorded } = harness(
        { replay: makeWorkflowReplay([taken]), nextCall: unexpected },
        undefined,
        {
          // The worktree's binding is read under the workspace lock, which can be held.
          workspaceBindingStatus: () =>
            Deferred.succeed(reading, undefined).pipe(
              Effect.andThen(Deferred.await(read)),
              Effect.as("pending" as const),
            ),
        },
      );
      const fiber = yield* call(["fix", worktreeWriter]).pipe(Effect.forkChild);
      yield* Deferred.await(reading);
      const stop = yield* Fiber.interrupt(fiber).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* Deferred.succeed(read, undefined);
      yield* Fiber.join(stop);
      expect(recorded.journal).toEqual([taken]);
      expect(recorded.counted).toEqual([[7, true]]);
    }),
  );

  describe("writer-aware resume", () => {
    const writer = { profile: "worker" };
    const earlier = [
      entry("implement the fix", writer, "Implemented."),
      entry("run the tests", {}, "Tests failed."),
    ];

    it.effect("runs later calls live once a changed shared-checkout writer runs again", () =>
      Effect.gen(function* () {
        const { call, recorded } = harness(
          { replay: makeWorkflowReplay(earlier) },
          completed("Fresh."),
        );
        yield* call(["implement the fix differently", writer]);
        expect(yield* call(["run the tests", {}])).toEqual({ result: "Fresh.", outputTokens: 11 });
        expect(recorded.counted).toEqual([
          [11, false],
          [11, false],
        ]);
        expect(recorded.logs).toHaveLength(1);
      }),
    );

    it.effect("reuses every result when the writer is unchanged", () =>
      Effect.gen(function* () {
        const { call, recorded } = harness({
          replay: makeWorkflowReplay(earlier),
          nextCall: unexpected,
        });
        yield* call(["implement the fix", writer]);
        expect(yield* call(["run the tests", {}])).toEqual({
          result: "Tests failed.",
          outputTokens: 0,
        });
        expect(recorded.counted).toEqual([
          [7, true],
          [7, true],
        ]);
      }),
    );

    it.effect(
      "keeps reusing results after a writer that claimed a planned agent the user skipped",
      () =>
        Effect.gen(function* () {
          const skippedEntry = {
            runId: "agent-r1-p1",
            phase: "Build",
            label: "implementer",
            skippedAt: 1,
          };
          const { call, recorded } = harness({
            replay: makeWorkflowReplay(earlier),
            nextCall: unexpected,
            claimSkipped: (claim) =>
              Effect.succeed(
                claim.label === skippedEntry.label
                  ? workflowAgentFromDraft(
                      { ...claim, callId: 1, queuedAt: 2 },
                      skippedEntry.runId,
                      skippedEntry,
                    )
                  : undefined,
              ),
          });
          // The writer starts nothing, so it neither reuses its result nor makes later calls live.
          expect(yield* call(["implement the fix", { ...writer, label: "implementer" }])).toEqual({
            result: null,
            outputTokens: 0,
          });
          expect(yield* call(["run the tests", {}])).toEqual({
            result: "Tests failed.",
            outputTokens: 0,
          });
          expect(recorded.counted).toEqual([[7, true]]);
          expect(recorded.results.map((line) => [line.state, line.reused === true])).toEqual([
            ["skipped", false],
            ["completed", true],
          ]);
        }),
    );

    it.effect("keeps reusing results after a worktree writer runs again", () =>
      Effect.gen(function* () {
        const replay = () =>
          makeWorkflowReplay([
            entry("fix it", worktreeWriter, "Fixed.", "workspace-9"),
            entry("run the tests", {}, "Tests passed."),
          ]);
        // A worktree that was discarded, and a changed worktree writer, each rerun the writer.
        for (const prompt of ["fix it", "fix it differently"]) {
          const { call } = harness({ replay: replay() }, completed("Fixed again."), {
            workspaceBindingStatus: () => Effect.succeed("closed"),
          });
          expect(yield* call([prompt, worktreeWriter])).toEqual({
            result: "Fixed again.",
            outputTokens: 11,
          });
          expect(yield* call(["run the tests", {}])).toEqual({
            result: "Tests passed.",
            outputTokens: 0,
          });
        }
      }),
    );

    it.effect(
      "runs later calls live once a writer without isolation can't reuse its worktree",
      () =>
        Effect.gen(function* () {
          // The writer got its worktree from the session's writer mode, which may now be
          // shared-checkout, so its rerun can edit the checkout the later reader reads.
          const replay = makeWorkflowReplay([
            entry("implement the fix", writer, "Implemented.", "workspace-9"),
            entry("run the tests", {}, "Tests failed."),
          ]);
          const { call, recorded } = harness({ replay }, completed("Fresh."), {
            workspaceBindingStatus: () => Effect.succeed("closed"),
          });
          expect(yield* call(["implement the fix", writer])).toEqual({
            result: "Fresh.",
            outputTokens: 11,
          });
          expect(yield* call(["run the tests", {}])).toEqual({
            result: "Fresh.",
            outputTokens: 11,
          });
          expect(recorded.counted).toEqual([
            [11, false],
            [11, false],
          ]);
        }),
    );

    it.effect("decides in issue order, so a later call waits for an earlier writer's turn", () =>
      Effect.gen(function* () {
        const checked = yield* Deferred.make<void>();
        const host = testHost();
        const { call } = harness(
          {
            replay: makeWorkflowReplay(earlier),
            host: {
              ...host,
              // The writer's validation takes a while, as a large schema's would.
              checkAgent: (options) =>
                options.profile === "worker"
                  ? Deferred.await(checked).pipe(Effect.andThen(host.checkAgent(options)))
                  : host.checkAgent(options),
            },
          },
          completed("Fresh."),
        );
        const implement = yield* call(["implement the fix differently", writer]).pipe(
          Effect.forkChild,
        );
        const tests = yield* call(["run the tests", {}]).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        expect(tests.pollUnsafe()).toBeUndefined();
        yield* Deferred.succeed(checked, undefined);
        yield* Fiber.join(implement);
        expect(yield* Fiber.join(tests)).toEqual({ result: "Fresh.", outputTokens: 11 });
      }),
    );
  });

  it.effect("clears a call's waiting reason once it gets its run slot, before its start", () =>
    Effect.gen(function* () {
      const release = yield* Deferred.make<void>();
      const updates: Array<readonly [string, Partial<WorkflowAgentView>]> = [];
      const atStart = new Map<string, Partial<WorkflowAgentView> | undefined>();
      const lastUpdate = (runId: string) => updates.findLast(([id]) => id === runId)?.[1];
      let reserved = 0;
      let awaited = 0;
      const { call } = harness(
        {
          queue: (draft) => Effect.succeed(workflowAgentFromDraft(draft, `agent-r1-${++reserved}`)),
          update: (runId, change) => Effect.sync(() => void updates.push([runId, change])),
        },
        undefined,
        {
          startOwned: (_request, owner) =>
            Effect.sync(() => {
              const runId = owner.runId ?? "";
              atStart.set(runId, lastUpdate(runId));
              return admitted(owner);
            }),
          awaitOwned: () =>
            (++awaited === 1 ? Deferred.await(release) : Effect.void).pipe(
              Effect.as(completed("Done.")),
            ),
        },
      );
      // One run slot: the second call waits for it while the first runs.
      const first = yield* call(["first", {}]).pipe(Effect.forkChild);
      yield* yieldUntil(() => awaited === 1);
      const second = yield* call(["second", {}]).pipe(Effect.forkChild);
      yield* yieldUntil(() => lastUpdate("agent-r1-2")?.waiting?.kind === "slot");
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(first);
      yield* Fiber.join(second);
      expect(atStart.get("agent-r1-2")).toEqual({ waiting: undefined });
    }),
  );

  it.effect("names the writer a queued call waits behind, and whether it is paused", () =>
    Effect.gen(function* () {
      const released = yield* Deferred.make<void>();
      const paused = yield* Deferred.make<void>();
      let blocked = true;
      let projection = { revision: 0, runs: [view({ id: "agent-r1-0", state: "running" })] };
      const { call, recorded } = harness({}, completed("Done."), {
        projection: Effect.sync(() => projection),
        queuedWriterConflict: () => Effect.sync(() => (blocked ? rootWriterConflict : undefined)),
        waitForAdmissionChange: () => Deferred.await(released),
        // Only the pause publishes a newer projection.
        waitForRevision: (after) =>
          after < projection.revision
            ? Effect.void
            : after === 0
              ? Deferred.await(paused)
              : Effect.never,
      });
      const fiber = yield* call(["migrate", { profile: "worker" }]).pipe(Effect.forkChild);
      yield* yieldUntil(() => recorded.updates.some((update) => update.waiting !== undefined));
      expect(recorded.updates.at(-1)).toEqual({
        waiting: { kind: "writer", runId: "agent-r1-0", name: "root writer", paused: false },
      });
      // The user pauses the writer, which then never clears by itself.
      projection = { revision: 1, runs: [view({ id: "agent-r1-0", state: "paused" })] };
      yield* Deferred.succeed(paused, undefined);
      yield* yieldUntil(() => recorded.updates.length > 1);
      expect(recorded.updates.at(-1)).toEqual({
        waiting: { kind: "writer", runId: "agent-r1-0", name: "root writer", paused: true },
      });
      blocked = false;
      yield* Deferred.succeed(released, undefined);
      expect(yield* Fiber.join(fiber)).toEqual({ result: "Done.", outputTokens: 11 });
      expect(
        recorded.updates.filter((update) => "waiting" in update && update.state === undefined),
      ).toEqual([
        { waiting: { kind: "writer", runId: "agent-r1-0", name: "root writer", paused: false } },
        { waiting: { kind: "writer", runId: "agent-r1-0", name: "root writer", paused: true } },
        { waiting: undefined },
      ]);
    }),
  );

  it.effect("resolves null for a failed agent and keeps its spent tokens", () =>
    Effect.gen(function* () {
      const { call, recorded } = harness(
        {},
        {
          kind: "failed",
          reason: "Model refused.",
          usage: { ...emptyUsage(), output: 3 },
          toolUses: 0,
        },
      );
      expect(yield* call(["task", {}])).toEqual({ result: null, outputTokens: 3 });
      expect(recorded.counted).toEqual([[3, false]]);
      expect(recorded.logs.join("\n")).toContain("Model refused.");
    }),
  );

  it.effect("counts what a skipped running agent's subagent shows", () =>
    Effect.gen(function* () {
      const live = { ...emptyUsage(), output: 5, totalTokens: 50 };
      const awaiting = yield* Deferred.make<void>();
      const spends: Array<WorkflowAgentSpend> = [];
      let skip: Deferred.Deferred<void> | undefined;
      const { call, recorded } = harness(
        {
          count: (spend) => Effect.sync(() => void spends.push(spend)),
          queue: (draft, skipped) =>
            Effect.sync(() => {
              skip = skipped;
              return workflowAgentFromDraft(draft, "agent-r1-1");
            }),
        },
        undefined,
        {
          projection: Effect.succeed({
            revision: 1,
            runs: [view({ id: "agent-r1-1", usage: live, toolUses: 3, startedAt: 10 })],
          }),
          awaitOwned: () =>
            Deferred.succeed(awaiting, undefined).pipe(Effect.andThen(Effect.never)),
        },
      );
      const fiber = yield* call(["task", {}]).pipe(Effect.forkChild);
      yield* Deferred.await(awaiting);
      yield* Deferred.succeed(skip!, undefined);
      expect(yield* Fiber.join(fiber)).toEqual({ result: null, outputTokens: 5 });
      expect(spends).toEqual([{ usage: live, toolUses: 3 }]);
      expect(recorded.results).toEqual([
        expect.objectContaining({ state: "skipped", usage: live, toolUses: 3 }),
      ]);
    }),
  );
});
