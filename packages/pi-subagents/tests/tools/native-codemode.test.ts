// Actual Pi agent loop and native QuickJS, with owned service/classifier boundaries only.
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import { nodeFilePlatformLayer } from "pi-cosmic-core";
import { yieldUntil } from "pi-cosmic-core/testing";
import type { StartSubagentRequest } from "../../src/run/model.ts";
import { SubagentNotFoundError } from "../../src/run/errors.ts";
import type { SubagentServiceContract } from "../../src/run/service.ts";
import {
  acknowledgeCompletions,
  localServiceFixture,
  nativeReportServiceFixture,
  request,
  contactParentFrame,
  withService,
} from "../run/fixtures/service-harness.ts";
import { nativeCodemodeSession } from "../support/native-codemode-session.ts";
import { subagentServiceDouble } from "./fixtures/subagent-service-double.ts";
import { view } from "./fixtures/tool-harness.ts";

const decodeOutput = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const output = (text: string) => {
  const line = text.split("\n").find((line) => line.startsWith("WORKFLOW_RESULT "));
  expect(line).toBeDefined();
  return decodeOutput(line!.slice("WORKFLOW_RESULT ".length));
};
const print = (expression: string) => `text('WORKFLOW_RESULT ' + JSON.stringify(${expression}));`;

const capturingService = (requests: StartSubagentRequest[]) =>
  subagentServiceDouble({
    start: (input) =>
      Effect.sync(() => {
        requests.push(input);
        return view({
          id: `workflow-${requests.length}`,
          name: input.name ?? "workflow",
          profile: input.profile,
          state: "running",
          writeIntent: input.writeIntent,
        });
      }),
  });

// Live time is intentional: the test drives the actual native QuickJS worker, not an LLM.
describe("native scripted subagent workflows", () => {
  for (const callId of [undefined, ""]) {
    it.live(
      `retains successful launch IDs and refuses scripted writers with ${callId === undefined ? "generated" : "empty"} caller ID`,
      () =>
        Effect.gen(function* () {
          const requests: StartSubagentRequest[] = [];
          const service = capturingService(requests);
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
              { index: 1, status: "started", runId: "workflow-1", name: "entry-scout" },
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
        }).pipe(Effect.provide(nodeFilePlatformLayer)),
      15_000,
    );

    it.live(
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
            "subagent_models",
            "subagent_list",
            "subagent_send",
            "subagent_rename",
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
        }).pipe(Effect.provide(nodeFilePlatformLayer)),
      15_000,
    );
  }

  for (const callId of [undefined, ""])
    it.live(
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
        }).pipe(Effect.provide(nodeFilePlatformLayer));
      },
      15_000,
    );

  it.live(
    "does not expose nested-Pi coordinator definitions to scripts",
    () =>
      Effect.gen(function* () {
        const h = yield* nativeCodemodeSession(subagentServiceDouble({}), { proxy: true });
        expect(
          h.session.getCallableToolNames().filter((name) => name.startsWith("subagent_")),
        ).toEqual([]);
        expect(h.session.getActiveToolNames()).toContain("subagent_start");
      }).pipe(Effect.provide(nodeFilePlatformLayer)),
    15_000,
  );

  for (const callId of [undefined, ""]) {
    it.live(
      `hands parent attention back without consumption with ${callId === undefined ? "generated" : "empty"} caller ID`,
      () => {
        const fixture = localServiceFixture({ notify: acknowledgeCompletions });
        return withService(fixture.layer, function* (service) {
          const run = yield* service.start(request());
          const entered = yield* Deferred.make<void>();
          const observed: SubagentServiceContract = {
            ...service,
            withAwaitTerminalObservations: (ids, until, update, use, coverage) =>
              service.withAwaitTerminalObservations(
                ids,
                until,
                (runs, projection) => {
                  Deferred.doneUnsafe(entered, Effect.void);
                  update?.(runs, projection);
                },
                use,
                coverage,
              ),
          };
          const h = yield* nativeCodemodeSession(observed);
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
        }).pipe(Effect.provide(nodeFilePlatformLayer));
      },
      15_000,
    );

    it.live(
      `scripted status hands back attention without consumption with ${callId === undefined ? "generated" : "empty"} caller ID`,
      () =>
        Effect.gen(function* () {
          let consumed = false;
          const observations = [
            {
              run: view({
                id: "question",
                state: "waiting_for_parent",
                question: { requestId: "q", message: "Choose scope", createdAt: 1 },
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
        }).pipe(Effect.provide(nodeFilePlatformLayer)),
      15_000,
    );
  }

  it.live(
    "recovers a report discarded by a successful script without another notification",
    () => {
      const fixture = localServiceFixture({ notify: acknowledgeCompletions });
      return withService(fixture.layer, function* (service) {
        const run = yield* service.start(request());
        const entered = yield* Deferred.make<void>();
        const observed: SubagentServiceContract = {
          ...service,
          withAwaitTerminalObservations: (ids, until, update, use, coverage) =>
            service.withAwaitTerminalObservations(
              ids,
              until,
              (runs, projection) => {
                Deferred.doneUnsafe(entered, Effect.void);
                update?.(runs, projection);
              },
              use,
              coverage,
            ),
        };
        const h = yield* nativeCodemodeSession(observed);
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
      }).pipe(Effect.provide(nodeFilePlatformLayer));
    },
    15_000,
  );

  it.live(
    "cancels only the scripted wait and allows a later wait",
    () =>
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
              : use([
                  { run: view({ id: "run-1", state: "completed", reportStatus: "delivered" }) },
                ]),
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
      }).pipe(Effect.provide(nodeFilePlatformLayer)),
    15_000,
  );
});

describe("profile selection in native sessions", () => {
  for (const classifier of ["reviewer", "throws"] as const)
    it.live(
      `honors supplied profiles and otherwise uses generalist without consulting a classifier that ${classifier === "throws" ? "throws" : "would choose reviewer"}`,
      () =>
        Effect.gen(function* () {
          const requests: StartSubagentRequest[] = [];
          const h = yield* nativeCodemodeSession(capturingService(requests), { classifier });
          const agents = [
            { task: "Map the entry points", profile: "scout" },
            { task: "Assess the finished change for regressions" },
          ];
          const agentsJson = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
            agents,
          );
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
          expect(h.catalogLookups()).toBe(0);
          expect(h.classifierCalls()).toBe(0);
        }).pipe(Effect.provide(nodeFilePlatformLayer)),
      15_000,
    );
});
