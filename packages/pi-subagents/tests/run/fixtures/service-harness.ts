// Explicit test entry-point Layer provision owns each scoped service runtime.
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import { makeLocalPiBackendDriver } from "../../../src/backend/local-pi.ts";
import type { BackendDriver, BackendEvent, BackendReport } from "../../../src/backend/model.ts";
import {
  makeSubagentBackendRegistry,
  SubagentBackendRegistry,
} from "../../../src/backend/service.ts";
import {
  WriterCwdCanonicalizationError,
  WriterLeaseConflictError,
  WriterLeaseMarkError,
  WriterLeaseReleaseError,
  WriterLeaseService,
  type WriterLease,
} from "../../../src/boundary/writer-lease.ts";
import { resolveSubagentConfig } from "../../../src/config/options.ts";
import { decodeSubagentConfig } from "../../../src/config/schema.ts";
import {
  makeSubagentProfileService,
  SubagentProfileService,
} from "../../../src/profiles/service.ts";
import type { LocalPiParentControl, RpcCommand } from "../../../src/backend/local-pi-protocol.ts";
import {
  ChildProcess,
  type ChildLaunchRequest,
  type ChildProcessHandle,
  type ChildWireEvent,
} from "../../../src/boundary/child-process.ts";
import { SubagentProcessError } from "../../../src/run/errors.ts";
import type { StartSubagentRequest, SubagentProjection } from "../../../src/run/model.ts";
import type { SubagentNotification } from "../../../src/boundary/host-notifier.ts";
import {
  SubagentService,
  type SubagentServiceContract,
  type SubagentServiceOptions,
} from "../../../src/run/service.ts";
import { expect } from "@effect/vitest";
import * as Fiber from "effect/Fiber";
import { provideBuiltLayer } from "pi-cosmic-core";
import { yieldUntil } from "pi-cosmic-core/testing";

/** Runs one scoped test body against the service that `layer` builds, typed like Effect.gen. */
export const withService = <Eff extends Effect.Effect<any, any, any>, A, ROut, LE, LR>(
  layer: Layer.Layer<ROut, LE, LR>,
  body: (service: SubagentServiceContract) => Generator<Eff, A, never>,
) =>
  SubagentService.use((service) => Effect.gen(() => body(service))).pipe(
    Effect.scoped,
    provideBuiltLayer(layer),
  );

export const waitForCompleted = (service: SubagentServiceContract, id: string) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 200; attempt++) {
      if ((yield* service.list).some((run) => run.id === id && run.state === "completed")) return;
      yield* Effect.yieldNow;
    }
    return yield* Effect.die(new Error("Run did not complete before the delivery clock advance."));
  });

/** Settles a local run's assignment, then waits for completion and the child's release. */
export const completeLocalRun = (
  service: SubagentServiceContract,
  control: FakeChildControl,
  runId: string,
  text?: string,
) =>
  Effect.gen(function* () {
    control.settle(text);
    yield* waitForCompleted(service, runId);
    yield* yieldUntil(() => control.released() === 1);
  });

/** A notify policy that acknowledges every completion generation it is shown. */
export const acknowledgeCompletions = (notification: SubagentNotification) =>
  notification.type === "completed"
    ? { deliveredCompletionKeys: notification.runs.map((run) => `${run.id}:${run.generation}`) }
    : undefined;

/** An observation `use` callback that records whether it was ever entered. */
export const useProbe = () => {
  const probe = {
    entered: false,
    use: () =>
      Effect.sync(() => {
        probe.entered = true;
      }),
  };
  return probe;
};

/**
 * Interrupts a forked observation while `gate` is held and expects it to cancel before use.
 * The gate is released even when an expectation fails, so a regression fails rather than hangs.
 */
