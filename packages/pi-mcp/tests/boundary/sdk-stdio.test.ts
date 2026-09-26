import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@effect/vitest";
import {
  deserializeMessage,
  serializeMessage,
  type JSONRPCErrorResponse,
  type JSONRPCMessage,
} from "@modelcontextprotocol/client";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Scheduler from "effect/Scheduler";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Core from "pi-cosmic-core";
import { pausedScheduler, yieldUntil } from "pi-cosmic-core/testing";
import { afterEach, vi } from "vitest";
import { McpBoundaryError } from "../../src/client/errors.ts";
import type { McpConnection } from "../../src/client/model.ts";
import { openSdkStdio } from "../../src/boundary/sdk-stdio.ts";
import { McpConnector } from "../../src/boundary/sdk-connection.ts";
import * as SdkClient from "../../src/boundary/sdk-client.ts";
import { McpExecution } from "../../src/tools/service.ts";
import { optionalFixture, projection } from "../fixtures/optional-features.ts";
import { protocolResponses } from "../fixtures/sdk-protocol-errors.ts";
import { stdioDefinition, testServer, testSettings } from "../fixtures/services.ts";
import {
  makeSdkStdioTransport,
  SdkStdioTransportError,
} from "../../src/boundary/sdk-stdio-transport.ts";

const fixture = fileURLToPath(new URL("../fixtures/stdio-server.mjs", import.meta.url));
const options = {
  protocol: "legacy" as const,
  command: process.execPath,
  args: [fixture],
  environment: {},
  connectTimeoutMs: 2_000,
  requestTimeoutMs: 2_000,
  cleanupTimeoutMs: 1_000,
};
const subscribe = { action: "resources.subscribe", server: "fixture", uri: "test://one" };
const unsubscribe = { ...subscribe, action: "resources.unsubscribe" };

const call = (connection: McpConnection, text: string) =>
  connection.request({ action: "tools.call", tool: "echo", arguments: { text } });
const foreign = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (error) =>
      error instanceof SdkStdioTransportError ? error : SdkStdioTransportError.of("read"),
  });
/** Records every real duplex process the SDK stdio boundary acquires. */
const recordAcquired = (onAcquire?: () => void) => {
  const acquired: Core.DuplexProcessHandle[] = [];
  const nativeOpen = Core.openDuplexProcess;
  vi.spyOn(Core, "openDuplexProcess").mockImplementation((input) =>
    nativeOpen(input).pipe(
      Effect.tap((handle) =>
        Effect.sync(() => {
          acquired.push(handle);
          onAcquire?.();
        }),
      ),
    ),
  );
  return acquired;
};

afterEach(() => vi.restoreAllMocks());

it.effect.each([{ requestTimeoutMs: 3_600_001 }, { connectTimeoutMs: 600_001 }])(
  "rejects timeouts beyond the independent request and connect maxima: %j",
  (invalid) =>
    Effect.gen(function* () {
      expect(yield* openSdkStdio({ ...options, ...invalid }).pipe(Effect.flip)).toMatchObject({
        kind: "invalid-input",
        outcome: "not-sent",
      });
    }),
);

