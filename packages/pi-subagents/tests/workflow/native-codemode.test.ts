// Actual Pi agent loop and native QuickJS; only the owned backend and persistence are fake.
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import type * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import { nodeFilePlatformLayer } from "pi-cosmic-core";
import { fakeNativeReportBackendLayer } from "../run/fixtures/service-harness.ts";
import { step } from "../support/effect-test.ts";
import { workflowSession } from "./fixtures/native-workflow-session.ts";
import {
  deliveredFor,
  finished,
  leaveInWorktree,
  reportTask,
  runningTask,
  runWhere,
  script,
} from "./fixtures/workflow-harness.ts";

const decodeOutput = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const quote = Schema.encodeSync(Schema.fromJsonString(Schema.String));
const output = (text: string) => {
  const line = text.split("\n").find((line) => line.startsWith("WORKFLOW_RESULT "));
  expect(line, text).toBeDefined();
  return decodeOutput(line!.slice("WORKFLOW_RESULT ".length));
};
const print = (expression: string) => `text('WORKFLOW_RESULT ' + JSON.stringify(${expression}));`;
const runId = (text: string) =>
  Schema.decodeUnknownSync(Schema.Struct({ run: Schema.Struct({ id: Schema.String }) }))(
    output(text),
  ).run.id;
const start = (body: string) =>
  `const receipt = await tools.subagent_workflow({action:'start',script:${quote(script(body))}});`;

// Live time is intentional: both the outer script and each workflow have real QuickJS workers.
const nativeTest = <A, E>(
  name: string,
  body: () => Effect.Effect<A, E, Scope.Scope | Layer.Success<typeof nodeFilePlatformLayer>>,
) => it.live(name, () => body().pipe(Effect.provide(nodeFilePlatformLayer)), 15_000);