export const expectInterruptBeforeUse = <A, E>(
  waiter: Fiber.Fiber<A, E>,
  probe: { readonly entered: boolean },
  gate: Deferred.Deferred<void>,
) =>
  Effect.gen(function* () {
    let cancelled = false;
    const cancellation = yield* Fiber.interrupt(waiter).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          cancelled = true;
        }),
      ),
      Effect.forkScoped,
    );
    yield* Effect.gen(function* () {
      for (let i = 0; i < 20; i++) yield* Effect.yieldNow;
      expect(cancelled).toBe(true);
      expect(probe.entered).toBe(false);
    }).pipe(Effect.ensuring(Deferred.succeed(gate, undefined)));
    yield* Fiber.join(cancellation);
  });

type RpcWireValue = Extract<ChildWireEvent, { readonly type: "rpc_message" }>["value"];
type IpcWireValue = Extract<ChildWireEvent, { readonly type: "parent_contact" }>["value"];
type AcknowledgedIpcControlType = Extract<
  LocalPiParentControl,
  { readonly type: "parent_reply" | "proxy_notification" | "turn_input_barrier" }
>["type"];
type IpcControlOf<T extends LocalPiParentControl["type"]> = Extract<
  LocalPiParentControl,
  { readonly type: T }
>;

export interface FakeChildControl {
  readonly launch: ChildLaunchRequest;
  readonly commands: RpcCommand[];
  readonly ipc: LocalPiParentControl[];
  readonly terminations: Array<"graceful" | "force">;
  readonly released: () => number;
  /** Whether the child received an RPC command of `type`. */
  readonly sent: (type: RpcCommand["type"]) => boolean;
  /** Whether the child received an IPC control of `type` that `matches`. */
  readonly sentIpc: <T extends LocalPiParentControl["type"]>(
    type: T,
    matches?: (message: IpcControlOf<T>) => boolean,
  ) => boolean;
  /** The received RPC command types in order, restricted to `only` when given. */
  readonly commandTypes: (...only: RpcCommand["type"][]) => RpcCommand["type"][];
  /** Ends the assignment with a final assistant message, then settles the agent. */
  readonly settle: (text?: string) => void;
  readonly failNext: (type: RpcCommand["type"], error: string) => void;
  readonly failTransportNext: (type: RpcCommand["type"], code: string) => void;
  readonly failNextIpc: (code: string) => void;
  readonly rejectNextParentReply: () => void;
  readonly dropNext: (type: RpcCommand["type"]) => void;
  readonly gateNextSend: (type: RpcCommand["type"], gate: Deferred.Deferred<void, never>) => void;
  readonly gateNextIpc: (gate: Deferred.Deferred<void, never>) => void;
  readonly gateNextIpcType: (
    type: LocalPiParentControl["type"],
    gate: Deferred.Deferred<void, never>,
  ) => void;
  readonly ackNextIpcBeforeSendSettles: (type: AcknowledgedIpcControlType) => void;
  readonly gateRelease: (gate: Deferred.Deferred<void, never>) => void;
  readonly beforeNextResponse: (type: RpcCommand["type"], value: RpcWireValue) => void;
  readonly offer: (value: RpcWireValue) => void;
  readonly offerIpc: (value: IpcWireValue) => void;
  readonly offerProtocolError: (message: string) => void;
  readonly exit: (exitCode?: number | null) => void;
  readonly failExit: (message: string) => void;
}

const isIpcControl =
  <T extends LocalPiParentControl["type"]>(type: T) =>
  (message: LocalPiParentControl): message is IpcControlOf<T> =>
    message.type === type;

/** Removes and returns the first entry that `matches`, preserving FIFO matching. */
const takeFirst = <A>(entries: A[], matches: (entry: A) => boolean): A | undefined => {
  const index = entries.findIndex(matches);
  return index >= 0 ? entries.splice(index, 1)[0] : undefined;
};

