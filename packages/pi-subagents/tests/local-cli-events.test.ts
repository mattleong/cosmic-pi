// Explicit test entry-point Layer provision owns the captured logger.
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as EffectScope from "effect/Scope";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import type { Scope } from "effect/Scope";
import { provideBuiltLayer } from "pi-cosmic-core";
import { capturedTelemetrySnapshot, makeCapturedLogger } from "pi-cosmic-core/testing";
import type { LocalCliHandle, LocalCliWireEvent } from "../src/boundary/local-cli-transport.ts";
import { backendSupervisor, supervisorMetadata } from "./fixtures/backend-supervisor.ts";
import type { SupervisorEvent } from "../src/supervisor/protocol.ts";
import { makeLocalCliRawEventOwnership } from "../src/backend/local-cli-events.ts";
import { makeLocalCodexBackendDriver } from "../src/backend/local-codex.ts";
import { makeLocalPiBackendDriver } from "../src/backend/local-pi.ts";
import type { ChildWireEvent } from "../src/boundary/child-process.ts";
import type { BackendEvent, BackendHandle, BackendLaunchRequest } from "../src/backend/model.ts";
import type { SubagentError } from "../src/run/errors.ts";

it.effect("Pi reconciles cumulative charges before settlement without blocking RPC dispatch", () =>
  Effect.gen(function* () {
    const childEvents = yield* Queue.unbounded<ChildWireEvent, Cause.Done>();
    let tokens = 100;
    let closeOnStats = false;
    const driver = makeLocalPiBackendDriver({
      spawn: () =>
        Effect.succeed({
          pid: 4242,
          events: childEvents,
          awaitExit: Effect.never,
          send: (command) =>
            closeOnStats && command.type === "get_session_stats"
              ? Effect.sync(() => Queue.endUnsafe(childEvents))
              : Queue.offer(childEvents, {
                  type: "rpc_message",
                  value: {
                    type: "response",
                    id: command.id,
                    command: command.type,
                    success: true,
                    data:
                      command.type === "get_state"
                        ? { sessionId: "child", thinkingLevel: "high" }
                        : command.type === "get_session_stats"
                          ? {
                              tokens: {
                                input: tokens,
                                output: 0,
                                cacheRead: 0,
                                cacheWrite: 0,
                                total: tokens,
                              },
                              cost: tokens / 100,
                            }
                          : undefined,
                  },
                }).pipe(Effect.asVoid),
          sendContactControl: () => Effect.void,
          terminate: () => Effect.void,
        }),
      reclaimRunState: () => Effect.void,
    });
    const backend = yield* driver.spawn(codexLaunch);
    yield* backend.controls.initialize;
    yield* backend.controls.start("first", 1);
    yield* Queue.offer(childEvents, {
      type: "rpc_message",
      value: {
        type: "message_end",
        message: {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: "Final report" }],
          usage: { input: 999, totalTokens: 999 },
        },
      },
    });
    expect(yield* Queue.take(backend.events)).toMatchObject({
      type: "assistant_message",
      text: "Final report",
      usage: { input: 0, totalTokens: 0 },
    });
    tokens = 110;
    yield* Queue.offer(childEvents, { type: "rpc_message", value: { type: "agent_settled" } });
    expect(yield* Queue.take(backend.events)).toMatchObject({
      type: "usage",
      usage: { input: 10 },
    });
    expect(yield* Queue.take(backend.events)).toMatchObject({
      type: "run_settled",
      assignmentEpoch: 1,
      terminal: { stopReason: "stop", text: "Final report" },
    });
    // An idle cache-warm entry belongs to the retained assignment, not a new assistant message.
    tokens = 115;
    yield* Queue.offer(childEvents, { type: "rpc_message", value: { type: "entry_appended" } });
    expect(yield* Queue.take(backend.events)).toMatchObject({
      type: "usage",
      usage: { input: 5 },
    });
    yield* backend.controls.start("second", 2);
    tokens = 118;
    yield* Queue.offer(childEvents, { type: "rpc_message", value: { type: "compaction_end" } });
    expect(yield* Queue.take(backend.events)).toMatchObject({
      type: "usage",
      usage: { input: 3 },
    });
    yield* Queue.offer(childEvents, { type: "rpc_message", value: { type: "agent_settled" } });
    expect(yield* Queue.take(backend.events)).toMatchObject({
      type: "run_settled",
      assignmentEpoch: 2,
    });
    closeOnStats = true;
    yield* Queue.offer(childEvents, { type: "rpc_message", value: { type: "agent_settled" } });
    expect(yield* Queue.take(backend.events)).toMatchObject({
      type: "run_settled",
      assignmentEpoch: 2,
    });
  }).pipe(Effect.scoped),
);

