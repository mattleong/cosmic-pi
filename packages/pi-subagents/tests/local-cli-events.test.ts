import { describe, expect, it } from "@effect/vitest";
import type * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as EffectScope from "effect/Scope";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import type { Scope } from "effect/Scope";

import {
  capturedTelemetrySnapshot,
  makeCapturedLogger,
  yieldUntil,
  provideBuiltLayer,
} from "pi-cosmic-core/testing";
import type { LocalCliWireEvent } from "../src/boundary/local-cli-transport.ts";
import { backendLaunch } from "./fixtures/backend-supervisor.ts";
import {
  localCliEventIngress,
  makeLocalCliRawEventOwnership,
  type LocalCliRawEventOwnership,
} from "../src/backend/local-cli-events.ts";
import { localPiBackendDriver } from "../src/backend/local-pi.ts";
import type { RpcCommand } from "../src/backend/local-pi-protocol.ts";
import type { ChildProcessHandle, ChildWireEvent } from "../src/boundary/child-process.ts";
import type { ProcessExit } from "../src/boundary/process-transport.ts";
import type { BackendEvent } from "../src/backend/model.ts";

const sessionStats = (tokens: number | undefined, cost: number | undefined) =>
  tokens === undefined
    ? {}
    : {
        tokens: { input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, total: tokens },
        cost: cost ?? 0,
      };

const rpcResponse = (
  command: RpcCommand,
  options: { readonly tokens?: number; readonly cost?: number; readonly success?: boolean } = {},
): ChildWireEvent => ({
  type: "rpc_message",
  value: {
    type: "response",
    ...(command.id !== undefined && { id: command.id }),
    command: command.type,
    success: options.success ?? true,
    ...(command.type === "prompt" && { data: { disposition: "started" } }),
    ...(command.type === "get_state" && {
      data: { sessionId: "child", thinkingLevel: "high" },
    }),
    ...(command.type === "get_session_stats" && {
      data: sessionStats(options.tokens, options.cost),
    }),
  },
});

const piChild = (
  events: ChildProcessHandle["events"],
  overrides: Partial<ChildProcessHandle> = {},
): ChildProcessHandle => ({
  pid: 4242,
  events,
  awaitExit: Effect.never,
  send: () => Effect.void,
  acknowledge: () => {},
  sendContactControl: () => Effect.void,
  terminate: () => Effect.void,
  ...overrides,
});

const spawnPi = (child: Effect.Effect<ChildProcessHandle, never, Scope>) =>
  localPiBackendDriver({ spawn: () => child, reclaimRunState: () => Effect.void }).spawn(
    backendLaunch(),
  );

it.effect("Pi reconciles cumulative charges before settlement without blocking RPC dispatch", () =>
  Effect.gen(function* () {
    const childEvents = yield* Queue.unbounded<ChildWireEvent, Cause.Done>();
    const exited = yield* Deferred.make<ProcessExit>();
    let tokens = 100;
    let closeOnStats = false;
    const backend = yield* spawnPi(
      Effect.succeed(
        piChild(childEvents, {
          awaitExit: Deferred.await(exited),
          send: (command) =>
            closeOnStats && command.type === "get_session_stats"
              ? Effect.sync(() => {
                  Queue.endUnsafe(childEvents);
                  Deferred.doneUnsafe(exited, Effect.succeed({ exitCode: 0, stderr: "" }));
                })
              : Queue.offer(childEvents, rpcResponse(command, { tokens, cost: tokens / 100 })).pipe(
                  Effect.asVoid,
                ),
        }),
      ),
    );
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
      const send: ChildProcessHandle["send"] = (command) =>
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
          yield* Queue.offer(childEvents, rpcResponse(command, { tokens: snapshot }));
          return undefined;
        });
      const backend = yield* spawnPi(Effect.succeed(piChild(childEvents, { send }))).pipe(
        Effect.provideService(EffectScope.Scope, scope),
      );
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
      const send: ChildProcessHandle["send"] = (command) =>
        Effect.gen(function* () {
          commands.push(command.type);
          if (command.type === "get_session_stats") {
            yield* Deferred.succeed(requested, undefined);
            if (failure === "timeout") return;
          }
          const success = command.type !== "get_session_stats" || failure !== "rejected";
          yield* Queue.offer(events, rpcResponse(command, { success }));
        });
      const backend = yield* spawnPi(
        Effect.acquireRelease(Effect.succeed(piChild(events, { send })), () =>
          Effect.sync(() => {
            released = true;
          }),
        ),
      ).pipe(Effect.provideService(EffectScope.Scope, scope));
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
  type: "protocol_error",
  message: `raw-${id}`,
});
const backendEvent = (epoch: number): BackendEvent => ({
  type: "activity",
  assignmentEpoch: epoch,
});
const rawId = (raw: LocalCliWireEvent): string =>
  raw.type === "protocol_error" ? raw.message : "";

