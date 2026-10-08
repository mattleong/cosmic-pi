// Actual Pi agent loop and native QuickJS, with owned service boundaries only.
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import type * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import { nodeFilePlatformLayer } from "pi-cosmic-core";
import { yieldUntil } from "pi-cosmic-core/testing";
import type { StartSubagentRequest } from "../../src/run/model.ts";
import { SubagentNotFoundError } from "../../src/run/errors.ts";
import {
  acknowledgeCompletions,
  localServiceFixture,
  nativeReportServiceFixture,
  request,
  contactParentFrame,
  withService,
} from "../run/fixtures/service-harness.ts";
import { nativeCodemodeSession } from "../support/native-codemode-session.ts";
import { signalAwaitEntry, subagentServiceDouble } from "./fixtures/subagent-service-double.ts";
import { startCapturingService, view } from "./fixtures/tool-harness.ts";

const decodeOutput = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const output = (text: string) => {
  const line = text.split("\n").find((line) => line.startsWith("WORKFLOW_RESULT "));
  expect(line).toBeDefined();
  return decodeOutput(line!.slice("WORKFLOW_RESULT ".length));
};
const print = (expression: string) => `text('WORKFLOW_RESULT ' + JSON.stringify(${expression}));`;

/** Live time is intentional: each test drives the actual native QuickJS worker, not an LLM. */
const nativeTest = <A, E>(
  name: string,
  body: () => Effect.Effect<A, E, Scope.Scope | Layer.Success<typeof nodeFilePlatformLayer>>,
) => it.live(name, () => body().pipe(Effect.provide(nodeFilePlatformLayer)), 15_000);