describe.skipIf(process.platform !== "darwin")("macOS stdio child processes", () => {
  it.live("connects, lists, preserves empty cursors, and calls tools", () =>
    Effect.gen(function* () {
      const connection = yield* openSdkStdio(options);
      expect(connection.protocolVersion).toBe("2025-11-25");
      const listed = yield* connection.request({ action: "tools.list", cursor: "" });
      expect(listed.result).toMatchObject({ nextCursor: "empty-cursor-preserved" });
      expect((yield* call(connection, "hello")).result).toMatchObject({ isError: false });
      expect((yield* call(connection, "error")).result).toMatchObject({ isError: true });
    }),
  );

  it.live.each([600_001, 3_600_000])(
    "accepts a %i ms request timeout for an immediately completed stdio call",
    (requestTimeoutMs) =>
      Effect.gen(function* () {
        const connection = yield* openSdkStdio({ ...options, requestTimeoutMs });
        expect((yield* call(connection, "hello")).outcome).toBe("completed");
      }),
  );

  it.live("cancels an admitted request while a concurrent peer completes", () =>
    Effect.gen(function* () {
      const connection = yield* openSdkStdio(options);
      const slow = yield* call(connection, "wait").pipe(
        Effect.forkScoped({ startImmediately: true }),
      );
      expect((yield* call(connection, "stats")).result).toMatchObject({
        content: [{ text: "waiting=1,cancelled=0" }],
      });
      const peer = yield* call(connection, "wait-peer").pipe(
        Effect.forkScoped({ startImmediately: true }),
      );
      expect((yield* call(connection, "stats")).result).toMatchObject({
        content: [{ text: "waiting=2,cancelled=0" }],
      });
      yield* Fiber.interrupt(slow);
      expect((yield* call(connection, "stats")).result).toMatchObject({
        content: [{ text: "waiting=1,cancelled=1" }],
      });
      yield* call(connection, "release");
      expect((yield* Fiber.join(peer)).result).toMatchObject({
        content: [{ text: "wait-peer" }],
      });
    }),
  );

  it.live("closes the process before returning and refuses late calls", () =>
    Effect.gen(function* () {
      const acquired = recordAcquired();
      const connection = yield* openSdkStdio(options);
      yield* connection.close;
      yield* connection.close;
      expect(yield* acquired[0]!.cleanupState).toBe("confirmed");
      expect(yield* connection.request({ action: "tools.list" }).pipe(Effect.flip)).toMatchObject({
        kind: "connection",
        outcome: "not-sent",
      });
    }),
  );

  it.live("failed initialization cleans up while the caller scope stays open", () =>
    Effect.gen(function* () {
      const acquired = recordAcquired();
      const result = yield* openSdkStdio({ ...options, args: [fixture, "fail-init"] }).pipe(
        Effect.result,
      );
      expect(result._tag).toBe("Failure");
      expect(String(result)).not.toContain("private-fixture");
      expect(acquired).toHaveLength(1);
      expect(yield* acquired[0]!.cleanupState).toBe("confirmed");
    }),
  );

  it.live("interrupting initialization cleans up before parent scope release", () =>
    Effect.gen(function* () {
      const spawned = yield* Deferred.make<void>();
      const acquired = recordAcquired(() => Deferred.doneUnsafe(spawned, Effect.void));
      const opening = yield* openSdkStdio({ ...options, args: [fixture, "hang-init"] }).pipe(
        Effect.forkScoped,
      );
      yield* Deferred.await(spawned);
      yield* Fiber.interrupt(opening);
      expect(yield* acquired[0]!.cleanupState).toBe("confirmed");
    }),
  );

  it.live("bounds outbound and inbound messages without exposing child output", () =>
    Effect.gen(function* () {
      const connection = yield* openSdkStdio({
        ...options,
        requestBytes: 1024,
        responseBytes: 1024,
      });
      expect(yield* call(connection, "private-input".repeat(1024)).pipe(Effect.flip)).toMatchObject(
        { kind: "invalid-input", outcome: "not-sent" },
      );
      expect((yield* call(connection, "alive")).result).toMatchObject({ isError: false });
      const overflow = yield* call(connection, "oversized").pipe(Effect.result);
      expect(overflow).toMatchObject({
        _tag: "Failure",
        failure: { kind: "output-limit", outcome: "unknown" },
      });
      expect(String(overflow)).not.toContain("private-output");
    }),
  );

  it.live.each(["explicit close", "scope teardown"])(
    "modern metadata subscriptions confirm cleanup and allow same-server reopen after %s",
    (mode) =>
      Effect.gen(function* () {
        const script = `
          import readline from "node:readline";
          const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
          readline.createInterface({ input: process.stdin }).on("line", line => {
            const m = JSON.parse(line);
            if (m.method === "server/discover") send({ jsonrpc: "2.0", id: m.id, result: {
              resultType: "complete", supportedVersions: ["2026-07-28"],
              capabilities: { tools: { listChanged: true } }
            } });
            if (m.method === "subscriptions/listen") send({ jsonrpc: "2.0",
              method: "notifications/subscriptions/acknowledged", params: {
                notifications: m.params.notifications,
                _meta: { "io.modelcontextprotocol/subscriptionId": m.id }
              }
            });
          });
        `;
        const connector = yield* McpConnector.pipe(Effect.provide(McpConnector.layer));
        const server = testServer(`metadata-cleanup-${mode}`, {
          identity: `metadata-cleanup-${mode}`,
          directory: process.cwd(),
          scope: "project",
          definition: stdioDefinition({
            command: process.execPath,
            args: ["--input-type=module", "-e", script],
          }),
        });
        const settings = testSettings({
          connectTimeoutMs: 2_000,
          requestTimeoutMs: 2_000,
          idleTimeoutMs: 1_000,
        });
        const cleanup: boolean[] = [];
        for (let round = 0; round < 2; round++) {
          const owner = yield* Scope.fork(yield* Effect.scope);
          const connection = yield* connector
            .open(server, settings, undefined, (confirmed) => cleanup.push(confirmed))
            .pipe(Effect.provideService(Scope.Scope, owner));
          expect(connection.protocolVersion).toBe("2026-07-28");
          if (mode === "explicit close") yield* connection.close;
          yield* Scope.close(owner, Exit.void);
          expect(yield* connection.health).toMatchObject({
            closed: true,
            cleanupUnconfirmed: false,
          });
          yield* connection.close;
          expect(cleanup).toEqual(Array.from({ length: round + 1 }, () => true));
        }
      }),
  );
});

