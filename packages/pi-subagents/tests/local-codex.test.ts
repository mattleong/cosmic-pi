import { expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { yieldUntil } from "pi-cosmic-core/testing";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { makeLocalCodexBackendDriver } from "../src/backend/local-codex.ts";
import type { LocalCliHandle, LocalCliWireEvent } from "../src/boundary/local-cli-transport.ts";
import {
  SupervisorChannelError,
  type SupervisorChannelHandle,
} from "../src/boundary/supervisor-channel.ts";
import type { SupervisorEvent } from "../src/supervisor/protocol.ts";
import {
  backendLaunch,
  backendSupervisor,
  supervisorMetadata,
} from "./fixtures/backend-supervisor.ts";

const report = {
  runId: "codex-terminal",
  assignmentEpoch: 1,
  sequence: 1,
  deliveryId: "accepted",
  text: "Done",
};

/** A Codex backend over a fake app-server, started on its active turn `turn` of `thread`. */
const startedCodex = (hasAcceptedReport: SupervisorChannelHandle["hasAcceptedReport"]) =>
  Effect.gen(function* () {
    const childEvents = yield* Queue.unbounded<LocalCliWireEvent, Cause.Done>();
    const supervisorEvents = yield* Queue.unbounded<SupervisorEvent, Cause.Done>();
    const child: LocalCliHandle = {
      pid: 1,
      events: childEvents,
      awaitExit: Effect.never,
      acknowledge: () => {},
      terminate: () => Effect.void,
      send: (frame) =>
        Effect.sync(() => {
          if (!("id" in frame) || !("method" in frame)) return;
          const result =
            frame.method === "initialize"
              ? {
                  codexHome: "/tmp",
                  platformFamily: "unix",
                  platformOs: "linux",
                  userAgent: "fixture",
                }
              : frame.method === "thread/start"
                ? {
                    model: "fixture",
                    cwd: process.cwd(),
                    serviceTier: null,
                    thread: { id: "thread" },
                  }
                : { turn: { id: "turn", status: "inProgress" } };
          Queue.offerUnsafe(childEvents, { type: "message", value: { id: frame.id, result } });
        }),
    };
    const supervisor = backendSupervisor(
      supervisorMetadata({ tomlFragment: "" }),
      supervisorEvents,
      {
        acceptedReportForEpoch: () => Effect.succeed(report),
        hasAcceptedReport,
      },
    );
    const backend = yield* makeLocalCodexBackendDriver(
      { preflight: () => Effect.void, spawn: () => Effect.succeed(child) },
      { open: () => Effect.succeed(supervisor) },
    ).spawn(backendLaunch({ runId: report.runId }));
    yield* backend.controls.initialize;
    yield* backend.controls.start("Start", 1);
    expect(yield* Queue.take(backend.events)).toMatchObject({ type: "run_started" });
    return { backend, childEvents, supervisorEvents };
  });

it.effect("Codex preserves an accepted report behind a full queue and delayed consumer", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { backend, childEvents, supervisorEvents } = yield* startedCodex(() =>
        Effect.succeed(true),
      );
      for (let index = 0; index < 513; index++)
        Queue.offerUnsafe(supervisorEvents, {
          type: "supervisor_contact",
          assignmentEpoch: 1,
          requestId: `progress-${index}`,
          kind: "progress",
          message: "Working",
        });
      yield* yieldUntil(() => Queue.sizeUnsafe(backend.events) >= 512);
      Queue.endUnsafe(childEvents);
      Queue.endUnsafe(supervisorEvents);
      yield* TestClock.adjust("1200 millis");
      const received = yield* Stream.runCollect(Stream.fromQueue(backend.events));
      expect(received.filter((event) => event.type === "report")).toEqual([
        { type: "report", ...report },
      ]);
    }),
  ),
);

it.effect("Codex keeps a failed report-ownership check distinct from an invalid notification", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { backend, childEvents } = yield* startedCodex(() =>
        Effect.fail(
          new SupervisorChannelError({
            operation: "query report",
            code: "supervisor_closed",
            message: "Supervisor channel closed.",
          }),
        ),
      );
      Queue.offerUnsafe(childEvents, {
        type: "message",
        value: {
          method: "turn/completed",
          params: { threadId: "thread", turn: { id: "turn", status: "completed" } },
        },
      });
      // The run fails closed on the supervisor's cause, not on a misreported protocol frame.
      expect(yield* Queue.take(backend.events)).toMatchObject({
        type: "protocol_error",
        message: expect.stringContaining("Supervisor channel closed."),
      });
    }),
  ),
);