it.effect(
  "Pi retains delayed process usage across assignments and cancels blocked reads on shutdown",
  () =>
    Effect.gen(function* () {
      const scope = yield* EffectScope.make();
      const childEvents = yield* Queue.unbounded<ChildWireEvent, Cause.Done>();
      const requested = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const blocked = yield* Deferred.make<void>();
      let block = false;
      let tokens = 100;
      let delay = false;
      let prompts = 0;
      const driver = makeLocalPiBackendDriver({
        spawn: () =>
          Effect.succeed({
            pid: 4242,
            events: childEvents,
            awaitExit: Effect.never,
            send: (command) =>
              Effect.gen(function* () {
                if (command.type === "prompt") prompts++;
                const snapshot = tokens;
                if (command.type === "get_session_stats" && block) {
                  yield* Deferred.succeed(blocked, undefined);
                  return yield* Effect.never;
                }
                if (command.type === "get_session_stats" && delay) {
                  delay = false;
                  yield* Deferred.succeed(requested, undefined);
                  yield* Deferred.await(release);
                }
                yield* Queue.offer(childEvents, {
                  type: "rpc_message",
                  value: {
                    type: "response",
                    id: command.id,
                    command: command.type,
                    success: true,
                    data:
                      command.type === "get_state"
                        ? { sessionId: "child", thinkingLevel: "high" }
                        : command.type === "get_session_stats"
                          ? {
                              tokens: {
                                input: snapshot,
                                output: 0,
                                cacheRead: 0,
                                cacheWrite: 0,
                                total: snapshot,
                              },
                              cost: 0,
                            }
                          : undefined,
                  },
                });
              }),
            sendContactControl: () => Effect.void,
            terminate: () => Effect.void,
          }),
        reclaimRunState: () => Effect.void,
      });
      const backend = yield* driver
        .spawn(codexLaunch)
        .pipe(Effect.provideService(EffectScope.Scope, scope));
      yield* backend.controls.initialize;
      yield* backend.controls.start("first", 1);
      tokens = 110;
      delay = true;
      yield* Queue.offer(childEvents, { type: "rpc_message", value: { type: "entry_appended" } });
      yield* Deferred.await(requested);
      const next = yield* backend.controls.start("second", 2).pipe(Effect.forkChild);
      yield* Fiber.join(next);
      expect(prompts).toBe(2);
      yield* Deferred.succeed(release, undefined);
      expect(yield* Queue.take(backend.events)).toMatchObject({
        type: "usage",
        usage: { input: 10 },
      });
      tokens = 120;
      yield* Queue.offer(childEvents, { type: "rpc_message", value: { type: "agent_settled" } });
      expect(yield* Queue.take(backend.events)).toMatchObject({
        type: "usage",
        usage: { input: 10 },
      });
      expect(yield* Queue.take(backend.events)).toMatchObject({
        type: "run_settled",
        assignmentEpoch: 2,
      });
      block = true;
      yield* Queue.offer(childEvents, { type: "rpc_message", value: { type: "entry_appended" } });
      yield* Deferred.await(blocked);
      yield* EffectScope.close(scope, Exit.void);
    }),
);