describe("native scripted subagent workflows", () => {
  for (const callId of [undefined, ""]) {
    nativeTest(
      `retains successful launch IDs and refuses scripted writers with ${callId === undefined ? "generated" : "empty"} caller ID`,
      () =>
        Effect.gen(function* () {
          const requests: StartSubagentRequest[] = [];
          const service = startCapturingService(requests);
          const h = yield* nativeCodemodeSession(service);
          const result = yield* h.run(
            `
        const r = await tools.subagent_start({agents:[
          {task:'Implementation belongs to the main agent',profile:'worker'},
          {task:'Map the entry points',profile:'scout',name:'entry-scout'}
        ]});
        ${print("r")}
      `,
            callId,
          );
          expect(result.isError).toBe(false);
          expect(output(result.text), result.text).toMatchObject({
            contract: "pi-subagents/orchestration",
            version: 1,
            outcome: "partial",
            launches: [
              { index: 0, status: "failed", failure: { code: "scripted_writer_not_supported" } },
              { index: 1, status: "started", runId: "agent-1", name: "entry-scout" },
            ],
          });
          expect(requests.map((request) => request.writeIntent)).toEqual(["read-only"]);
          yield* h.call(
            "subagent_start",
            {
              agents: [{ task: "Authorized direct implementation", profile: "worker" }],
            },
            callId,
          );
          expect(requests.at(-1)?.writeIntent).toBe("writer");
        }),
    );

    nativeTest(
      `lists structured runs without consuming reports with ${callId === undefined ? "generated" : "empty"} caller ID`,
      () =>
        Effect.gen(function* () {
          const run = view({
            id: "listed-run",
            state: "completed",
            finalText: "Report reserved for await or status",
            reportStatus: "available",
            reportGeneration: 1,
          });
          const service = subagentServiceDouble({
            list: Effect.succeed([run]),
            consumeCompletions: () => Effect.die("List must not consume reports"),
          });
          const h = yield* nativeCodemodeSession(service);
          const result = yield* h.run(
            `
            const listed = await tools.subagent_list({});
            ${print("{contract:listed.contract,version:listed.version,runs:listed.runs.map(r=>({id:r.runId,parent:r.parentRunId,depth:r.depth,report:r.report}))}")}
          `,
            callId,
          );
          expect(result.isError).toBe(false);
          expect(output(result.text)).toEqual({
            contract: "pi-subagents/orchestration",
            version: 1,
            runs: [{ id: run.id, parent: "root", depth: 1, report: { status: "deferred" } }],
          });
          expect(result.text).not.toContain(run.finalText);
          const direct = yield* h.call("subagent_list", {}, callId);
          expect(direct.isError).toBe(false);
          expect(direct.text).toContain(run.id);
          expect(direct.text).not.toContain(run.finalText);
        }),
    );

    nativeTest(
      `consumes static profile routes without launching runs with ${callId === undefined ? "generated" : "empty"} caller ID`,
      () =>
        Effect.gen(function* () {
          const h = yield* nativeCodemodeSession(subagentServiceDouble({}));
          const result = yield* h.run(
            `
            const routes = await tools.subagent_models({profile:'scout'});
            const profile = routes.profiles[0];
            ${print("{fallback:routes.fallbackProfile,id:profile.id,candidates:profile.candidates.map(c=>({runtime:c.runtime,model:c.model,status:c.status,fast:c.openaiFastMode,close:c.closeOnReport}))}")}
          `,
            callId,
          );
          expect(result.isError).toBe(false);
          expect(output(result.text)).toEqual({
            fallback: "generalist",
            id: "scout",
            candidates: [
              { runtime: "claude", model: "sonnet", status: "eligible", fast: false, close: true },
            ],
          });
          const direct = yield* h.call("subagent_models", { profile: "scout" }, callId);
          expect(direct.isError).toBe(false);
          expect(direct.text).toContain("scout");
        }),
    );

    nativeTest(
      `chains list, rename, and status and handles domain failure with ${callId === undefined ? "generated" : "empty"} caller ID`,
      () =>
        Effect.gen(function* () {
          let run = view({ id: "rename-target", name: "original-name" });
          const service = subagentServiceDouble({
            list: Effect.sync(() => [run]),
            status: () => Effect.sync(() => run),
            rename: (id, name) =>
              id === run.id
                ? Effect.sync(() => {
                    run = { ...run, name };
                    return run;
                  })
                : id === "interrupted"
                  ? Effect.interrupt
                  : Effect.fail(new SubagentNotFoundError({ id, message: "Run not found" })),
          });
          const h = yield* nativeCodemodeSession(service);
          const result = yield* h.run(
            `
            const listed = await tools.subagent_list({});
            const renamed = await tools.subagent_rename({runId:listed.runs[0].runId,name:'entry-map'});
            if (renamed.outcome !== 'succeeded') throw new Error(renamed.failure.code);
            const status = await tools.subagent_status({runIds:[renamed.target.runId]});
            const failed = await tools.subagent_rename({runId:'missing',name:'not-applied'});
            const rejected = await Promise.allSettled([
              tools.subagent_rename({runId:renamed.target.runId,name:''}),
              tools.subagent_rename({runId:'interrupted',name:'not-applied'})
            ]);
            ${print("{requested:renamed.requestedRunId,name:status.targets[0].name,failed:failed.outcome==='failed'?failed.failure.code:'unexpected',validation:rejected[0].status,interruption:rejected[1].status}")}
          `,
            callId,
          );
          expect(result.isError).toBe(false);
          expect(output(result.text)).toEqual({
            requested: run.id,
            name: "entry-map",
            failed: "SubagentNotFoundError",
            validation: "rejected",
            interruption: "rejected",
          });
          const failed = yield* h.call(
            "subagent_rename",
            { runId: "missing", name: "not-applied" },
            callId,
          );
          expect(failed.isError).toBe(true);
          expect(run.name).toBe("entry-map");
        }),
    );

    nativeTest(
      `keeps judgment tools model-only and limits scripted lifecycle to stop with ${callId === undefined ? "generated" : "empty"} caller ID`,
      () =>
        Effect.gen(function* () {
          const service = subagentServiceDouble({
            stop: (id) =>
              id === "missing"
                ? Effect.fail(new SubagentNotFoundError({ id, message: "Run not found" }))
                : Effect.succeed(view({ id, state: "stopped" })),
            interrupt: (id) => Effect.succeed(view({ id, state: "paused" })),
          });
          const h = yield* nativeCodemodeSession(service);
          for (const name of [
            "subagent_send",
            "subagent_reply",
            "subagent_claims",
            "subagent_workspace",
          ])
            expect(h.session.getCallableToolNames()).not.toContain(name);
          expect(h.session.getActiveToolNames()).toEqual(
            expect.arrayContaining(["subagent_reply", "subagent_claims", "subagent_workspace"]),
          );
          const result = yield* h.run(
            `
        const rejected = [];
        for (const action of ['retry','resume','interrupt']) {
          try { await tools.subagent_lifecycle({action,runIds:['run-1']}); }
          catch { rejected.push(action); }
        }
        const stopped = await tools.subagent_lifecycle({action:'stop',runIds:['run-1','missing']});
        ${print("{rejected,stopped}")}
      `,
            callId,
          );
          expect(output(result.text)).toMatchObject({
            rejected: ["retry", "resume", "interrupt"],
            stopped: {
              outcome: "partial",
              results: [
                { requestedRunId: "run-1", status: "succeeded", target: { state: "stopped" } },
                { requestedRunId: "missing", status: "failed" },
              ],
            },
          });
          const direct = yield* h.call(
            "subagent_lifecycle",
            {
              action: "interrupt",
              runIds: ["run-1"],
            },
            callId,
          );
          expect(direct.isError).toBe(false);
        }),
    );
  }

  for (const callId of [undefined, ""])
    nativeTest(
      `carries native ${callId === undefined ? "generated" : "empty"} caller script provenance into authenticated delegation`,
      () => {
        const fixture = nativeReportServiceFixture();
        return withService(fixture.layer, function* (service) {
          const h = yield* nativeCodemodeSession(service);
          const started = yield* h.run(
            `
            const r = await tools.subagent_start({agents:[{task:"Map the entry points",profile:"scout"}]});
            ${print("r")}
          `,
            callId,
          );
          expect(output(started.text)).toMatchObject({ outcome: "started" });
          const parent = (yield* service.list)[0]!;
          expect(
            yield* service
              .startSessionOwnedFrom(parent.id, request({ writeIntent: "writer" }))
              .pipe(Effect.flip),
          ).toMatchObject({ code: "scripted_subtree_writer_not_supported" });
          expect(yield* service.list).toHaveLength(1);
          const direct = yield* h.call(
            "subagent_start",
            {
              agents: [{ task: "Separately authorized implementation", profile: "worker" }],
            },
            callId,
          );
          expect(direct.isError).toBe(false);
          expect((yield* service.list).filter((run) => run.writeIntent === "writer")).toHaveLength(
            1,
          );
        });
      },
    );

  nativeTest("does not expose nested-Pi coordinator definitions to scripts", () =>
    Effect.gen(function* () {
      const h = yield* nativeCodemodeSession(subagentServiceDouble({}), { proxy: true });
      expect(
        h.session.getCallableToolNames().filter((name) => name.startsWith("subagent_")),
      ).toEqual([]);
      expect(h.session.getActiveToolNames()).toContain("subagent_start");
    }),
  );

  for (const callId of [undefined, ""]) {
    nativeTest(
      `hands parent attention back without consumption with ${callId === undefined ? "generated" : "empty"} caller ID`,
      () => {
        const fixture = localServiceFixture({ notify: acknowledgeCompletions });
        return withService(fixture.layer, function* (service) {
          const run = yield* service.start(request());
          const entered = yield* Deferred.make<void>();
          const h = yield* nativeCodemodeSession(signalAwaitEntry(service, entered));
          const script = yield* h
            .run(
              `await tools.subagent_await({runIds:[${JSON.stringify(run.id)}],until:'all_finished'});`,
              callId,
            )
            .pipe(Effect.forkScoped);
          yield* Deferred.await(entered);
          fixture.fake.controls[0]!.offerIpc(
            contactParentFrame("question-1", "question", "Choose the next scope"),
          );
          const result = yield* Fiber.join(script);
          expect(result.isError).toBe(true);
          yield* yieldUntil(() =>
            fixture.notifications.some((notification) => notification.type === "question"),
          );
          const direct = yield* h.call(
            "subagent_await",
            { runIds: [run.id], until: "all_finished" },
            callId,
          );
          expect(direct.isError).toBe(false);
          expect(direct.text).toContain("Choose the next scope");
        });
      },
    );

    nativeTest(
      `scripted status hands back attention without consumption with ${callId === undefined ? "generated" : "empty"} caller ID`,
      () =>
        Effect.gen(function* () {
          let consumed = false;
          const observations = [
            {
              run: view({
                id: "question",
                state: "waiting_for_parent",
                question: { requestId: "q", message: "Choose scope" },
              }),
            },
            {
              run: view({
                id: "done",
                state: "completed",
                finalText: "Status report",
                reportStatus: "available",
                reportGeneration: 1,
              }),
              completionReceipt: { id: "done", generation: 1, claimToken: "claim" },
            },
          ];
          const service = subagentServiceDouble({
            withStatusObservations: (_ids, use) => use({ observations, missingIds: [] }),
            consumeCompletions: () =>
              Effect.sync(() => {
                consumed = true;
              }),
          });
          const h = yield* nativeCodemodeSession(service);
          expect(
            (yield* h.run('await tools.subagent_status({runIds:["question","done"]});', callId))
              .isError,
          ).toBe(true);
          expect(consumed).toBe(false);
          const direct = yield* h.call("subagent_status", { runIds: ["question", "done"] }, callId);
          expect(direct.isError).toBe(false);
          expect(direct.text).toContain("Status report");
          expect(consumed).toBe(true);
        }),
    );
  }

  nativeTest(
    "recovers a report discarded by a successful script without another notification",
    () => {
      const fixture = localServiceFixture({ notify: acknowledgeCompletions });
      return withService(fixture.layer, function* (service) {
        const run = yield* service.start(request());
        const entered = yield* Deferred.make<void>();
        const h = yield* nativeCodemodeSession(signalAwaitEntry(service, entered));
        const script = yield* h
          .run(`
        await tools.subagent_await({runIds:[${JSON.stringify(run.id)}],until:'all_finished'});
        ${print("{discarded:true}")}
      `)
          .pipe(Effect.forkScoped);
        yield* Deferred.await(entered);
        fixture.fake.controls[0]!.settle("Recoverable workflow report");
        expect(output((yield* Fiber.join(script)).text)).toEqual({ discarded: true });
        const result = yield* h.run(`
        const status = await tools.subagent_status({runIds:[${JSON.stringify(run.id)}],includeDeliveredReports:true});
        ${print("status.targets[0].report")}
      `);
        expect(output(result.text)).toEqual({
          status: "read_back",
          text: "Recoverable workflow report",
        });
        const ordinary = yield* h.call("subagent_status", { runIds: [run.id] });
        expect(ordinary.text).not.toContain("Recoverable workflow report");
        expect(
          fixture.notifications.filter((notification) => notification.type === "completed"),
        ).toEqual([]);
      });
    },
  );

  nativeTest("cancels only the scripted wait and allows a later wait", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      let interrupted = false;
      let wait = true;
      const service = subagentServiceDouble({
        withAwaitTerminalObservations: (_ids, _until, _update, use) =>
          wait
            ? Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.onInterrupt(() =>
                  Effect.sync(() => {
                    interrupted = true;
                  }),
                ),
              )
            : use([{ run: view({ id: "run-1", state: "completed", reportStatus: "delivered" }) }]),
      });
      const h = yield* nativeCodemodeSession(service);
      const script = yield* h
        .run("await tools.subagent_await({runIds:['run-1'],until:'all_finished'});")
        .pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      yield* Effect.promise(() => h.session.abort());
      yield* Fiber.join(script);
      expect(interrupted).toBe(true);
      wait = false;
      const result = yield* h.run(
        `const r=await tools.subagent_await({runIds:['run-1'],until:'all_finished'});${print("r.outcome")}`,
      );
      expect(output(result.text)).toBe("finished");
    }),
  );
});

describe("profile selection in native sessions", () => {
  nativeTest("honors supplied profiles and otherwise uses generalist", () =>
    Effect.gen(function* () {
      const requests: StartSubagentRequest[] = [];
      const h = yield* nativeCodemodeSession(startCapturingService(requests));
      const agents = [
        { task: "Map the entry points", profile: "scout" },
        { task: "Assess the finished change for regressions" },
      ];
      const agentsJson = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(agents);
      const scripted = yield* h.run(`
            const r = await tools.subagent_start({agents:${agentsJson}});
            ${print("r")}
          `);
      expect(scripted.isError).toBe(false);
      expect(output(scripted.text)).toMatchObject({
        contract: "pi-subagents/orchestration",
        version: 1,
        outcome: "started",
        launches: [
          { status: "started", profile: "scout" },
          { status: "started", profile: "generalist" },
        ],
      });
      const direct = yield* h.call("subagent_start", { agents });
      expect(direct.isError).toBe(false);
      expect(requests.map((request) => [request.profile, request.writeIntent])).toEqual([
        ["scout", "read-only"],
        ["generalist", "read-only"],
        ["scout", "read-only"],
        ["generalist", "read-only"],
      ]);
    }),
  );
});