interface ProcessState {
  readers: number;
  holdWrites: boolean;
  holdClose: boolean;
  closes: number;
  cleanup: Core.DuplexProcessCleanupState;
}

const initializeReply = {
  result: {
    protocolVersion: "2025-11-25",
    capabilities: { tools: {} },
    serverInfo: { name: "fake-process", version: "1" },
  },
};

/** Records writes and answers requests by method; initialize succeeds unless overridden. */
const makeProcess = (
  responses: Readonly<Record<string, Pick<JSONRPCErrorResponse, "error">>> = {},
) =>
  Effect.gen(function* () {
    const output = yield* Queue.unbounded<Uint8Array, Core.DuplexProcessError | Cause.Done>();
    const writeGate = yield* Deferred.make<void>();
    const closeGate = yield* Deferred.make<void>();
    const writeEntered = yield* Deferred.make<void>();
    const closeEntered = yield* Deferred.make<void>();
    const writes: JSONRPCMessage[] = [];
    const state: ProcessState = {
      readers: 0,
      holdWrites: false,
      holdClose: false,
      closes: 0,
      cleanup: "pending",
    };
    const reader = <E>(stream: Stream.Stream<Uint8Array, E>) =>
      Stream.fromEffect(
        Effect.sync(() => {
          state.readers++;
        }),
      ).pipe(
        Stream.flatMap(() => stream),
        Stream.ensuring(
          Effect.sync(() => {
            state.readers--;
          }),
        ),
      );
    const handle: Core.DuplexProcessHandle = {
      pid: 1,
      stdout: reader(Stream.fromQueue(output)),
      stderr: reader(Stream.never),
      write: (bytes) =>
        Effect.gen(function* () {
          if (state.holdWrites) {
            yield* Deferred.succeed(writeEntered, undefined);
            yield* Deferred.await(writeGate);
          }
          const message = deserializeMessage(new TextDecoder().decode(bytes));
          writes.push(message);
          if (!("method" in message) || !("id" in message)) return;
          const reply =
            responses[message.method] ??
            (message.method === "initialize" ? initializeReply : undefined);
          if (reply === undefined) return;
          yield* Queue.offer(
            output,
            new TextEncoder().encode(
              serializeMessage({ jsonrpc: "2.0", id: message.id, ...reply }),
            ),
          );
        }),
      exit: Effect.never,
      close: Effect.gen(function* () {
        state.closes++;
        yield* Deferred.succeed(closeEntered, undefined);
        if (state.holdClose) yield* Deferred.await(closeGate);
        state.cleanup = "confirmed";
      }),
      cleanupState: Effect.sync(() => state.cleanup),
    };
    return { handle, state, writes, output, writeGate, writeEntered, closeGate, closeEntered };
  });
const startTransport = (fake: { readonly handle: Core.DuplexProcessHandle }) =>
  makeSdkStdioTransport(fake.handle, { maxBufferSize: 1024, maxWriteBytes: 1024 }).pipe(
    Effect.tap((transport) => foreign(() => transport.start())),
  );

it.effect.each(protocolResponses)(
  "classifies and redacts $name without replay",
  ({ response, kind, reason }) =>
    Effect.gen(function* () {
      const fake = yield* makeProcess({ "tools/call": response });
      vi.spyOn(Core, "openDuplexProcess").mockReturnValue(Effect.succeed(fake.handle));
      const cleanup: boolean[] = [];
      const connection = yield* openSdkStdio({
        ...options,
        onCleanup: (confirmed) => cleanup.push(confirmed),
      });
      expect(connection.protocolVersion).toBe("2025-11-25");
      const result = yield* call(connection, "unsupported").pipe(Effect.result);
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { kind, outcome: "completed" },
      });
      if (result._tag === "Failure") expect(result.failure.reason).toBe(reason);
      expect(String(result)).not.toContain("private-");
      expect(
        fake.writes.filter((message) => "method" in message && message.method === "tools/call"),
      ).toHaveLength(1);
      expect(yield* connection.health).toMatchObject({ closed: false, cleanupUnconfirmed: false });
      yield* connection.close;
      expect(cleanup).toEqual([true]);
      expect(fake.state.readers).toBe(0);
    }),
);

