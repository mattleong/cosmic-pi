import { expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { yieldUntil } from "pi-cosmic-core/testing";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { makeLocalCodexBackendDriver } from "../src/backend/local-codex.ts";
import type { LocalCliHandle, LocalCliWireEvent } from "../src/boundary/local-cli-transport.ts";
import type { SupervisorEvent } from "../src/supervisor/protocol.ts";
import { backendSupervisor, supervisorMetadata } from "./fixtures/backend-supervisor.ts";

it.effect("Codex preserves an accepted report behind a full queue and delayed consumer", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const childEvents = yield* Queue.unbounded<LocalCliWireEvent, Cause.Done>();
      const supervisorEvents = yield* Queue.unbounded<SupervisorEvent, Cause.Done>();
      const report = {
        runId: "codex-terminal",
        assignmentEpoch: 1,
        sequence: 1,
        deliveryId: "accepted",
        text: "Done",
      };
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
        supervisorMetadata(report.runId, { enabledTools: [], tomlFragment: "" }),
        supervisorEvents,
        {
          acceptedReportForEpoch: () => Effect.succeed(report),
          hasAcceptedReport: () => Effect.succeed(true),
          close: Effect.sync(() => Queue.endUnsafe(supervisorEvents)),
        },
      );
      const backend = yield* makeLocalCodexBackendDriver(
        { preflight: () => Effect.void, spawn: () => Effect.succeed(child) },
        { open: () => Effect.succeed(supervisor) },
      ).spawn({
        runId: report.runId,
        name: "fixture",
        closeOnReport: true,
        cwd: process.cwd(),
        context: "fresh",
        writeIntent: "read-only",
        openaiFastMode: false,
        model: "fixture",
        effort: "high",
        activeTools: [],
        projectTrusted: false,
        parentSessionId: "parent",
        systemPrompt: "Report",
      });
      yield* backend.controls.initialize;
      yield* backend.controls.start("Start", 1);
      yield* Queue.take(backend.events);
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