describe("native codemode workflow runner", () => {
  for (const mode of ["on", "only"] as const)
    nativeTest(`ultracode gates native calls when codemode is ${mode}`, () =>
      Effect.gen(function* () {
        const h = yield* workflowSession({ mode, enabled: false });
        const probe = `
          let rejected = false;
          try { await tools.subagent_workflow({action:'list'}); } catch { rejected = true; }
          ${print("{rejected,discoverable:ALL_TOOLS.some(t=>t.name==='subagent_workflow')}")}
        `;
        expect(output((yield* h.run(probe)).text)).toEqual({ rejected: true, discoverable: false });
        h.controller.setEnabled(true);
        const listed = yield* h.run(`
          const listing = await tools.subagent_workflow({action:'list'});
          ${print("{action:listing.action,runs:listing.runs,saved:listing.saved.workflows}")}
        `);
        expect(listed.isError, listed.text).toBe(false);
        expect(output(listed.text)).toEqual({ action: "list", runs: [], saved: [] });
        h.controller.setEnabled(false);
        // A real prompt crosses before_agent_start, including Pi's restore-window settlement.
        expect(output((yield* h.run(probe)).text)).toEqual({ rejected: true, discoverable: false });
      }),
    );

  nativeTest(
    "chains receipts, status, list and stop without waiting for the background agent",
    () =>
      Effect.gen(function* () {
        const h = yield* workflowSession();
        const started = yield* h.run(`
        ${start('return await agent("Background receipt task");')}
        store('workflow-id', receipt.run.id);
        ${print("receipt")}
      `);
        expect(started.isError, started.text).toBe(false);
        const id = runId(started.text);
        expect(output(started.text)).toMatchObject({
          contract: "pi-subagents/workflow",
          version: 1,
          tool: "subagent_workflow",
          action: "start",
          run: { id, state: "running", source: { kind: "inline" } },
        });
        // The outer script has finished, while the real owned agent still awaits its report.
        yield* runningTask(h.fixture, "Background receipt task");
        expect((yield* h.workflows.status(id)).run.state).toBe("running");
        const chained = yield* h.run(`
        const id = load('workflow-id');
        const first = await tools.subagent_workflow({action:'status',runId:id});
        const repeat = await tools.subagent_workflow({action:'status',runId:first.run.id});
        const listing = await tools.subagent_workflow({action:'list'});
        const selected = listing.runs.find(run => run.id === repeat.run.id);
        const stopped = await tools.subagent_workflow({action:'stop',runId:selected.id});
        ${print("{id:stopped.run.id,first:first.kind,repeat:repeat.kind,sinceMs:repeat.sinceMs,attention:repeat.attention,saved:listing.saved.workflows.map(w=>w.name),state:stopped.run.state,agent:stopped.run.agents[0].state}")}
      `);
        expect(chained.isError, chained.text).toBe(false);
        expect(output(chained.text)).toEqual({
          id,
          first: "view",
          repeat: "unchanged",
          sinceMs: expect.any(Number),
          attention: [],
          saved: [],
          state: "stopped",
          agent: "stopped",
        });
        expect((yield* h.workflows.status(id)).run.state).toBe("stopped");
        expect(h.fixture.workflowNotifications).toEqual([]);
      }),
  );

  nativeTest("rejects domain failures instead of resolving structured successes", () =>
    Effect.gen(function* () {
      const h = yield* workflowSession();
      const invalid = yield* h.run(`
        const requests = [
          {action:'start',script:'return 1;'},
          {action:'start',script:${quote(script("return 1;"))},name:'ambiguous'},
          {action:'start',name:'missing'},
          {action:'status',runId:'missing'},
          {action:'stop',runId:'missing'},
          {action:'start',script:'export const meta = {name:"args",description:"args",args:{type:"number"}}; return args;',args:'not a number'}
        ];
        const results = await Promise.allSettled(requests.map(request => tools.subagent_workflow(request)));
        const listed = await tools.subagent_workflow({action:'list'});
        ${print("{statuses:results.map(r=>r.status),runs:listed.runs}")}
      `);
      expect(invalid.isError, invalid.text).toBe(false);
      expect(output(invalid.text)).toEqual({ statuses: Array(6).fill("rejected"), runs: [] });
      expect(h.fixture.backend.launches).toEqual([]);
    }),
  );

  nativeTest("admits workflow writers and queues overlapping cooperative claims", () =>
    Effect.gen(function* () {
      const h = yield* workflowSession();
      const started = yield* h.run(`
        ${start(`return await parallel([
          () => agent("First writer", {profile:"worker",writes:["src/shared.ts"]}),
          () => agent("Conflicting writer", {profile:"worker",writes:["src/shared.ts"]})
        ]);`)}
        ${print("receipt")}
      `);
      expect(started.isError, started.text).toBe(false);
      const id = runId(started.text);
      yield* runningTask(h.fixture, "First writer");
      yield* runWhere(h.workflows, id, (run) =>
        run.agents.some((agent) => agent.state === "queued" && agent.waiting?.kind === "writer"),
      );
      expect(h.fixture.backend.launches).toHaveLength(1);
      expect(h.fixture.projections.at(-1)?.runs[0]).toMatchObject({
        profile: "worker",
        writeIntent: "writer",
        writeClaims: ["src/shared.ts"],
      });
      yield* reportTask(h.fixture, "First writer", "First edit completed");
      yield* runningTask(h.fixture, "Conflicting writer");
      yield* reportTask(h.fixture, "Conflicting writer", "Second edit completed");
      yield* finished(h.workflows, id);
      const status = yield* h.run(`
        const status = await tools.subagent_workflow({action:'status',runId:${quote(id)}});
        ${print("{state:status.run.state,result:JSON.parse(status.run.result.text)}")}
      `);
      expect(output(status.text)).toEqual({
        state: "completed",
        result: ["First edit completed", "Second edit completed"],
      });
    }),
  );

  nativeTest(
    "retains an isolated writer's proposal for parent review, never auto-integrating it",
    () =>
      Effect.gen(function* () {
        const h = yield* workflowSession({ worktrees: true });
        const started = yield* h.run(`
        ${start('return await agent("Isolated writer", {profile:"worker",isolation:"worktree"});')}
        ${print("receipt")}
      `);
        expect(started.isError, started.text).toBe(false);
        const id = runId(started.text);
        const workspaceId = yield* leaveInWorktree(h.fixture, "Isolated writer", "changed");
        yield* reportTask(h.fixture, "Isolated writer", "Proposal ready for review");
        yield* finished(h.workflows, id);
        const status = yield* h.run(`
        const status = await tools.subagent_workflow({action:'status',runId:${quote(id)}});
        ${print("{state:status.run.state,workspaces:status.run.workspaces,agent:status.run.agents[0]}")}
      `);
        expect(output(status.text)).toMatchObject({
          state: "completed",
          workspaces: [{ workspaceId }],
          agent: { profile: "worker", workspaceId, state: "completed" },
        });
        expect(yield* h.subagents.workspaceBindingStatus(workspaceId)).toBe("pending");
        expect(h.fixture.backend.launches[0]?.writeIntent).toBe("writer");
      }),
  );

  nativeTest("keeps an admitted workflow recoverable after the outer script throws", () =>
    Effect.gen(function* () {
      const h = yield* workflowSession();
      const failed = yield* h.run(`
        ${start('return await agent("Survive outer failure");')}
        store('uncommitted-id', receipt.run.id);
        ${print("receipt")}
        throw new Error('outer script failed after admission');
      `);
      expect(failed.isError).toBe(true);
      const id = runId(failed.text);
      yield* runningTask(h.fixture, "Survive outer failure");
      const recovered = yield* h.run(`
        const listing = await tools.subagent_workflow({action:'list'});
        const run = listing.runs.find(run => run.id === ${quote(id)});
        const status = await tools.subagent_workflow({action:'status',runId:run.id});
        ${print("{id:status.run.id,state:status.run.state,storeCommitted:load('uncommitted-id')!==undefined}")}
      `);
      expect(output(recovered.text)).toEqual({ id, state: "running", storeCommitted: false });
      yield* reportTask(h.fixture, "Survive outer failure", "Still running after failure");
      expect((yield* finished(h.workflows, id)).state).toBe("completed");
    }),
  );

  nativeTest("aborts only the outer native script, not a workflow it already admitted", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const interrupted = yield* Deferred.make<void>();
      const h = yield* workflowSession({ barrier: { entered, interrupted } });
      const outer = yield* h
        .run(`
          ${start('return await agent("Survive native abort");')}
          ${print("receipt")}
          await tools.workflow_fixture_barrier({});
        `)
        .pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      yield* runningTask(h.fixture, "Survive native abort");
      yield* step(() => h.session.abort());
      yield* Deferred.await(interrupted);
      const aborted = yield* Fiber.join(outer);
      expect(aborted.isError).toBe(true);
      const id = runId(aborted.text);
      const recovered = yield* h.run(`
        const listing = await tools.subagent_workflow({action:'list'});
        const status = await tools.subagent_workflow({action:'status',runId:listing.runs[0].id});
        ${print("{id:status.run.id,state:status.run.state}")}
      `);
      expect(output(recovered.text)).toEqual({ id, state: "running" });
      yield* reportTask(h.fixture, "Survive native abort", "Still running after abort");
      expect((yield* finished(h.workflows, id)).state).toBe("completed");
    }),
  );

  nativeTest("recovers an interrupted native stop while session-owned cleanup continues", () =>
    Effect.gen(function* () {
      const releaseGate = yield* Deferred.make<void>();
      const backend = fakeNativeReportBackendLayer({ releaseGate });
      const h = yield* workflowSession({ backend });
      yield* Effect.addFinalizer(() => Deferred.succeed(releaseGate, undefined));
      const started = yield* h.run(`
        ${start('return await agent("Stop cleanup task");')}
        ${print("receipt")}
      `);
      const id = runId(started.text);
      yield* runningTask(h.fixture, "Stop cleanup task");
      const stopping = yield* h
        .run(`await tools.subagent_workflow({action:'stop',runId:${quote(id)}});`)
        .pipe(Effect.forkScoped);
      yield* runWhere(h.workflows, id, (run) => run.state === "stopping");
      yield* step(() => h.session.abort());
      expect((yield* Fiber.join(stopping)).isError).toBe(true);
      expect((yield* h.workflows.status(id)).run.state).toBe("stopping");
      expect(backend.controls[0]?.released()).toBe(0);
      yield* Deferred.succeed(releaseGate, undefined);
      expect((yield* finished(h.workflows, id)).state).toBe("stopped");
      yield* deliveredFor(h.fixture, id);
      const recovered = yield* h.run(`
        const listing = await tools.subagent_workflow({action:'list'});
        const status = await tools.subagent_workflow({action:'status',runId:listing.runs[0].id});
        const stop = await tools.subagent_workflow({action:'stop',runId:status.run.id});
        ${print("{id:stop.run.id,state:stop.run.state,status:status.run.state,endedAt:stop.run.endedAt}")}
      `);
      expect(output(recovered.text)).toEqual({
        id,
        state: "stopped",
        status: "stopped",
        endedAt: expect.any(Number),
      });
      expect(backend.controls[0]?.released()).toBe(1);
      expect(h.fixture.delivered.filter((notice) => notice.runId === id)).toHaveLength(1);
    }),
  );
});