it.effect.each(protocolResponses)(
  "cleans up initialization rejected for $name",
  ({ response, kind, reason }) =>
    Effect.gen(function* () {
      const fake = yield* makeProcess({ initialize: response });
      vi.spyOn(Core, "openDuplexProcess").mockReturnValue(Effect.succeed(fake.handle));
      const cleanup: boolean[] = [];
      const result = yield* openSdkStdio({
        ...options,
        onCleanup: (confirmed) => cleanup.push(confirmed),
      }).pipe(Effect.result);
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { kind, outcome: "not-sent" },
      });
      if (result._tag === "Failure") expect(result.failure.reason).toBe(reason);
      expect(String(result)).not.toContain("private-");
      expect(
        fake.writes.filter((message) => "method" in message && message.method === "initialize"),
      ).toHaveLength(1);
      expect(cleanup).toEqual([true]);
      expect(fake.state.readers).toBe(0);
    }),
);

it.effect("headless input-required remains incomplete and never exposes private state", () =>
  Effect.gen(function* () {
    const fake = yield* makeProcess();
    vi.spyOn(Core, "openDuplexProcess").mockReturnValue(Effect.succeed(fake.handle));
    const connection = yield* openSdkStdio(options);
    // Legacy decoding removes modern discriminators. Inject only an already-accepted
    // value at our owned seam; do not change negotiation to reach this defensive guard.
    const inputRequired = {
      content: [],
      resultType: "input_required",
      requestState: "private-input-state",
    };
    vi.spyOn(SdkClient, "executeSdkRequest").mockResolvedValue(inputRequired);
    const result = yield* call(connection, "unsupported").pipe(Effect.result);
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { kind: "unsupported", outcome: "unknown" },
    });
    expect(String(result)).not.toContain("private-");
  }),
);