export function fakeChildLayer(
  beforeSpawn: Effect.Effect<void, never, never> = Effect.void,
  options: {
    readonly dropInitialState?: boolean;
    readonly releaseDefect?: boolean;
    readonly omitSessionFile?: boolean;
    readonly stateThinkingLevel?: string;
    readonly onRelease?: ((spawnIndex: number) => void) | undefined;
    readonly failReclaim?: boolean | undefined;
    readonly reclaimGate?: Deferred.Deferred<void, never> | undefined;
    readonly initialFailures?: ReadonlyArray<{
      readonly spawnIndex: number;
      readonly type: RpcCommand["type"];
      readonly error: string;
    }>;
    readonly initialTransportFailures?: ReadonlyArray<{
      readonly spawnIndex: number;
      readonly type: RpcCommand["type"];
      readonly code: string;
    }>;
    readonly initialSendGates?: ReadonlyArray<{
      readonly spawnIndex: number;
      readonly type: RpcCommand["type"];
      readonly gate: Deferred.Deferred<void, never>;
    }>;
  } = {},
) {
  const controls: FakeChildControl[] = [];
  const reclaimedRunIds: string[] = [];
  let nextSpawnIndex = 0;
  let remainingInitialStateDrops = options.dropInitialState ? Number.POSITIVE_INFINITY : 0;
  const sessionState = {
    sessionId: "child-session",
    thinkingLevel: options.stateThinkingLevel ?? "high",
    model: { provider: "openai-codex", id: "gpt-5.6-sol", name: "GPT 5.6 Sol", reasoning: true },
    isStreaming: false,
    isCompacting: false,
    steeringMode: "all",
    followUpMode: "all",
    autoCompactionEnabled: true,
    messageCount: 0,
    pendingMessageCount: 0,
  };
  const stateData = options.omitSessionFile
    ? sessionState
    : { ...sessionState, sessionFile: "/tmp/child-session.jsonl" };
  const layer: Layer.Layer<ChildProcess> = Layer.succeed(ChildProcess, {
    reclaimRunState: ({ runId }) =>
      Effect.gen(function* () {
        reclaimedRunIds.push(runId);
        if (options.reclaimGate) yield* Deferred.await(options.reclaimGate);
        if (options.failReclaim)
          return yield* new SubagentProcessError({
            operation: "reclaim run state",
            code: "fixture_reclaim_failed",
            message: "Fixture run-state reclamation failed.",
          });
      }),
    spawn: (launch) =>
      Effect.acquireRelease(
        Effect.gen(function* () {
          const spawnIndex = nextSpawnIndex++;
          yield* beforeSpawn;
          const events = yield* Queue.unbounded<ChildWireEvent, Cause.Done>();
          const exited = yield* Deferred.make<
            Extract<ChildWireEvent, { readonly type: "exit" }>,
            SubagentProcessError
          >();
          const commands: RpcCommand[] = [];
          const ipc: LocalPiParentControl[] = [];
          const terminations: Array<"graceful" | "force"> = [];
          let releaseCount = 0;
          let releaseGate: Deferred.Deferred<void, never> | undefined;
          const forSpawn = <A extends { readonly spawnIndex: number }>(
            initial: ReadonlyArray<A> = [],
          ) => initial.filter((entry) => entry.spawnIndex === spawnIndex);
          const failures: Array<{ readonly type: RpcCommand["type"]; readonly error: string }> =
            forSpawn(options.initialFailures);
          const dropped: RpcCommand["type"][] = remainingInitialStateDrops > 0 ? ["get_state"] : [];
          const transportFailures: Array<{
            readonly type: RpcCommand["type"];
            readonly code: string;
          }> = forSpawn(options.initialTransportFailures);
          const ipcFailures: string[] = [];
          let rejectedParentReplies = 0;
          if (remainingInitialStateDrops > 0) remainingInitialStateDrops -= 1;
          const sendGates: Array<{
            readonly type: RpcCommand["type"];
            readonly gate: Deferred.Deferred<void, never>;
          }> = forSpawn(options.initialSendGates);
          const ipcGates: Array<{
            readonly type: LocalPiParentControl["type"] | undefined;
            readonly gate: Deferred.Deferred<void, never>;
          }> = [];
          const earlyIpcAcks: AcknowledgedIpcControlType[] = [];
          const beforeResponses: Array<{
            readonly type: RpcCommand["type"];
            readonly value: unknown;
          }> = [];

          const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
          let cost = 0;
          const usageToken = Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));
          // Malformed per-message usage fails the whole decode, so it is never accounted.
          const persistedMessage = Schema.Struct({
            type: Schema.Literal("message_end"),
            message: Schema.Struct({
              role: Schema.Literals(["assistant", "toolResult"]),
              usage: Schema.optional(
                Schema.Struct({
                  input: Schema.optional(usageToken),
                  output: Schema.optional(usageToken),
                  cacheRead: Schema.optional(usageToken),
                  cacheWrite: Schema.optional(usageToken),
                  totalTokens: Schema.optional(usageToken),
                  cost: Schema.optional(
                    Schema.Struct({
                      total: Schema.optional(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
                    }),
                  ),
                }),
              ),
            }),
          });
          const offer = (value: RpcWireValue) => {
            // Persist accounting when the fixture emits a completed message, never on a stats read.
            const message = Schema.decodeUnknownOption(persistedMessage)(value);
            const usage = message._tag === "Some" ? message.value.message.usage : undefined;
            if (usage) {
              tokens.input += usage.input ?? 0;
              tokens.output += usage.output ?? 0;
              tokens.cacheRead += usage.cacheRead ?? 0;
              tokens.cacheWrite += usage.cacheWrite ?? 0;
              tokens.total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
              cost += usage.cost?.total ?? 0;
            }
            return Queue.offerUnsafe(events, { type: "rpc_message", value });
          };
          const offerIpc = (value: IpcWireValue) =>
            Queue.offerUnsafe(events, { type: "parent_contact", value });
          const emitNormalIpcAck = (message: LocalPiParentControl) => {
            if (message.type === "parent_reply") {
              const ok = rejectedParentReplies === 0;
              if (!ok) rejectedParentReplies -= 1;
              offerIpc({
                channel: "pi-subagents",
                type: "parent_reply_ack",
                requestId: message.ackId,
                ok,
              });
            }
            if (message.type === "proxy_notification")
              offerIpc({
                channel: "pi-subagents",
                type: "proxy_notification_ack",
                requestId: message.requestId,
                ok: true,
              });
            if (message.type === "turn_input_barrier")
              offerIpc({
                channel: "pi-subagents",
                type: "turn_input_barrier_ack",
                requestId: message.requestId,
              });
          };
          const offerProtocolError = (message: string) =>
            Queue.offerUnsafe(events, { type: "protocol_error", message });
          const exit = (exitCode: number | null = 0) => {
            Queue.endUnsafe(events);
            Deferred.doneUnsafe(exited, Effect.succeed({ type: "exit", exitCode, stderr: "" }));
          };
          const failExit = (message: string) => {
            Queue.endUnsafe(events);
            Deferred.doneUnsafe(
              exited,
              Effect.fail(new SubagentProcessError({ operation: "await exit from", message })),
            );
          };
          const handle: ChildProcessHandle = {
            pid: 10_000 + controls.length,
            events,
            awaitExit: Deferred.await(exited),
            send: (command) =>
              Effect.gen(function* () {
                commands.push(command);
                const forCommand = (entry: { readonly type: RpcCommand["type"] }) =>
                  entry.type === command.type;
                const gate = takeFirst(sendGates, forCommand)?.gate;
                if (gate) yield* Deferred.await(gate);
                const transportFailure = takeFirst(transportFailures, forCommand);
                if (transportFailure)
                  return yield* new SubagentProcessError({
                    operation: "send RPC command to",
                    code: transportFailure.code,
                    message: "Fixture transport outcome.",
                  });
                const before = takeFirst(beforeResponses, forCommand);
                if (before) offer(before.value);
                if (takeFirst(dropped, (type) => type === command.type) !== undefined) return;
                const failure = takeFirst(failures, forCommand);
                offer(
                  failure
                    ? {
                        type: "response",
                        id: command.id,
                        command: command.type,
                        success: false,
                        error: failure.error,
                      }
                    : {
                        type: "response",
                        id: command.id,
                        command: command.type,
                        success: true,
                        data:
                          command.type === "get_state"
                            ? stateData
                            : command.type === "get_session_stats"
                              ? { tokens: { ...tokens }, cost }
                              : undefined,
                      },
                );
              }),
            sendContactControl: (message) =>
              Effect.gen(function* () {
                // Model Node child.send handing the envelope to the child before
                // its acknowledgement callback settles.
                ipc.push(message);
                const ipcFailure = ipcFailures.shift();
                if (ipcFailure)
                  return yield* new SubagentProcessError({
                    operation: "send IPC message to",
                    code: ipcFailure,
                    message: "Fixture IPC outcome.",
                  });
                const ackBeforeSendSettles =
                  takeFirst(earlyIpcAcks, (type) => type === message.type) !== undefined;
                if (ackBeforeSendSettles) emitNormalIpcAck(message);
                const gate = takeFirst(
                  ipcGates,
                  (candidate) => candidate.type === undefined || candidate.type === message.type,
                )?.gate;
                if (gate) yield* Deferred.await(gate);
                if (!ackBeforeSendSettles) emitNormalIpcAck(message);
              }),
            terminate: (mode) => Effect.sync(() => void terminations.push(mode)),
          };
          controls.push({
            launch,
            commands,
            ipc,
            terminations,
            released: () => releaseCount,
            sent: (type) => commands.some((command) => command.type === type),
            sentIpc: (type, matches = () => true) => ipc.filter(isIpcControl(type)).some(matches),
            commandTypes: (...only) =>
              commands
                .map((command) => command.type)
                .filter((type) => only.length === 0 || only.includes(type)),
            settle: (text = "Assignment complete.") => {
              offer(assistantMessageEndFrame(text));
              offer({ type: "agent_settled" });
            },
            failNext: (type, error) => void failures.push({ type, error }),
            failTransportNext: (type, code) => void transportFailures.push({ type, code }),
            failNextIpc: (code) => void ipcFailures.push(code),
            rejectNextParentReply: () => void (rejectedParentReplies += 1),
            dropNext: (type) => void dropped.push(type),
            gateNextSend: (type, gate) => void sendGates.push({ type, gate }),
            gateNextIpc: (gate) => void ipcGates.push({ type: undefined, gate }),
            gateNextIpcType: (type, gate) => void ipcGates.push({ type, gate }),
            ackNextIpcBeforeSendSettles: (type) => void earlyIpcAcks.push(type),
            gateRelease: (gate) => void (releaseGate = gate),
            beforeNextResponse: (type, value) => void beforeResponses.push({ type, value }),
            offer,
            offerIpc,
            offerProtocolError,
            exit,
            failExit,
          });
          return {
            handle,
            release: Effect.gen(function* () {
              if (releaseGate) yield* Deferred.await(releaseGate);
              releaseCount += 1;
              options.onRelease?.(spawnIndex);
              Queue.endUnsafe(events);
              if (options.releaseDefect) return yield* Effect.die("fixture release defect");
            }),
          };
        }),
        ({ release }) => release,
      ).pipe(Effect.map(({ handle }) => handle)),
  });
  return { controls, reclaimedRunIds, layer };
}

