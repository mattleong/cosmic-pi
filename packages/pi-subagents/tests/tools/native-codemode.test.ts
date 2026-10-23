import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Fn from "effect/Function";
import type * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import { nodeFilePlatformLayer } from "pi-cosmic-core";
import { yieldUntil } from "pi-cosmic-core/testing";
import type { StartSubagentRequest } from "../../src/run/model.ts";
import { SubagentNotFoundError } from "../../src/run/errors.ts";
import {
  acknowledgeCompletions,
  contactParentFrame,
  localServiceFixture,
  nativeReportServiceFixture,
  request,
  runViews,
  withService,
} from "../run/fixtures/service-harness.ts";
import { stringContaining } from "../support/matchers.ts";
import { nativeCodemodeSession } from "../support/native-codemode-session.ts";
import { signalAwaitEntry, subagentServiceDouble } from "./fixtures/subagent-service-double.ts";
import { startCapturingService, view } from "./fixtures/tool-harness.ts";
import * as Str from "effect/String";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";

const decodeOutput = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const output = (text: string) => {
  const line = Option.getOrUndefined(
    Arr.findFirst(Str.split(text, "\n"), (entry) =>
      Fn.pipe(entry, Str.startsWith("WORKFLOW_RESULT ")),
    ),
  );
  expect(line).toBeDefined();
  return decodeOutput(Fn.pipe(line!, Str.slice("WORKFLOW_RESULT ".length)));
};
const print = (expression: string) => `text('WORKFLOW_RESULT ' + JSON.stringify(${expression}));`;

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
        const r = await tools.agent_start({agents:[
          {task:'Implementation belongs to the main agent',profile:'worker'},
          {task:'Map the entry points',profile:'scout',name:'entry-scout'}
        ]});
        ${print("r")}
      `,
            callId,
          );
          expect(result.isError).toBe(false);
          expect(output(result.text), result.text).toMatchObject({
            tool: "agent_start",
            outcome: "partial",
            launches: [
              { index: 0, status: "failed", failure: { code: "scripted_writer_not_supported" } },
              { index: 1, status: "started", runId: "agent-1", name: "entry-scout" },
            ],
          });
          expect(Arr.map(requests, (started) => started.writeIntent)).toEqual(["read-only"]);
          yield* h.call(
            "agent_start",
            {
              agents: [{ task: "Authorized direct implementation", profile: "worker" }],
            },
            callId,
          );
          expect(requests.at(-1)?.writeIntent).toBe("writer");
        }),
    );

    nativeTest(
      `keeps judgment tools model-only and limits scripted lifecycle to stop with ${callId === undefined ? "generated" : "empty"} caller ID`,
      () =>
        Effect.gen(function* () {
          const service = subagentServiceDouble({
            stop: (id) =>
              id === "missing"
                ? Effect.fail(SubagentNotFoundError.make({ id, message: "Run not found" }))
                : Effect.succeed(view({ id, state: "stopped" })),
            interrupt: (id) => Effect.succeed(view({ id, state: "paused" })),
          });
          const h = yield* nativeCodemodeSession(service);
          for (const name of ["agent_send", "agent_worktree"])
            expect(h.session.getCallableToolNames()).not.toContain(name);
          expect(h.session.getActiveToolNames()).toContain("agent_send");
          // Scripts reach agent_profiles, which the root declares only once tool search loads it.
          expect(h.session.getCallableToolNames()).toContain("agent_profiles");
          expect(h.session.getActiveToolNames()).not.toContain("agent_profiles");
          const result = yield* h.run(
            `
        const rejected = [];
        for (const action of ['resume','interrupt']) {
          try { await tools.agent_lifecycle({action,runIds:['run-1']}); }
          catch { rejected.push(action); }
        }
        const stopped = await tools.agent_lifecycle({action:'stop',runIds:['run-1','missing']});
        ${print("{rejected,stopped}")}
      `,
            callId,
          );
          expect(output(result.text)).toMatchObject({
            rejected: ["resume", "interrupt"],
            stopped: {
              outcome: "partial",
              results: [
                { requestedRunId: "run-1", status: "succeeded", target: { state: "stopped" } },
                { requestedRunId: "missing", status: "failed" },
              ],
            },
          });
          const direct = yield* h.call(
            "agent_lifecycle",
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
            const r = await tools.agent_start({agents:[{task:"Map the entry points",profile:"scout"}]});
            ${print("r")}
          `,
            callId,
          );
          expect(output(started.text)).toMatchObject({ outcome: "started" });
          const parent = (yield* runViews(service))[0]!;
          expect(
            yield* service
              .startSessionOwnedFrom(parent.id, request({ writeIntent: "writer" }))
              .pipe(Effect.flip),
          ).toMatchObject({ code: "scripted_subtree_writer_not_supported" });
          expect(yield* runViews(service)).toHaveLength(1);
          const direct = yield* h.call(
            "agent_start",
            {
              agents: [{ task: "Separately authorized implementation", profile: "worker" }],
            },
            callId,
          );
          expect(direct.isError).toBe(false);
          expect(
            Arr.filter(yield* runViews(service), (run) => run.writeIntent === "writer"),
          ).toHaveLength(1);
        });
      },
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
              `await tools.agent_await({runIds:[${JSON.stringify(run.id)}],until:'all_finished'});`,
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
            Arr.some(fixture.notifications, (notification) => notification.type === "question"),
          );
          const direct = yield* h.call(
            "agent_await",
            { runIds: [run.id], until: "all_finished" },
            callId,
          );
          expect(direct.isError).toBe(false);
          expect(direct.text).toContain("Choose the next scope");
        });
      },
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
        await tools.agent_await({runIds:[${JSON.stringify(run.id)}],until:'all_finished'});
        ${print("{discarded:true}")}
      `)
          .pipe(Effect.forkScoped);
        yield* Deferred.await(entered);
        fixture.fake.controls[0]!.settle("Recoverable workflow report");
        expect(output((yield* Fiber.join(script)).text)).toEqual({ discarded: true });
        const result = yield* h.run(`
        const read = await tools.agent_read({agentIds:[${JSON.stringify(run.id)}]});
        ${print("{text:read.agents[0].text}")}
      `);
        expect(output(result.text)).toEqual({
          text: stringContaining("Recoverable workflow report"),
        });
        expect(
          Arr.filter(fixture.notifications, (notification) => notification.type === "completed"),
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
        .run("await tools.agent_await({runIds:['run-1'],until:'all_finished'});")
        .pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      yield* Effect.promise(() => h.session.abort());
      yield* Fiber.join(script);
      expect(interrupted).toBe(true);
      wait = false;
      const result = yield* h.run(
        `const r=await tools.agent_await({runIds:['run-1'],until:'all_finished'});${print("r.outcome")}`,
      );
      expect(output(result.text)).toBe("finished");
    }),
  );

  // Pi's codemode description lists an object result's field names but renders any other output
  // schema, such as a union, in full on every request.
  nativeTest("declares every script result as one object", () =>
    Effect.gen(function* () {
      const h = yield* nativeCodemodeSession(subagentServiceDouble({}));
      const agentTools = Arr.filter(h.session.getAllTools(), (tool) =>
        Fn.pipe(tool.name, Str.startsWith("agent_")),
      );
      const schemas = Arr.flatMap(agentTools, (tool) => {
        const schema = h.session.getToolDefinition(tool.name)?.outputSchema;
        return schema === undefined ? [] : [[tool.name, schema] as const];
      });
      expect(Arr.map(schemas, ([name]) => name)).toContain("agent_await");
      for (const [name, schema] of schemas) expect(schema, name).toMatchObject({ type: "object" });
    }),
  );
});