it.effect("revokes cancelled queued sends before native dispatch", () =>
  Effect.gen(function* () {
    const fake = yield* makeProcess();
    const transport = yield* startTransport(fake);
    fake.state.holdWrites = true;
    const first = yield* foreign(() =>
      transport.send({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    ).pipe(Effect.forkScoped);
    yield* Deferred.await(fake.writeEntered);
    const cancelled = transport.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const result = yield* foreign(() => cancelled).pipe(
      Effect.flip,
      Effect.forkScoped({ startImmediately: true }),
    );
    yield* foreign(() =>
      transport.send({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: 2 },
      }),
    );
    expect(yield* Fiber.join(result)).toMatchObject({ kind: "cancelled" });
    const signal = new AbortController();
    const third = transport.send(
      { jsonrpc: "2.0", id: 3, method: "tools/list" },
      { requestSignal: signal.signal },
    );
    const thirdResult = yield* foreign(() => third).pipe(
      Effect.flip,
      Effect.forkScoped({ startImmediately: true }),
    );
    signal.abort();
    expect(yield* Fiber.join(thirdResult)).toMatchObject({ kind: "cancelled" });
    yield* Deferred.succeed(fake.writeGate, undefined);
    yield* Fiber.join(first);
    yield* foreign(() => transport.send({ jsonrpc: "2.0", id: 4, method: "tools/list" }));
    expect(fake.writes.map((message) => ("id" in message ? message.id : undefined))).toEqual([
      1, 4,
    ]);
  }),
);

it.effect(
  "explicit transport close joins readers and writer, rejects queued work, and is repeatable",
  () =>
    Effect.gen(function* () {
      const fake = yield* makeProcess();
      const transport = yield* startTransport(fake);
      yield* yieldUntil(() => fake.state.readers === 2);
      fake.state.holdWrites = true;
      const writing = yield* foreign(() =>
        transport.send({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      ).pipe(Effect.flip, Effect.forkScoped);
      yield* Deferred.await(fake.writeEntered);
      yield* foreign(() => transport.close());
      expect(fake.state.readers).toBe(0);
      expect(yield* Fiber.join(writing)).toBeInstanceOf(SdkStdioTransportError);
      yield* Deferred.succeed(fake.writeGate, undefined);
      yield* foreign(() => transport.close());
      expect(
        yield* foreign(() => transport.send({ jsonrpc: "2.0", id: 2, method: "tools/list" })).pipe(
          Effect.flip,
        ),
      ).toMatchObject({ kind: "closed" });
      expect(fake.writes).toHaveLength(0);
    }),
);

it.effect.each(["overflow", "read-error", "malformed", "eof"])(
  "%s closes the transport and releases its scope",
  (mode) =>
    Effect.gen(function* () {
      const fake = yield* makeProcess();
      const transport = yield* makeSdkStdioTransport(fake.handle, {
        maxBufferSize: 64,
        maxWriteBytes: 1024,
      });
      let closes = 0;
      transport.onclose = () => {
        closes++;
      };
      yield* foreign(() => transport.start());
      yield* yieldUntil(() => fake.state.readers === 2);
      if (mode === "overflow") yield* Queue.offer(fake.output, new Uint8Array(65));
      else if (mode === "read-error")
        yield* Queue.fail(
          fake.output,
          Core.duplexProcessError("read", "failed", "private-native-error"),
        );
      else if (mode === "malformed")
        yield* Queue.offer(fake.output, new TextEncoder().encode('{"private-malformed":true}\n'));
      else yield* Queue.end(fake.output);
      yield* yieldUntil(() => fake.state.readers === 0);
      expect(transport.failure?.kind).toBe(
        mode === "overflow" ? "output-limit" : mode === "eof" ? undefined : "read",
      );
      expect(String(transport.failure)).not.toContain("private-");
      yield* foreign(() => transport.close());
      expect(closes).toBe(1);
    }),
);

it.effect("cancellation also interrupts waiting inside the owned process writer", () =>
  Effect.gen(function* () {
    const fake = yield* makeProcess();
    const transport = yield* startTransport(fake);
    fake.state.holdWrites = true;
    const signal = new AbortController();
    const first = yield* foreign(() =>
      transport.send(
        { jsonrpc: "2.0", id: 1, method: "tools/list" },
        { requestSignal: signal.signal },
      ),
    ).pipe(Effect.flip, Effect.forkScoped({ startImmediately: true }));
    yield* Deferred.await(fake.writeEntered);
    signal.abort();
    expect(yield* Fiber.join(first)).toMatchObject({ kind: "cancelled" });
    yield* Deferred.succeed(fake.writeGate, undefined);
    yield* foreign(() => transport.send({ jsonrpc: "2.0", id: 2, method: "tools/list" }));
    expect(fake.writes.map((message) => ("id" in message ? message.id : undefined))).toEqual([2]);
  }),
);

it.effect("a first close interruption cannot poison cleanup or permit new requests", () =>
  Effect.gen(function* () {
    const fake = yield* makeProcess();
    vi.spyOn(Core, "openDuplexProcess").mockReturnValue(Effect.succeed(fake.handle));
    const connection = yield* openSdkStdio(options);
    fake.state.holdClose = true;
    const closing = yield* connection.close.pipe(Effect.forkScoped);
    yield* Deferred.await(fake.closeEntered);
    const interruption = yield* Fiber.interrupt(closing).pipe(Effect.forkScoped);
    const secondClose = yield* connection.close.pipe(Effect.forkScoped);
    expect(yield* connection.request({ action: "tools.list" }).pipe(Effect.flip)).toMatchObject({
      kind: "connection",
      outcome: "not-sent",
    });
    expect(fake.state.readers).toBe(0);
    yield* Deferred.succeed(fake.closeGate, undefined);
    yield* Fiber.join(interruption);
    yield* Fiber.join(secondClose);
    yield* connection.close;
    expect(fake.state.closes).toBe(1);
    expect(fake.state.cleanup).toBe("confirmed");
  }),
);

it.effect("early first-close interruption cannot strand connection cleanup or scope release", () =>
  Effect.gen(function* () {
    for (let checkpoint = 0; checkpoint < 24; checkpoint++) {
      const owner = yield* Scope.fork(yield* Effect.scope);
      const fake = yield* makeProcess();
      vi.spyOn(Core, "openDuplexProcess").mockReturnValue(Effect.succeed(fake.handle));
      const cleanup: boolean[] = [];
      const connection = yield* openSdkStdio({
        ...options,
        onCleanup: (confirmed) => cleanup.push(confirmed),
      }).pipe(Effect.provideService(Scope.Scope, owner));
      expect(connection.capabilities).toMatchObject({
        tools: true,
        resources: false,
        prompts: false,
      });
      const paused = pausedScheduler();
      const closing = yield* connection.close.pipe(
        Effect.provideService(Scheduler.MaxOpsBeforeYield, 8),
        Effect.provideService(Scheduler.Scheduler, paused.scheduler),
        Effect.forkScoped({ startImmediately: true }),
      );
      for (let step = 0; step < checkpoint; step++) paused.step();
      closing.interruptUnsafe();
      paused.resume();
      yield* Fiber.await(closing);
      expect(yield* connection.close.pipe(Effect.exit)).toEqual(Exit.void);
      expect(yield* Scope.close(owner, Exit.void).pipe(Effect.exit)).toEqual(Exit.void);
      expect(fake.state.closes).toBe(1);
      expect(fake.state.cleanup).toBe("confirmed");
      expect(fake.state.readers).toBe(0);
      expect(cleanup).toEqual([true]);
      yield* connection.terminal;
      yield* connection.setToken("stdio-no-op");
      expect(yield* connection.health).toMatchObject({ closed: true, cleanupUnconfirmed: false });
    }
  }),
);

it.effect("failed native readiness with uncertain cleanup is not a safe acquisition failure", () =>
  Effect.gen(function* () {
    // Core's failed-readiness channel takes precedence over the startup deadline
    // when native cleanup cannot be confirmed, before any handle is handed off.
    vi.spyOn(Core, "openDuplexProcess").mockReturnValue(
      Effect.fail(Core.duplexProcessError("cleanup", "timeout", "private-native-cleanup")),
    );
    const result = yield* openSdkStdio(options).pipe(Effect.result);
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { kind: "cleanup", outcome: "unknown" },
    });
    if (result._tag === "Failure") expect(result.failure).toBeInstanceOf(McpBoundaryError);
    expect(String(result)).not.toContain("private-");
  }),
);

it.effect("initialization interruption survives uncertain cleanup and still releases readers", () =>
  Effect.gen(function* () {
    const fake = yield* makeProcess();
    const initialized = yield* Deferred.make<void>();
    vi.spyOn(Core, "openDuplexProcess").mockReturnValue(
      Effect.succeed({
        ...fake.handle,
        write: () => Deferred.succeed(initialized, undefined).pipe(Effect.asVoid),
        close: Effect.sync(() => {
          fake.state.cleanup = "unconfirmed";
        }).pipe(
          Effect.andThen(
            Effect.fail(Core.duplexProcessError("cleanup", "timeout", "private-native-cleanup")),
          ),
        ),
      }),
    );
    const cleanup: boolean[] = [];
    const opening = yield* openSdkStdio({
      ...options,
      onCleanup: (confirmed) => cleanup.push(confirmed),
    }).pipe(Effect.forkScoped);
    yield* Deferred.await(initialized);
    yield* Fiber.interrupt(opening);
    const result = yield* Fiber.await(opening);
    expect(Exit.isFailure(result) && Cause.hasInterruptsOnly(result.cause)).toBe(true);
    expect(fake.state.cleanup).toBe("unconfirmed");
    expect(fake.state.readers).toBe(0);
    expect(cleanup).toEqual([false]);
  }),
);

it.effect("keeps unconfirmed process cleanup distinct from a request failure", () =>
  Effect.gen(function* () {
    const fake = yield* makeProcess();
    const failed: Core.DuplexProcessHandle = {
      ...fake.handle,
      write: () => Effect.fail(Core.duplexProcessError("write", "failed", "private-write")),
      close: Effect.fail(Core.duplexProcessError("cleanup", "failed", "private-cleanup")),
      cleanupState: Effect.succeed("unconfirmed"),
    };
    vi.spyOn(Core, "openDuplexProcess").mockReturnValue(Effect.succeed(failed));
    const result = yield* openSdkStdio(options).pipe(Effect.result);
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { kind: "cleanup", outcome: "unknown" },
    });
    if (result._tag === "Failure") expect(result.failure).toBeInstanceOf(McpBoundaryError);
    expect(String(result)).not.toContain("private-");
    expect(fake.state.readers).toBe(0);
  }),
);

