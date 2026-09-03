// Explicit test entry-point Layer provision owns the captured logger.
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import type { Scope } from "effect/Scope";
import { provideBuiltLayer } from "pi-cosmic-core";
import { capturedTelemetrySnapshot, makeCapturedLogger } from "pi-cosmic-core/testing";
import type { LocalCliHandle, LocalCliWireEvent } from "../src/boundary/local-cli-transport.ts";
import type { SupervisorChannelHandle } from "../src/boundary/supervisor-channel.ts";
import type { SupervisorEvent } from "../src/supervisor/protocol.ts";
import { makeLocalCliRawEventOwnership } from "../src/backend/local-cli-events.ts";
import { makeLocalCodexBackendDriver } from "../src/backend/local-codex.ts";
import type { BackendEvent, BackendHandle, BackendLaunchRequest } from "../src/backend/model.ts";
import type { SubagentError } from "../src/run/errors.ts";

const rawEvent = (id: number): LocalCliWireEvent => ({
  type: "exit",
  exitCode: 0,
  stderr: `raw-${id}`,
});
const backendEvent = (epoch: number): BackendEvent => ({
  type: "activity",
  assignmentEpoch: epoch,
});
const rawId = (raw: LocalCliWireEvent): string => (raw.type === "exit" ? raw.stderr : "");

const turnStartedFrame = (turnId: string) => ({
  method: "turn/started",
  params: { threadId: "thread-1", turn: { id: turnId, status: "inProgress" } },
});

const codexLaunch: BackendLaunchRequest = {
  runId: "codex-event-driver",
  name: "codex-event-driver",
  closeOnReport: true,
  cwd: process.cwd(),
  context: "fresh",
  writeIntent: "read-only",
  openaiFastMode: false,
  model: "codex-fixture",
  effort: "high",
  activeTools: [],
  projectTrusted: false,
  parentSessionId: "parent-session",
  systemPrompt: "Use the private supervisor report tool.",
};

describe("local CLI raw event ownership", () => {
  it.effect("keeps raw ownership across a delivered offer until acknowledgement", () =>
    Effect.gen(function* () {
      const captured = makeCapturedLogger();
      return yield* Effect.gen(function* () {
        const events = yield* Queue.bounded<BackendEvent, Cause.Done>(4);
        const acknowledged: string[] = [];
        const ownership = makeLocalCliRawEventOwnership(
          events,
          (raw) => void acknowledged.push(rawId(raw)),
        );

        const event = backendEvent(1);
        yield* ownership.offer(event, rawEvent(1));
        expect(acknowledged).toEqual([]);
        expect(yield* Queue.take(events)).toBe(event);
        ownership.acknowledge(event);
        expect(acknowledged).toEqual(["raw-1"]);
        // A second acknowledgement of a released event is inert.
        ownership.acknowledge(event);
        expect(acknowledged).toEqual(["raw-1"]);
        // A successful offer must not log an overflow warning.
        expect(capturedTelemetrySnapshot({ entries: captured.entries })).not.toContain(
          "ingress overflowed",
        );
      }).pipe(provideBuiltLayer(captured.layer));
    }),
  );

  it.effect("logs and acknowledges an event dropped by an ended ingress queue", () =>
    Effect.gen(function* () {
      const captured = makeCapturedLogger();
      return yield* Effect.gen(function* () {
        const events = yield* Queue.bounded<BackendEvent, Cause.Done>(4);
        const acknowledged: string[] = [];
        const ownership = makeLocalCliRawEventOwnership(
          events,
          (raw) => void acknowledged.push(rawId(raw)),
        );

        yield* ownership.offer(backendEvent(1));
        Queue.endUnsafe(events);
        const dropped = backendEvent(2);
        yield* ownership.offer(dropped, rawEvent(2));
        expect(acknowledged).toEqual(["raw-2"]);
        const warnings = capturedTelemetrySnapshot({ entries: captured.entries });
        expect(warnings).toContain("ingress overflowed");
        expect(warnings).toContain("activity");
      }).pipe(provideBuiltLayer(captured.layer));
    }),
  );

  it.effect("logs and acknowledges a blocked offer that is interrupted before delivering", () =>
    Effect.gen(function* () {
      const captured = makeCapturedLogger();
      return yield* Effect.gen(function* () {
        const events = yield* Queue.bounded<BackendEvent, Cause.Done>(1);
        const acknowledged: string[] = [];
        const ownership = makeLocalCliRawEventOwnership(
          events,
          (raw) => void acknowledged.push(rawId(raw)),
        );

        yield* ownership.offer(backendEvent(1));
        // The saturated bounded queue suspends the next offer until it is interrupted.
        const blocked = yield* Effect.forkChild(ownership.offer(backendEvent(2), rawEvent(3)));
        yield* Effect.yieldNow;
        yield* Fiber.interrupt(blocked);
        expect(acknowledged).toEqual(["raw-3"]);
        expect(capturedTelemetrySnapshot({ entries: captured.entries })).toContain(
          "ingress overflowed",
        );
      }).pipe(provideBuiltLayer(captured.layer));
    }),
  );

  it.effect("releases an unoffered raw lazily, only when the release effect runs", () =>
    Effect.gen(function* () {
      const events = yield* Queue.bounded<BackendEvent, Cause.Done>(4);
      const acknowledged: string[] = [];
      const ownership = makeLocalCliRawEventOwnership(
        events,
        (raw) => void acknowledged.push(rawId(raw)),
      );

      const release = ownership.release(rawEvent(7));
      expect(acknowledged).toEqual([]);
      yield* release;
      expect(acknowledged).toEqual(["raw-7"]);
    }),
  );
});