for (const failure of ["malformed", "rejected", "timeout"] as const)
  it.effect(`Pi refuses work without a valid startup usage baseline: ${failure}`, () =>
    Effect.gen(function* () {
      const scope = yield* EffectScope.make();
      const events = yield* Queue.unbounded<ChildWireEvent, Cause.Done>();
      const requested = yield* Deferred.make<void>();
      const commands: string[] = [];
      let released = false;
      const driver = makeLocalPiBackendDriver({
        spawn: () =>
          Effect.acquireRelease(
            Effect.succeed({
              pid: 42,
              events,
              awaitExit: Effect.never,
              send: (command: import("../src/backend/local-pi-protocol.ts").RpcCommand) =>
                Effect.gen(function* () {
                  commands.push(command.type);
                  if (command.type === "get_session_stats") {
                    yield* Deferred.succeed(requested, undefined);
                    if (failure === "timeout") return;
                  }
                  yield* Queue.offer(events, {
                    type: "rpc_message",
                    value: {
                      type: "response",
                      id: command.id,
                      command: command.type,
                      success: command.type !== "get_session_stats" || failure !== "rejected",
                      data:
                        command.type === "get_state"
                          ? { sessionId: "child", thinkingLevel: "high" }
                          : {},
                    },
                  });
                }),
              sendContactControl: () => Effect.void,
              terminate: () => Effect.void,
            }),
            () =>
              Effect.sync(() => {
                released = true;
              }),
          ),
        reclaimRunState: () => Effect.void,
      });
      const backend = yield* driver
        .spawn(codexLaunch)
        .pipe(Effect.provideService(EffectScope.Scope, scope));
      const initializing = yield* backend.controls.initialize.pipe(Effect.forkChild);
      yield* Deferred.await(requested);
      if (failure === "timeout") yield* TestClock.adjust("10 seconds");
      expect((yield* Fiber.join(initializing).pipe(Effect.exit))._tag).toBe("Failure");
      expect((yield* backend.controls.start("must not run", 1).pipe(Effect.exit))._tag).toBe(
        "Failure",
      );
      expect(commands).not.toContain("prompt");
      yield* EffectScope.close(scope, Exit.void);
      expect(released).toBe(true);
    }),
  );

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

it.effect("Pi keeps RPC and IPC byte owners until normalized consumption or scope release", () =>
  Effect.gen(function* () {
    const scope = yield* EffectScope.make();
    const childEvents = yield* Queue.bounded<ChildWireEvent, Cause.Done>(16);
    const acknowledged: ChildWireEvent[] = [];
    const driver = makeLocalPiBackendDriver({
      spawn: () =>
        Effect.succeed({
          pid: 4242,
          events: childEvents,
          awaitExit: Effect.never,
          send: () => Effect.void,
          sendContactControl: () => Effect.void,
          acknowledge: (raw) => void acknowledged.push(raw),
          terminate: () => Effect.void,
        }),
      reclaimRunState: () => Effect.void,
    });
    const backend = yield* driver
      .spawn(codexLaunch)
      .pipe(Effect.provideService(EffectScope.Scope, scope));
    const rpc: ChildWireEvent = { type: "rpc_message", value: { type: "agent_start" } };
    yield* Queue.offer(childEvents, rpc);
    const started = yield* Queue.take(backend.events);
    expect(started.type).toBe("run_started");
    expect(acknowledged).toEqual([]);
    backend.acknowledge(started);
    backend.acknowledge(started);
    expect(acknowledged).toEqual([rpc]);

    const contact: ChildWireEvent = {
      type: "parent_contact",
      value: {
        channel: "pi-subagents",
        type: "contact_parent",
        kind: "progress",
        requestId: "contact",
        message: "working",
      },
    };
    yield* Queue.offer(childEvents, contact);
    const normalized = yield* Queue.take(backend.events);
    expect(normalized.type).toBe("supervisor_contact");
    expect(acknowledged).toEqual([rpc]);
    yield* EffectScope.close(scope, Exit.void);
    expect(acknowledged).toEqual([rpc, contact]);
    backend.acknowledge(normalized);
    expect(acknowledged).toEqual([rpc, contact]);
  }),
);

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
        const supervisor = backendSupervisor(
          supervisorMetadata(codexLaunch.runId, { enabledTools: [], tomlFragment: "" }),
          supervisorEvents,
          {
            hasAcceptedReport: () => Effect.succeed(true),
            acceptedReportForEpoch: () => Effect.sync(() => undefined),
            close: Effect.sync(() => Queue.endUnsafe(supervisorEvents)),
          },
        );
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