export const profileLayerFor = <Global>(global: Global) =>
  Layer.effect(
    SubagentProfileService,
    makeSubagentProfileService(
      resolveSubagentConfig({
        globalConfigPath: "/agent/pi-subagents.json",
        projectConfigPath: "/project/.pi/pi-subagents.json",
        projectTrusted: true,
        global: decodeSubagentConfig(global),
      }),
    ),
  );

/** Calls the writer-lease fake received, counted before any injected failure. */
export interface WriterLeaseCounts {
  canonicalize: number;
  acquire: number;
  mark: number;
  release: number;
}

export const leaseCounts = (): WriterLeaseCounts => ({
  canonicalize: 0,
  acquire: 0,
  mark: 0,
  release: 0,
});

export function fakeWriterLeaseLayer(
  options: {
    readonly counts?: WriterLeaseCounts | undefined;
    readonly platform?: NodeJS.Platform | undefined;
    readonly canonicalize?: ((cwd: string) => string) | undefined;
    readonly filesystemIdentity?: ((cwd: string, canonicalPath: string) => string) | undefined;
    readonly onCanonicalize?: ((cwd: string) => void) | undefined;
    readonly failCanonicalization?: boolean | undefined;
    readonly onAcquireStarted?: (() => void) | undefined;
    readonly onAcquire?: ((lease: WriterLease) => void) | undefined;
    readonly acquireGate?: Deferred.Deferred<void, never> | undefined;
    readonly acquireUninterruptible?: boolean | undefined;
    readonly failAcquire?: boolean | undefined;
    readonly onMark?: ((lease: WriterLease) => void) | undefined;
    readonly failMark?: boolean | undefined;
    readonly onRelease?: ((lease: WriterLease) => void) | undefined;
    readonly failRelease?: boolean | undefined;
  } = {},
) {
  let nextIdentity = 1;
  let remainingAcquireFailures = options.failAcquire ? 1 : 0;
  const identityDigests = new Map<string, string>();
  const canonicalize = options.canonicalize ?? ((cwd: string) => cwd);
  const counts = options.counts ?? leaseCounts();
  return Layer.succeed(WriterLeaseService, {
    platform: options.platform ?? "linux",
    canonicalize: (cwd) => {
      counts.canonicalize += 1;
      options.onCanonicalize?.(cwd);
      if (options.failCanonicalization)
        return Effect.fail(
          new WriterCwdCanonicalizationError({
            message: "Fixture writer cwd canonicalization failed.",
          }),
        );
      const path = canonicalize(cwd);
      const filesystemIdentity = options.filesystemIdentity?.(cwd, path) ?? `dev:1;ino:${path}`;
      let digest = identityDigests.get(filesystemIdentity);
      if (!digest) {
        digest = (nextIdentity++).toString(16).padStart(64, "0");
        identityDigests.set(filesystemIdentity, digest);
      }
      return Effect.succeed({ path, filesystemIdentity, digest });
    },
    acquire: ({ cwd, runId }) => {
      if (remainingAcquireFailures > 0) {
        remainingAcquireFailures -= 1;
        return Effect.fail(
          new WriterLeaseConflictError({
            reason: "live",
            message: "Fixture cross-process writer conflict.",
          }),
        );
      }
      const lease: WriterLease = {
        canonicalCwd: cwd.path,
        filesystemIdentityDigest: cwd.digest,
        runId,
      };
      const acquire = Effect.gen(function* () {
        options.onAcquireStarted?.();
        if (options.acquireGate) yield* Deferred.await(options.acquireGate);
        counts.acquire += 1;
        options.onAcquire?.(lease);
        return lease;
      });
      return options.acquireUninterruptible
        ? acquire.pipe(Effect.uninterruptible)
        : acquire.pipe(Effect.interruptible);
    },
    markSpawnStarted: (lease) =>
      Effect.gen(function* () {
        counts.mark += 1;
        options.onMark?.(lease);
        if (options.failMark)
          return yield* new WriterLeaseMarkError({
            message: "Fixture spawn-started mark failed ambiguously.",
          });
        return lease;
      }),
    release: (lease) => {
      counts.release += 1;
      options.onRelease?.(lease);
      return options.failRelease
        ? Effect.fail(
            new WriterLeaseReleaseError({
              message: "Fixture writer-lease release could not be confirmed.",
            }),
          )
        : Effect.void;
    },
  });
}

