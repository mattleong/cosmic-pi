import { expect, it } from "@effect/vitest";
import type * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { yieldUntil } from "pi-cosmic-core/testing";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import { localCodexBackendDriver } from "../src/backend/local-codex.ts";
import type { LocalCliHandle, LocalCliWireEvent } from "../src/boundary/local-cli-transport.ts";
import type { SupervisorChannelHandle } from "../src/boundary/supervisor-channel.ts";
import { SupervisorChannelError } from "../src/boundary/supervisor-channel-errors.ts";
import type { SupervisorEvent } from "../src/supervisor/protocol.ts";
import {
  backendLaunch,
  backendSupervisor,
  supervisorMetadata,
} from "./fixtures/backend-supervisor.ts";
import { stringContaining } from "./support/matchers.ts";

const report = {
  runId: "codex-terminal",
  assignmentEpoch: 1,
  sequence: 1,
  deliveryId: "accepted",
  text: "Done",
};

const startedCodex = (hasAcceptedReport: SupervisorChannelHandle["hasAcceptedReport"]) =>
  Effect.gen(function* () {
    const childEvents = yield* Queue.unbounded<LocalCliWireEvent, Cause.Done>();
    const supervisorEvents = yield* Queue.unbounded<SupervisorEvent, Cause.Done>();
    const turnInputs: string[] = [];
    const child: LocalCliHandle = {
      pid: 1,
      events: childEvents,
      // The transport settles its exit receipt before it ends the frame queue.
      awaitExit: Effect.succeed({ exitCode: 0, stderr: "" }),
      acknowledge: () => {},
      terminate: () => Effect.void,
      send: (frame) =>
        Effect.sync(() => {
          if (!("id" in frame) || !("method" in frame)) return;
          if (frame.method === "turn/start") turnInputs.push(frame.params.input[0].text);
          const result = Match.value(frame.method).pipe(
            Match.when("initialize", () => ({
              codexHome: "/tmp",
              platformFamily: "unix",
              platformOs: "linux",
              userAgent: "fixture",
            })),
            Match.when("thread/start", () => ({
              model: "fixture",
              cwd: process.cwd(),
              serviceTier: null,
              thread: { id: "thread" },
            })),
            Match.orElse(() => ({ turn: { id: "turn", status: "inProgress" } })),
          );
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
    const backend = yield* localCodexBackendDriver(
      { preflight: () => Effect.void, spawn: () => Effect.succeed(child) },
      { open: () => Effect.succeed(supervisor) },
    ).spawn(backendLaunch({ runId: report.runId }));
    yield* backend.controls.initialize;
    yield* backend.controls.start("Start", 1);
    expect(yield* Queue.take(backend.events)).toMatchObject({ type: "run_started" });
    return { backend, childEvents, supervisorEvents, turnInputs };
  });

const finishTurn = (childEvents: Queue.Queue<LocalCliWireEvent, Cause.Done>, text: string) => {
  Queue.offerUnsafe(childEvents, {
    type: "message",
    value: {
      method: "item/completed",
      params: {
        threadId: "thread",
        turnId: "turn",
        item: { id: `message-${text.length}`, type: "agentMessage", text },
      },
    },
  });
  Queue.offerUnsafe(childEvents, {
    type: "message",
    value: {
      method: "turn/completed",
      params: { threadId: "thread", turn: { id: "turn", status: "completed" } },
    },
  });
};

it.effect("Codex reminds once, then fails with the reminded turn's final text", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { backend, childEvents, turnInputs } = yield* startedCodex(() => Effect.succeed(false));
      finishTurn(childEvents, "Here is my answer, without a report.");
      expect(yield* Queue.take(backend.events)).toMatchObject({ type: "assistant_message" });
      expect(yield* Queue.take(backend.events)).toEqual({ type: "activity", assignmentEpoch: 1 });
      yield* yieldUntil(() => turnInputs.length === 2);
      expect(turnInputs[1]).toContain("supervisor_submit_report");
      finishTurn(childEvents, "Still no report.");
      expect(yield* Queue.take(backend.events)).toMatchObject({ type: "assistant_message" });
      const failure = yield* Queue.take(backend.events);
      if (failure.type !== "protocol_error") return yield* Effect.die("Expected a failure.");
      expect(failure.message).toContain("even after a reminder");
      expect(failure.message).toContain("Still no report.");
      expect(failure.message).not.toContain("Here is my answer");
      return undefined;
    }),
  ),
);

it.effect("Codex completes when the reminded turn submits its report", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let accepted = false;
      const { backend, childEvents, turnInputs } = yield* startedCodex(() =>
        Effect.succeed(accepted),
      );
      finishTurn(childEvents, "Done, but no report yet.");
      expect(yield* Queue.take(backend.events)).toMatchObject({ type: "assistant_message" });
      expect(yield* Queue.take(backend.events)).toEqual({ type: "activity", assignmentEpoch: 1 });
      yield* yieldUntil(() => turnInputs.length === 2);
      accepted = true;
      finishTurn(childEvents, "Report submitted.");
      expect(yield* Queue.take(backend.events)).toMatchObject({ type: "assistant_message" });
      expect(Option.isNone(yield* Queue.poll(backend.events))).toBe(true);
    }),
  ),
);

it.effect("Codex never recounts usage after a cumulative snapshot regresses", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { backend, childEvents } = yield* startedCodex(() => Effect.succeed(true));
      const totals: number[] = [];
      for (const totalTokens of [10, 5, 10, 15]) {
        const usage = {
          inputTokens: totalTokens,
          cachedInputTokens: 0,
          outputTokens: 0,
          reasoningOutputTokens: 0,
          totalTokens,
        };
        Queue.offerUnsafe(childEvents, {
          type: "message",
          value: {
            method: "thread/tokenUsage/updated",
            params: {
              threadId: "thread",
              turnId: "turn",
              tokenUsage: { total: usage, last: usage },
            },
          },
        });
        const event = yield* Queue.take(backend.events);
        if (event.type !== "assistant_message") return yield* Effect.die("Missing usage event");
        totals.push(event.usage.totalTokens);
      }
      expect(totals).toEqual([10, 0, 0, 5]);
      return undefined;
    }),
  ),
);

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
      expect(yield* Queue.take(backend.events)).toMatchObject({
        type: "protocol_error",
        message: stringContaining("Supervisor channel closed."),
      });
    }),
  ),
);