it.live(
  "modern actual stdio carries completion, private MRTR progress and exact subscription IDs through execution",
  () => {
    const script = `
    import readline from "node:readline";
    const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
    const respond = (id, result) => send({ jsonrpc: "2.0", id, result: { resultType: "complete", ttlMs: 60000, cacheScope: "private", ...result } });
    const notify = (method, params) => send({ jsonrpc: "2.0", method, params });
    readline.createInterface({ input: process.stdin }).on("line", (line) => {
      const m = JSON.parse(line); if (m.id === undefined) return;
      switch (m.method) {
        case "server/discover": return respond(m.id, { supportedVersions: ["2026-07-28"], capabilities: { tools: {}, resources: { subscribe: true }, prompts: {}, completions: {}, logging: {} } });
        case "tools/list": return respond(m.id, { tools: [{ name: "example", inputSchema: { type: "object" } }] });
        case "resources/list": return respond(m.id, { resources: [{ name: "one", uri: "test://one" }] });
        case "resources/templates/list": return respond(m.id, { resourceTemplates: [] });
        case "prompts/list": return respond(m.id, { prompts: [{ name: "example", arguments: [{ name: "value" }] }] });
        case "completion/complete": return respond(m.id, { completion: { values: ["stdio"] } });
        case "subscriptions/listen":
          process.stdout.write([
            { jsonrpc: "2.0", method: "notifications/subscriptions/acknowledged", params: { notifications: m.params.notifications, _meta: { "io.modelcontextprotocol/subscriptionId": m.id } } },
            ...["listen:wrong", m.id].map(id => ({ jsonrpc: "2.0", method: "notifications/resources/updated", params: { uri: "test://one", _meta: { "io.modelcontextprotocol/subscriptionId": id } } })),
          ].map(value => JSON.stringify(value) + "\\n").join(""));
          return;
        case "tools/call":
          notify("notifications/progress", { progressToken: m.params._meta.progressToken, progress: m.params.requestState ? 0 : 100 });
          return respond(m.id, m.params.requestState ? { content: [{ type: "text", text: "done" }] } : {
            resultType: "input_required", requestState: "opaque", inputRequests: { first: { method: "elicitation/create", params: { message: "Choose", requestedSchema: { type: "object", properties: {} } } } },
          });
      }
    });
  `;
    return Effect.gen(function* () {
      const seen: number[] = [];
      let asks = 0;
      const f = optionalFixture(undefined, {
        open: openSdkStdio({
          ...options,
          protocol: "auto",
          args: ["--input-type=module", "-e", script],
        }),
        interaction: {
          resolve: Effect.succeed({
            current: Effect.succeed(true),
            ask: () =>
              Effect.sync(() => {
                asks++;
                return { action: "accept" as const, content: {} };
              }),
            openBrowser: () => Effect.succeed(false),
          }),
        },
      });
      yield* Effect.gen(function* () {
        const execution = yield* McpExecution;
        const completion = yield* execution.execute(
          {
            action: "completion.complete",
            server: "fixture",
            ref: { type: "ref/prompt", name: "example" },
            argument: { name: "value", value: "" },
          },
          projection,
        );
        expect(completion.reply.data).toMatchObject({
          result: { completion: { values: ["stdio"] } },
        });
        yield* execution.execute(
          { action: "tools.call", server: "fixture", tool: "example" },
          { ...projection, onProgress: (value) => seen.push(value.progress) },
        );
        expect(asks).toBe(1);
        expect(seen).toEqual([100, 0]);
        expect(
          yield* execution
            .execute(
              { action: "tools.call", server: "fixture", tool: "example", logLevel: "error" },
              projection,
            )
            .pipe(Effect.flip),
        ).toMatchObject({ kind: "unsupported", outcome: "not-sent" });
        yield* execution.execute(subscribe, projection);
        yield* Effect.sleep(80);
        const events = yield* execution.execute(
          { action: "events.read", server: "fixture" },
          projection,
        );
        expect(
          Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))(events).match(
            /resource-updated/g,
          ),
        ).toHaveLength(1);
        yield* execution.execute(unsubscribe, projection);
      }).pipe(Effect.provide(f.layer));
    });
  },
);