describe("local Codex event driver raw safety", () => {
  const withCodexEventDriver = <A>(
    use: (harness: {
      readonly backend: BackendHandle;
      readonly acknowledged: ReadonlyArray<LocalCliWireEvent>;
      readonly offerRaw: (wire: LocalCliWireEvent) => void;
    }) => Effect.Effect<A, never, Scope>,
  ): Effect.Effect<A, SubagentError> =>
    Effect.scoped(
      Effect.gen(function* () {
        const acknowledged: LocalCliWireEvent[] = [];
        const childEvents = yield* Queue.bounded<LocalCliWireEvent, Cause.Done>(16);
        const supervisorEvents = yield* Queue.bounded<SupervisorEvent, Cause.Done>(16);
        const child: LocalCliHandle = {
          pid: 4242,
          events: childEvents,
          awaitExit: Effect.never,
          send: () => Effect.void,
          acknowledge: (raw) => void acknowledged.push(raw),
          terminate: () => Effect.sync(() => Queue.endUnsafe(childEvents)),
        };
        const supervisor: SupervisorChannelHandle = {
          runId: codexLaunch.runId,
          metadata: {
            runId: codexLaunch.runId,
            host: "127.0.0.1",
            port: 1,
            stateDirectory: "/private/fixture",
            connectionConfigPath: "/private/fixture/connection.json",
            helperPath: "/private/helper.mjs",
            claudeMcp: {
              mcpServers: {
                pi_subagents_supervisor: {
                  type: "stdio" as const,
                  command: process.execPath,
                  args: ["/private/helper.mjs"],
                  env: {},
                },
              },
            },
            codexMcp: {
              serverName: "pi_subagents_supervisor",
              command: process.execPath,
              args: ["/private/helper.mjs"],
              enabledTools: [],
              tomlFragment: "",
            },
          },
          events: supervisorEvents,
          awaitReady: Effect.void,
          setAssignmentEpoch: () => Effect.void,
          hasAcceptedReport: () => Effect.succeed(true),
          acceptedReportForEpoch: () => Effect.sync(() => undefined),
          deliverNotification: () => Effect.void,
          reply: () => Effect.void,
          cancelPending: () => {},
          close: Effect.sync(() => Queue.endUnsafe(supervisorEvents)),
        };
        const backend = yield* makeLocalCodexBackendDriver(
          { preflight: () => Effect.void, spawn: () => Effect.succeed(child) },
          { open: () => Effect.succeed(supervisor) },
        ).spawn(codexLaunch);
        const offerRaw = (wire: LocalCliWireEvent) => {
          Queue.offerUnsafe(childEvents, wire);
        };
        return yield* use({ backend, acknowledged, offerRaw });
      }),
    );

  const take = (backend: BackendHandle) =>
    Queue.take(backend.events).pipe(
      Effect.timeoutOption("5 seconds"),
      Effect.flatMap((event) =>
        Option.isSome(event) ? Effect.succeed(event.value) : Effect.die("fixture event timeout"),
      ),
      Effect.orDie,
    );
  const settle = Effect.sleep("50 millis");

  it.live("releases consumed raws exactly once and keeps owned raws until acknowledgement", () =>
    withCodexEventDriver(({ backend, acknowledged, offerRaw }) =>
      Effect.gen(function* () {
        const rawExit: LocalCliWireEvent = { type: "exit", exitCode: 0, stderr: "raw-exit" };
        const rawTurn1: LocalCliWireEvent = { type: "message", value: turnStartedFrame("turn-1") };
        // Foreign terminal frames are released without owning a normalized event;
        // the first turn/started owns its raw behind the normalized run_started event.
        offerRaw(rawExit);
        offerRaw(rawTurn1);
        const started = yield* take(backend);
        expect(started).toMatchObject({ type: "run_started" });
        expect([...acknowledged]).toEqual([rawExit]);
        backend.acknowledge(started);
        expect([...acknowledged]).toEqual([rawExit, rawTurn1]);
        // A second acknowledgement of the released event is inert.
        backend.acknowledge(started);
        expect([...acknowledged]).toEqual([rawExit, rawTurn1]);

        // A duplicate turn/started for the already-tracked turn is released exactly once.
        offerRaw({ type: "message", value: turnStartedFrame("turn-1") });
        yield* settle;
        expect([...acknowledged]).toEqual([
          rawExit,
          rawTurn1,
          { type: "message", value: turnStartedFrame("turn-1") },
        ]);
        expect(Option.isNone(yield* Queue.poll(backend.events))).toBe(true);
      }),
    ),
  );
});