export const localPiBackendRegistryLayer = Layer.effect(
  SubagentBackendRegistry,
  ChildProcess.use((childProcesses) =>
    Effect.succeed(makeSubagentBackendRegistry([makeLocalPiBackendDriver(childProcesses)])),
  ),
);

const layerOver = <R>(
  registry: Layer.Layer<SubagentBackendRegistry, never, R>,
  options: SubagentServiceOptions,
  profiles = profileLayerFor({}),
  writerLeases: Layer.Layer<WriterLeaseService> = fakeWriterLeaseLayer(),
) =>
  SubagentService["layer"]({ writerWorkspaceMode: "shared-checkout", ...options }).pipe(
    Layer.provide(Layer.merge(registry, writerLeases)),
    Layer.provideMerge(profiles),
  );

export const serviceLayer = (
  options: SubagentServiceOptions = {},
  profiles?: ReturnType<typeof profileLayerFor>,
  writerLeases?: Layer.Layer<WriterLeaseService>,
) => layerOver(localPiBackendRegistryLayer, options, profiles, writerLeases);

export interface FakeRetainedControl {
  readonly prompts: string[];
  readonly assignmentEpochs: number[];
  readonly terminations: Array<"graceful" | "force">;
  readonly gateNextStart: (gate: Deferred.Deferred<void, never>) => void;
  readonly failNextStart: (code?: string) => void;
  readonly offer: (
    event: BackendEvent | ({ readonly type: "report" } & Omit<BackendReport, "assignmentEpoch">),
  ) => void;
  /** Offers a report frame for the current assignment epoch. */
  readonly report: (
    runId: string,
    sequence: number,
    deliveryId: string,
    text: string,
    extra?: { readonly evidence?: string },
  ) => void;
  readonly released: () => number;
}

