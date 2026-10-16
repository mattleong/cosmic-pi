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
import type { BackendEvent } from "../src/backend/model.ts";
import type { CodexSandboxPolicy } from "../src/backend/local-codex-protocol.ts";
import type { LocalCliProcessHandle } from "../src/boundary/local-cli-process.ts";
import type { LocalCliWireEvent } from "../src/boundary/local-cli-transport.ts";
import type { SupervisorChannelHandle } from "../src/boundary/supervisor-channel.ts";
import { SupervisorChannelError } from "../src/boundary/supervisor-channel-errors.ts";
import type { SubagentWriteIntent } from "../src/domain/routing.ts";
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

const startedCodex = (
  hasAcceptedReport: SupervisorChannelHandle["hasAcceptedReport"],
  options: {
    readonly writeIntent?: SubagentWriteIntent;
    readonly temporaryDirectory?: string;
  } = {},
) =>
  Effect.gen(function* () {
    const childEvents = yield* Queue.unbounded<LocalCliWireEvent, Cause.Done>();
    const supervisorEvents = yield* Queue.unbounded<SupervisorEvent, Cause.Done>();
    const turnInputs: string[] = [];
    const sandboxPolicies: CodexSandboxPolicy[] = [];
    const ephemeralThreads: boolean[] = [];
    const child: LocalCliProcessHandle = {
      pid: 1,
      ...(options.temporaryDirectory !== undefined && {
        temporaryDirectory: options.temporaryDirectory,
      }),
      events: childEvents,
      // The transport settles its exit receipt before it ends the frame queue.
      awaitExit: Effect.succeed({ exitCode: 0, stderr: "" }),
      acknowledge: () => {},
      terminate: () => Effect.void,
      send: (frame) =>
        Effect.sync(() => {
          if (!("id" in frame) || !("method" in frame)) return;
          if (frame.method === "thread/start") ephemeralThreads.push(frame.params.ephemeral);
          if (frame.method === "turn/start") {
            turnInputs.push(frame.params.input[0].text);
            sandboxPolicies.push(frame.params.sandboxPolicy);
          }
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
    ).spawn(
      backendLaunch({ runId: report.runId, writeIntent: options.writeIntent ?? "read-only" }),
    );
    yield* backend.controls.initialize;
    yield* backend.controls.start("Start", 1);
    expect(yield* Queue.take(backend.events)).toMatchObject({ type: "run_started" });
    return {
      backend,
      childEvents,
      supervisorEvents,
      turnInputs,
      sandboxPolicies,
      ephemeralThreads,
    };
  });

const completeTurn = (
  childEvents: Queue.Queue<LocalCliWireEvent, Cause.Done>,
  status: "completed" | "failed" | "interrupted",
  diagnostic?: string,
) =>
  Queue.offerUnsafe(childEvents, {
    type: "message",
    value: {
      method: "turn/completed",
      params: {
        threadId: "thread",
        turn: {
          id: "turn",
          status,
          ...(diagnostic !== undefined && { error: { message: diagnostic } }),
        },
      },
    },
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
  completeTurn(childEvents, "completed");
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

// A native sub-agent spawned with its parent's context loads the parent thread's rollout.
it.effect("Codex starts a thread whose context native sub-agents can fork", () =>
  Effect.scoped(
    startedCodex(() => Effect.succeed(true)).pipe(
      Effect.map(({ ephemeralThreads }) => expect(ephemeralThreads).toEqual([false])),
    ),
  ),
);

const PRIVATE_TEMPORARY_DIRECTORY = "/agent/subagents/local-cli-v1/codex-run/tmp";

it.effect.each([
  [
    "writer",
    {
      type: "workspaceWrite",
      writableRoots: [PRIVATE_TEMPORARY_DIRECTORY],
      networkAccess: false,
      excludeTmpdirEnvVar: true,
      excludeSlashTmp: true,
    },
  ],
  ["read-only", { type: "readOnly", networkAccess: false }],
] as const)(
  "Codex %s turns, reminders included, never write the shared /tmp or $TMPDIR",
  ([writeIntent, sandboxPolicy]) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { backend, childEvents, sandboxPolicies } = yield* startedCodex(
          () => Effect.succeed(false),
          { writeIntent, temporaryDirectory: PRIVATE_TEMPORARY_DIRECTORY },
        );
        finishTurn(childEvents, "No report yet.");
        expect(yield* Queue.take(backend.events)).toMatchObject({ type: "assistant_message" });
        expect(yield* Queue.take(backend.events)).toEqual({ type: "activity", assignmentEpoch: 1 });
        yield* yieldUntil(() => sandboxPolicies.length === 2);
        expect(sandboxPolicies).toEqual([sandboxPolicy, sandboxPolicy]);
      }),
    ),
);

// Codex reports each thread's own running total; native sub-agents run in threads of their own.
const usageDeltas = (updates: ReadonlyArray<readonly [threadId: string, totalTokens: number]>) =>
  Effect.gen(function* () {
    const { backend, childEvents } = yield* startedCodex(() => Effect.succeed(true));
    const deltas: number[] = [];
    for (const [threadId, totalTokens] of updates) {
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
            threadId,
            turnId: threadId === "thread" ? "turn" : `${threadId}-turn`,
            tokenUsage: { total: usage, last: usage },
          },
        },
      });
      const event = yield* Queue.take(backend.events);
      if (event.type !== "assistant_message") return yield* Effect.die("Missing usage event");
      deltas.push(event.usage.totalTokens);
    }
    return deltas;
  });

