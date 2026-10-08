// Actual Pi agent loop and native QuickJS over the real owned service with a fake child process.
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import { nodeFilePlatformLayer } from "pi-cosmic-core";
import {
  acknowledgeCompletions,
  localServiceFixture,
  request,
  withService,
} from "../run/fixtures/service-harness.ts";
import { nativeCodemodeSession } from "../support/native-codemode-session.ts";
import { signalAwaitEntry } from "./fixtures/subagent-service-double.ts";

const MARKER = "RECOVERY_MARKER ";
const report = Schema.Struct({ status: Schema.String, text: Schema.optional(Schema.String) });
const decodeMarker = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Union([
      Schema.Struct({ phase: Schema.Literal("consumed"), runId: Schema.String, report }),
      Schema.Struct({ phase: Schema.Literal("after_failure") }),
      Schema.Struct({ phase: Schema.Literal("recovered"), readBack: report, ordinary: report }),
    ]),
  ),
);
/** Every marker the script printed, in output order; other output is ignored. */
const markers = (text: string) =>
  text
    .split("\n")
    .filter((line) => line.startsWith(MARKER))
    .map((line) => decodeMarker(line.slice(MARKER.length)));
const print = (expression: string) =>
  `text(${JSON.stringify(MARKER)} + JSON.stringify(${expression}));`;

// Live time is intentional: the test drives the actual native QuickJS worker, not an LLM.
describe("native scripted report recovery", () => {
  it.live(
    "reads back a report printed before a failed nested call without another notification",
    () => {
      const completionNotified = Deferred.makeUnsafe<void>();
      const fixture = localServiceFixture({
        notify: (notification) => {
          if (notification.type === "completed")
            Deferred.doneUnsafe(completionNotified, Effect.void);
          return acknowledgeCompletions(notification);
        },
      });
      return withService(fixture.layer, function* (service) {
        const run = yield* service.start(request());
        const missingRunId = `${run.id}-never-started`;
        const awaitOwnsReport = yield* Deferred.make<void>();
        const awaitFailures: unknown[] = [];
        const h = yield* nativeCodemodeSession(
          signalAwaitEntry(service, awaitOwnsReport, awaitFailures),
        );
        const script = yield* h
          .run(`
        const awaited = await tools.subagent_await({runIds:[${JSON.stringify(run.id)}],until:'all_finished'});
        ${print("{phase:'consumed',runId:awaited.targets[0].runId,report:awaited.targets[0].report}")}
        await tools.subagent_await({runIds:[${JSON.stringify(missingRunId)}],until:'all_finished'});
        ${print("{phase:'after_failure'}")}
      `)
          .pipe(Effect.forkScoped);
        yield* Deferred.await(awaitOwnsReport);
        fixture.fake.controls[0]!.settle("Report printed before the failure");
        const failed = yield* Fiber.join(script);

        expect(failed.isError, failed.text).toBe(true);
        expect(markers(failed.text)).toEqual([
          {
            phase: "consumed",
            runId: run.id,
            report: { status: "delivered", text: "Report printed before the failure" },
          },
        ]);
        // The nested call reached the service with valid arguments and failed on the missing ID.
        expect(awaitFailures).toEqual([
          expect.objectContaining({
            _tag: "InvalidSubagentRequestError",
            code: "subagent_runs_not_found",
          }),
        ]);

        const recovered = yield* h.run(`
        const runIds = [${JSON.stringify(run.id)}];
        const readBack = await tools.subagent_status({runIds,includeDeliveredReports:true});
        const ordinary = await tools.subagent_status({runIds});
        ${print("{phase:'recovered',readBack:readBack.targets[0].report,ordinary:ordinary.targets[0].report}")}
      `);
        expect(recovered.isError, recovered.text).toBe(false);
        expect(markers(recovered.text)).toEqual([
          {
            phase: "recovered",
            readBack: { status: "read_back", text: "Report printed before the failure" },
            ordinary: { status: "already_delivered" },
          },
        ]);
        // An unclaimed control completion drains through the same outbox. Its batch collects
        // every eligible report, so a stale one for the recovered run could not arrive later.
        const control = yield* service.start(request({ task: "Confirm outbox delivery" }));
        fixture.fake.controls[1]!.settle("Control report");
        yield* Deferred.await(completionNotified);
        expect(
          fixture.notifications.flatMap((notification) =>
            notification.type === "completed" ? notification.runs.map((entry) => entry.id) : [],
          ),
        ).toEqual([control.id]);
      }).pipe(Effect.provide(nodeFilePlatformLayer));
    },
    15_000,
  );
});