export function fakeRetainedBackendLayer(
  options: {
    readonly initialStartGate?: Deferred.Deferred<void, never> | undefined;
    readonly interruptGate?: Deferred.Deferred<void, never> | undefined;
    readonly onInterruptStarted?: (() => void) | undefined;
    readonly capabilities?: BackendDriver["capabilities"] | undefined;
  } = {},
) {
  const controls: FakeRetainedControl[] = [];
  const driver: BackendDriver = {
    host: "herdr",
    runtime: "claude",
    capabilities: options.capabilities ?? ["steer", "rename-display"],
    supportsContext: (context) => context === "fresh",
    preflight: () => Effect.void,
    spawn: () =>
      Effect.acquireRelease(
        Effect.gen(function* () {
          const events = yield* Queue.unbounded<BackendEvent, Cause.Done>();
          const prompts: string[] = [];
          const assignmentEpochs: number[] = [];
          const terminations: Array<"graceful" | "force"> = [];
          const startGates: Array<Deferred.Deferred<void, never>> = options.initialStartGate
            ? [options.initialStartGate]
            : [];
          const startFailures: Array<string | undefined> = [];
          let releaseCount = 0;
          let assignmentEpoch = 0;
          const offer: FakeRetainedControl["offer"] = (event) => {
            // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
            const normalized: BackendEvent =
              event.type === "report" && !("assignmentEpoch" in event)
                ? { ...event, assignmentEpoch }
                : (event as BackendEvent);
            Queue.offerUnsafe(events, normalized);
          };
          const control: FakeRetainedControl = {
            prompts,
            assignmentEpochs,
            terminations,
            gateNextStart: (gate) => void startGates.push(gate),
            failNextStart: (code) => void startFailures.push(code),
            offer,
            report: (runId, sequence, deliveryId, text, extra) =>
              offer({ type: "report", runId, sequence, deliveryId, text, ...extra }),
            released: () => releaseCount,
          };
          controls.push(control);
          return {
            handle: {
              pid: 22_001,
              events,
              awaitExit: Effect.never,
              controls: {
                initialize: Effect.succeed({
                  model: "claude-retained",
                  effort: "high" as const,
                  sessionId: "retained-session",
                }),
                start: (message: string, nextAssignmentEpoch: number) =>
                  Effect.gen(function* () {
                    assignmentEpoch = nextAssignmentEpoch;
                    assignmentEpochs.push(nextAssignmentEpoch);
                    prompts.push(message);
                    const gate = startGates.shift();
                    if (gate) yield* Deferred.await(gate);
                    if (startFailures.length > 0) {
                      const code = startFailures.shift();
                      const failure = {
                        operation: "start assignment in",
                        message: "Fixture retained start failure.",
                      };
                      return yield* new SubagentProcessError(code ? { ...failure, code } : failure);
                    }
                  }),
                steer: (message: string) =>
                  Effect.sync(() => void prompts.push(`steer:${message}`)),
                interrupt: Effect.sync(() => options.onInterruptStarted?.()).pipe(
                  Effect.andThen(
                    options.interruptGate ? Deferred.await(options.interruptGate) : Effect.void,
                  ),
                ),
                renameDisplay: () => Effect.void,
                reply: () => Effect.void,
                notifyPeers: () => Effect.void,
              },
              acknowledge: () => {},
              terminate: (mode: "graceful" | "force") =>
                Effect.sync(() => void terminations.push(mode)),
              cancelPending: () => {},
            },
            release: Effect.sync(() => {
              releaseCount += 1;
              Queue.endUnsafe(events);
            }),
          };
        }),
        ({ release }) => release,
      ).pipe(Effect.map(({ handle }) => handle)),
  };
  return {
    controls,
    layer: Layer.succeed(SubagentBackendRegistry, makeSubagentBackendRegistry([driver])),
  };
}