it.effect("Codex never recounts usage after a cumulative snapshot regresses", () =>
  Effect.scoped(
    usageDeltas([
      ["thread", 10],
      ["thread", 5],
      ["thread", 10],
      ["thread", 15],
    ]).pipe(Effect.map((deltas) => expect(deltas).toEqual([10, 0, 0, 5]))),
  ),
);

it.effect("Codex counts its native sub-agent threads alongside the main thread", () =>
  Effect.scoped(
    usageDeltas([
      ["thread", 10],
      ["sub-agent", 7],
      ["thread", 15],
      ["sub-agent", 9],
      ["sub-agent", 4],
    ]).pipe(Effect.map((deltas) => expect(deltas).toEqual([10, 7, 5, 2, 0]))),
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

it.effect.each(["completed", "failed"] as const)(
  "Codex preserves an accepted report delayed by backpressure when its turn is %s",
  (status) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { backend, childEvents, supervisorEvents, turnInputs } = yield* startedCodex(
          (epoch) => Effect.succeed(epoch === report.assignmentEpoch),
        );
        for (let index = 0; index < 513; index++)
          Queue.offerUnsafe(supervisorEvents, {
            type: "supervisor_contact",
            assignmentEpoch: 1,
            requestId: `progress-${index}`,
            kind: "progress",
            message: "Working",
          });
        Queue.offerUnsafe(supervisorEvents, { type: "report", ...report });
        yield* yieldUntil(() => Queue.sizeUnsafe(backend.events) >= 512);
        completeTurn(childEvents, status, "Provider failed after report acceptance.");
        // This later native frame proves completion handling finished, independently of
        // whether the supervisor report wins the race into the normalized event queue.
        Queue.offerUnsafe(childEvents, {
          type: "message",
          value: { method: "warning", params: { message: "Completion handled." } },
        });
        const terminal: BackendEvent[] = [];
        let reportReceived = false;
        let completionHandled = false;
        while (!reportReceived || !completionHandled) {
          const event = yield* Queue.take(backend.events);
          backend.acknowledge(event);
          if (event.type === "report") reportReceived = true;
          if (event.type === "warning") completionHandled = true;
          if (event.type === "report" || event.type === "protocol_error") terminal.push(event);
        }
        expect(terminal).toEqual([{ type: "report", ...report }]);
        expect(turnInputs).toEqual(["Start"]);
      }),
    ),
);

it.effect.each([undefined, 2])(
  "Codex retains native failure when the only accepted report epoch is %s",
  (acceptedEpoch) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { backend, childEvents, turnInputs } = yield* startedCodex((epoch) =>
          Effect.succeed(epoch === acceptedEpoch),
        );
        completeTurn(childEvents, "failed", "Provider rejected the turn.");
        expect(yield* Queue.take(backend.events)).toMatchObject({
          type: "protocol_error",
          message: stringContaining("Provider rejected the turn."),
        });
        expect(turnInputs).toEqual(["Start"]);
      }),
    ),
);

it.effect("Codex does not treat an unowned interruption as report completion", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { backend, childEvents } = yield* startedCodex(() => Effect.succeed(true));
      completeTurn(childEvents, "interrupted");
      expect(yield* Queue.take(backend.events)).toMatchObject({
        type: "protocol_error",
        message: stringContaining("without a matching parent interrupt lifecycle"),
      });
    }),
  ),
);

it.effect.each(["completed", "failed"] as const)(
  "Codex keeps a failed report-ownership check distinct from an invalid %s notification",
  (status) =>
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
        completeTurn(childEvents, status);
        expect(yield* Queue.take(backend.events)).toMatchObject({
          type: "protocol_error",
          message: stringContaining("Supervisor channel closed."),
        });
      }),
    ),
);