it.live(
  "legacy actual stdio pre-ack cancellation fences uncertain subscription establishment",
  () => {
    const script = `
    import readline from "node:readline";
    let waiting = false;
    const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
    readline.createInterface({ input: process.stdin }).on("line", (line) => {
      const m = JSON.parse(line); if (m.id === undefined) return;
      if (m.method === "initialize") return reply(m.id, { protocolVersion: "2025-11-25", capabilities: { tools: {}, resources: { subscribe: true } }, serverInfo: { name: "fixture", version: "1" } });
      if (m.method === "resources/subscribe") { waiting = true; return; }
      if (m.method === "tools/list") return reply(m.id, { tools: [{ name: "example", inputSchema: { type: "object" } }] });
      if (m.method === "resources/list") return reply(m.id, { resources: [] });
      if (m.method === "resources/templates/list") return reply(m.id, { resourceTemplates: [] });
      if (m.method === "tools/call") return reply(m.id, { content: [{ type: "text", text: "barrier" }], structuredContent: { waiting } });
    });
  `;
    return Effect.gen(function* () {
      const f = optionalFixture(undefined, {
        open: openSdkStdio({ ...options, args: ["--input-type=module", "-e", script] }),
      });
      yield* Effect.gen(function* () {
        const execution = yield* McpExecution;
        const opening = yield* Effect.forkScoped(execution.execute(subscribe, projection));
        const barrier = yield* execution.execute(
          { action: "tools.call", server: "fixture", tool: "example" },
          projection,
        );
        expect(barrier.reply.data).toMatchObject({
          result: { structuredContent: { waiting: true } },
        });
        expect(yield* execution.execute(unsubscribe, projection).pipe(Effect.flip)).toMatchObject({
          kind: "cleanup",
          outcome: "unknown",
        });
        expect(yield* Fiber.join(opening).pipe(Effect.flip)).toMatchObject({ outcome: "unknown" });
        expect(yield* execution.execute(subscribe, projection).pipe(Effect.flip)).toMatchObject({
          outcome: "not-sent",
        });
        expect(f.opens()).toBe(1);
      }).pipe(Effect.provide(f.layer));
    });
  },
);