/** Options that record every projection and notification while keeping the caller's policies. */
const capturing = (options: SubagentServiceOptions) => {
  const projections: SubagentProjection[] = [];
  const notifications: SubagentNotification[] = [];
  const captured: SubagentServiceOptions = {
    publish: (projection) => void projections.push(projection),
    ...options,
    notify: (notification) => {
      notifications.push(notification);
      return options.notify?.(notification);
    },
  };
  return { projections, notifications, options: captured };
};

export function localServiceFixture(
  options: SubagentServiceOptions = {},
  fake = fakeChildLayer(),
  profiles = profileLayerFor({}),
  writerLeases = fakeWriterLeaseLayer(),
) {
  const { projections, notifications, options: captured } = capturing(options);
  const layer = serviceLayer(captured, profiles, writerLeases).pipe(Layer.provide(fake.layer));
  return { fake, projections, notifications, layer };
}

export function retainedServiceFixture(
  backend = fakeRetainedBackendLayer(),
  options: SubagentServiceOptions = {},
) {
  const { projections, notifications, options: captured } = capturing(options);
  const layer = layerOver(backend.layer, captured);
  return { backend, projections, notifications, layer };
}

export const retainedReportFrame = (
  runId: string,
  assignmentEpoch: number,
  sequence: number,
  deliveryId: string,
  text: string,
): Extract<BackendEvent, { readonly type: "report" }> => ({
  type: "report",
  runId,
  assignmentEpoch,
  sequence,
  deliveryId,
  text,
});