it.effect("Pi keeps RPC and IPC byte owners until normalized consumption or scope release", () =>
  Effect.gen(function* () {
    const scope = yield* EffectScope.make();
    const childEvents = yield* Queue.bounded<ChildWireEvent, Cause.Done>(16);
    const acknowledged: ChildWireEvent[] = [];
    const backend = yield* spawnPi(
      Effect.succeed(piChild(childEvents, { acknowledge: (raw) => void acknowledged.push(raw) })),
    ).pipe(Effect.provideService(EffectScope.Scope, scope));
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
        type: "contact_request",
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

const withOwnership = <A, E>(
  capacity: number,
  use: (harness: {
    readonly events: Queue.Queue<BackendEvent, Cause.Done>;
    readonly acknowledged: ReadonlyArray<string>;
    readonly ownership: LocalCliRawEventOwnership;
    readonly warnings: () => string;
  }) => Effect.Effect<A, E>,
) =>
  Effect.suspend(() => {
    const captured = makeCapturedLogger();
    return Effect.gen(function* () {
      const events = yield* Queue.bounded<BackendEvent, Cause.Done>(capacity);
      const acknowledged: string[] = [];
      const ownership = makeLocalCliRawEventOwnership(
        events,
        (raw) => void acknowledged.push(rawId(raw)),
      );
      const warnings = () => capturedTelemetrySnapshot({ entries: captured.entries });
      return yield* use({ events, acknowledged, ownership, warnings });
    }).pipe(provideBuiltLayer(captured.layer));
  });

describe("local CLI raw event ownership", () => {
  it.effect("keeps raw ownership across a delivered offer until acknowledgement", () =>
    withOwnership(4, ({ events, acknowledged, ownership, warnings }) =>
      Effect.gen(function* () {
        const event = backendEvent(1);
        yield* ownership.offer(event, rawEvent(1));
        expect(acknowledged).toEqual([]);
        expect(yield* Queue.take(events)).toBe(event);
        ownership.acknowledge(event);
        expect(acknowledged).toEqual(["raw-1"]);
        ownership.acknowledge(event);
        expect(acknowledged).toEqual(["raw-1"]);
        expect(warnings()).not.toContain("ingress overflowed");
      }),
    ),
  );

  it.effect("logs and acknowledges a blocked offer that is interrupted before delivering", () =>
    withOwnership(1, ({ acknowledged, ownership, warnings }) =>
      Effect.gen(function* () {
        yield* ownership.offer(backendEvent(1));
        const blocked = yield* Effect.forkChild(ownership.offer(backendEvent(2), rawEvent(3)));
        yield* Effect.yieldNow;
        yield* Fiber.interrupt(blocked);
        expect(acknowledged).toEqual(["raw-3"]);
        expect(warnings()).toContain("ingress overflowed");
      }),
    ),
  );

  it.effect("coalesces an activity burst behind a stalled consumer without reordering", () =>
    Effect.gen(function* () {
      const acknowledged: string[] = [];
      const ingress = yield* localCliEventIngress((raw) => void acknowledged.push(rawId(raw)));
      let offered = false;
      yield* Effect.forEach(
        Array.from({ length: 10_000 }, (_, id) => id),
        (id) => ingress.offer(backendEvent(1), rawEvent(id)),
        { discard: true },
      ).pipe(
        Effect.andThen(
          Effect.sync(() => {
            offered = true;
          }),
        ),
        Effect.forkChild,
      );
      yield* yieldUntil(() => offered, 1_000);
      expect(acknowledged).toHaveLength(9_999);
      expect(acknowledged).not.toContain("raw-0");

      const finished: BackendEvent = {
        type: "tool_finished",
        assignmentEpoch: 1,
        toolCallId: "call",
        toolName: "edit",
        isError: false,
      };
      yield* ingress.offer(finished, rawEvent(10_000));
      const pending = yield* Queue.take(ingress.events);
      expect(pending.type).toBe("activity");
      expect(yield* Queue.take(ingress.events)).toBe(finished);
      ingress.acknowledge(pending);
      expect(acknowledged).toContain("raw-0");

      const next = backendEvent(1);
      yield* ingress.offer(next, rawEvent(10_001));
      expect(acknowledged).not.toContain("raw-10001");
      expect(yield* Queue.take(ingress.events)).toBe(next);
    }).pipe(Effect.scoped),
  );
});