it.live(
  "actual stdio cancellation write failure never releases an acknowledged subscription",
  () => {
    const closedInput = Deferred.makeUnsafe<void>();
    const script = `
    import readline from "node:readline";
    import { closeSync } from "node:fs";
    const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
    readline.createInterface({ input: process.stdin }).on("line", (line) => {
      const m = JSON.parse(line); if (m.id === undefined) return;
      if (m.method === "server/discover") return send({ jsonrpc: "2.0", id: m.id, result: { resultType: "complete", supportedVersions: ["2026-07-28"], capabilities: { resources: { subscribe: true } } } });
      if (m.method === "subscriptions/listen") {
        setInterval(() => {}, 1000);
        send({ jsonrpc: "2.0", method: "notifications/subscriptions/acknowledged", params: { notifications: m.params.notifications, _meta: { "io.modelcontextprotocol/subscriptionId": m.id } } });
        setTimeout(() => {
          process.stdin.on("error", () => {});
          process.stdin.destroy();
          try { closeSync(0); } catch {}
          send({ jsonrpc: "2.0", method: "notifications/resources/updated", params: { uri: "test://one", _meta: { "io.modelcontextprotocol/subscriptionId": m.id } } });
        }, 40);
      }
    });
  `;
    return Effect.gen(function* () {
      const f = optionalFixture(undefined, {
        open: openSdkStdio({
          ...options,
          protocol: "auto",
          args: ["--input-type=module", "-e", script],
        }),
        mapConnection: (connection) => ({
          ...connection,
          remoteEvents: connection.remoteEvents.pipe(
            Stream.mapEffect((event) =>
              Deferred.succeed(closedInput, undefined).pipe(Effect.as(event)),
            ),
          ),
        }),
      });
      yield* Effect.gen(function* () {
        const execution = yield* McpExecution;
        expect((yield* execution.execute(subscribe, projection)).reply.isError).toBe(false);
        yield* Deferred.await(closedInput);
        expect(yield* execution.execute(unsubscribe, projection).pipe(Effect.flip)).toMatchObject({
          kind: "cleanup",
          outcome: "unknown",
        });
        expect(yield* execution.execute(subscribe, projection).pipe(Effect.flip)).toMatchObject({
          outcome: "not-sent",
        });
        expect(f.opens()).toBe(1);
      }).pipe(Effect.provide(f.layer));
    });
  },
);

it.live(
  "legacy stdio queued resource updates keep their original local subscription generation",
  () => {
    const script = `
    import readline from "node:readline";
    const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
    const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
    readline.createInterface({ input: process.stdin }).on("line", (line) => {
      const m = JSON.parse(line); if (m.id === undefined) return;
      if (m.method === "initialize") return reply(m.id, { protocolVersion: "2025-11-25", capabilities: { tools: {}, resources: { subscribe: true } }, serverInfo: { name: "fixture", version: "1" } });
      if (m.method === "resources/subscribe" || m.method === "resources/unsubscribe") return reply(m.id, {});
      if (m.method === "tools/list") return reply(m.id, { tools: [{ name: "example", inputSchema: { type: "object" } }] });
      if (m.method === "resources/list") return reply(m.id, { resources: [] });
      if (m.method === "resources/templates/list") return reply(m.id, { resourceTemplates: [] });
      if (m.method === "tools/call") {
        send({ jsonrpc: "2.0", method: "notifications/resources/updated", params: { uri: "test://one" } });
        return reply(m.id, { content: [{ type: "text", text: "done" }] });
      }
    });
  `;
    return Effect.gen(function* () {
      const captured = yield* Deferred.make<void>();
      const delivery = yield* Deferred.make<void>();
      let paused = false;
      const f = optionalFixture(undefined, {
        open: openSdkStdio({ ...options, args: ["--input-type=module", "-e", script] }),
        mapConnection: (connection) => ({
          ...connection,
          remoteEvents: connection.remoteEvents.pipe(
            Stream.mapEffect((event) => {
              if (paused) return Effect.succeed(event);
              paused = true;
              return Deferred.succeed(captured, undefined).pipe(
                Effect.andThen(Deferred.await(delivery)),
                Effect.as(event),
              );
            }),
          ),
        }),
      });
      yield* Effect.gen(function* () {
        const execution = yield* McpExecution;
        const emit = { action: "tools.call", server: "fixture", tool: "example" };
        yield* execution.execute(subscribe, projection);
        yield* execution.execute(emit, projection);
        yield* Deferred.await(captured);
        yield* execution.execute(unsubscribe, projection);
        yield* execution.execute(subscribe, projection);
        yield* Deferred.succeed(delivery, undefined);
        yield* Effect.sleep(10);
        expect(
          (yield* execution.execute({ action: "events.read", server: "fixture" }, projection)).reply
            .data,
        ).toMatchObject({ result: { events: [] } });
        yield* execution.execute(emit, projection);
        yield* Effect.sleep(10);
        expect(
          (yield* execution.execute({ action: "events.read", server: "fixture" }, projection)).reply
            .data,
        ).toMatchObject({
          result: {
            events: [{ kind: "resource-updated", uri: "test://one", cursor: expect.any(String) }],
          },
        });
      }).pipe(Effect.ensuring(Deferred.succeed(delivery, undefined)), Effect.provide(f.layer));
    });
  },
);