export const assistantMessageEndFrame = (text: string) =>
  ({
    type: "message_end",
    message: {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text }],
    },
  }) as const;

export const contactParentFrame = (
  requestId: string,
  kind: "progress" | "warning" | "question",
  message: string,
): IpcWireValue => ({ channel: "pi-subagents", type: "contact_parent", requestId, kind, message });

export const request = (overrides: Partial<StartSubagentRequest> = {}): StartSubagentRequest => ({
  host: "local",
  runtime: "pi",
  closeOnReport: true,
  task: "Inspect authentication",
  cwd: "/project",
  context: "fresh",
  writeIntent: "read-only",
  openaiFastMode: false,
  model: "openai-codex/gpt-5.6-sol",
  effort: "high",
  effortWasExplicit: true,
  activeTools: ["read", "bash", "edit", "write"],
  projectTrusted: true,
  parentSessionId: "parent-session",
  parentSessionFile: "/tmp/parent.jsonl",
  parentLeafId: "parent-leaf",
  ...overrides,
});

export const retainedRequest = (overrides: Partial<StartSubagentRequest> = {}) =>
  request({
    host: "herdr",
    runtime: "claude",
    closeOnReport: false,
    model: "claude-retained",
    effortWasExplicit: false,
    ...overrides,
  });
