// Explicit test entry-point Layer provision owns each scoped service runtime.
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
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
import type { StartSubagentRequest } from "../../../src/run/model.ts";
import { SubagentService, type SubagentServiceOptions } from "../../../src/run/service.ts";

type RpcWireValue = Extract<ChildWireEvent, { readonly type: "rpc_message" }>["value"];
type IpcWireValue = Extract<ChildWireEvent, { readonly type: "parent_contact" }>["value"];

export interface FakeChildControl {
  readonly launch: ChildLaunchRequest;
  readonly commands: RpcCommand[];
  readonly ipc: LocalPiParentControl[];
  readonly terminations: Array<"graceful" | "force">;
  readonly released: () => number;
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
  readonly gateRelease: (gate: Deferred.Deferred<void, never>) => void;
  readonly beforeNextResponse: (type: RpcCommand["type"], value: RpcWireValue) => void;
  readonly offer: (value: RpcWireValue) => void;
  readonly offerIpc: (value: IpcWireValue) => void;
  readonly offerProtocolError: (message: string) => void;
  readonly exit: (exitCode?: number | null) => void;
  readonly failExit: (message: string) => void;
}

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
          const failures: Array<{ readonly type: RpcCommand["type"]; readonly error: string }> = (
            options.initialFailures ?? []
          )
            .filter((failure) => failure.spawnIndex === spawnIndex)
            .map(({ type, error }) => ({ type, error }));
          const dropped: RpcCommand["type"][] = remainingInitialStateDrops > 0 ? ["get_state"] : [];
          const transportFailures: Array<{
            readonly type: RpcCommand["type"];
            readonly code: string;
          }> = (options.initialTransportFailures ?? [])
            .filter((failure) => failure.spawnIndex === spawnIndex)
            .map(({ type, code }) => ({ type, code }));
          const ipcFailures: string[] = [];
          let rejectedParentReplies = 0;
          if (remainingInitialStateDrops > 0) remainingInitialStateDrops -= 1;
          const sendGates: Array<{
            readonly type: RpcCommand["type"];
            readonly gate: Deferred.Deferred<void, never>;
          }> = (options.initialSendGates ?? [])
            .filter((candidate) => candidate.spawnIndex === spawnIndex)
            .map(({ type, gate }) => ({ type, gate }));
          const ipcGates: Array<{
            readonly type: LocalPiParentControl["type"] | undefined;
            readonly gate: Deferred.Deferred<void, never>;
          }> = [];
          const beforeResponses: Array<{
            readonly type: RpcCommand["type"];
            readonly value: unknown;
          }> = [];
          const failNext = (type: RpcCommand["type"], error: string) => {
            failures.push({ type, error });
          };
          const failTransportNext = (type: RpcCommand["type"], code: string) => {
            transportFailures.push({ type, code });
          };
          const failNextIpc = (code: string) => {
            ipcFailures.push(code);
          };
          const rejectNextParentReply = () => {
            rejectedParentReplies += 1;
          };
          const dropNext = (type: RpcCommand["type"]) => {
            dropped.push(type);
          };
          const gateNextSend = (type: RpcCommand["type"], gate: Deferred.Deferred<void, never>) => {
            sendGates.push({ type, gate });
          };
          const gateNextIpc = (gate: Deferred.Deferred<void, never>) => {
            ipcGates.push({ type: undefined, gate });
          };
          const gateNextIpcType = (
            type: LocalPiParentControl["type"],
            gate: Deferred.Deferred<void, never>,
          ) => {
            ipcGates.push({ type, gate });
          };
          const gateRelease = (gate: Deferred.Deferred<void, never>) => {
            releaseGate = gate;
          };
          const beforeNextResponse = (type: RpcCommand["type"], value: RpcWireValue) => {
            beforeResponses.push({ type, value });
          };
          const offer = (value: RpcWireValue) =>
            Queue.offerUnsafe(events, { type: "rpc_message", value });
          const offerIpc = (value: IpcWireValue) =>
            Queue.offerUnsafe(events, { type: "parent_contact", value });
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
                const gateIndex = sendGates.findIndex(
                  (candidate) => candidate.type === command.type,
                );
                const gate = gateIndex >= 0 ? sendGates.splice(gateIndex, 1)[0]?.gate : undefined;
                if (gate) yield* Deferred.await(gate);
                const transportFailureIndex = transportFailures.findIndex(
                  (candidate) => candidate.type === command.type,
                );
                const transportFailure =
                  transportFailureIndex >= 0
                    ? transportFailures.splice(transportFailureIndex, 1)[0]
                    : undefined;
                if (transportFailure)
                  return yield* new SubagentProcessError({
                    operation: "send RPC command to",
                    code: transportFailure.code,
                    message: "Fixture transport outcome.",
                  });
                const beforeIndex = beforeResponses.findIndex(
                  (candidate) => candidate.type === command.type,
                );
                const before =
                  beforeIndex >= 0 ? beforeResponses.splice(beforeIndex, 1)[0] : undefined;
                if (before) offer(before.value);
                const droppedIndex = dropped.findIndex((type) => type === command.type);
                if (droppedIndex >= 0) {
                  dropped.splice(droppedIndex, 1);
                  return;
                }
                const failureIndex = failures.findIndex((failure) => failure.type === command.type);
                const failure = failureIndex >= 0 ? failures.splice(failureIndex, 1)[0] : undefined;
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
                            ? (() => {
                                const baseResult = { sessionId: "child-session" };
                                const withSessionFile = options.omitSessionFile
                                  ? baseResult
                                  : {
                                      ...baseResult,
                                      sessionFile: "/tmp/child-session.jsonl",
                                    };
                                const withThinkingLevelAndAdditionalFields = {
                                  ...withSessionFile,
                                  thinkingLevel: options.stateThinkingLevel ?? "high",
                                  model: {
                                    provider: "openai-codex",
                                    id: "gpt-5.6-sol",
                                    name: "GPT 5.6 Sol",
                                    reasoning: true,
                                  },
                                  isStreaming: false,
                                  isCompacting: false,
                                  steeringMode: "all",
                                  followUpMode: "all",
                                  autoCompactionEnabled: true,
                                  messageCount: 0,
                                  pendingMessageCount: 0,
                                };
                                return withThinkingLevelAndAdditionalFields;
                              })()
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
                const gateIndex = ipcGates.findIndex(
                  (candidate) => candidate.type === undefined || candidate.type === message.type,
                );
                const gate = gateIndex >= 0 ? ipcGates.splice(gateIndex, 1)[0]?.gate : undefined;
                if (gate) yield* Deferred.await(gate);
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
              }),
            terminate: (mode) => Effect.sync(() => void terminations.push(mode)),
          };
          controls.push({
            launch,
            commands,
            ipc,
            terminations,
            released: () => releaseCount,
            failNext,
            failTransportNext,
            failNextIpc,
            rejectNextParentReply,
            dropNext,
            gateNextSend,
            gateNextIpc,
            gateNextIpcType,
            gateRelease,
            beforeNextResponse,
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
        globalConfigExists: true,
        projectConfigExists: false,
        global: decodeSubagentConfig(global),
      }),
    ),
  );

export function fakeWriterLeaseLayer(
  options: {
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
    readonly markGate?: Deferred.Deferred<void, never> | undefined;
    readonly failMark?: boolean | undefined;
    readonly onRelease?: ((lease: WriterLease) => void) | undefined;
    readonly failRelease?: boolean | undefined;
  } = {},
) {
  let ordinal = 0;
  let nextIdentity = 1;
  let remainingAcquireFailures = options.failAcquire ? 1 : 0;
  const identityDigests = new Map<string, string>();
  const canonicalize = options.canonicalize ?? ((cwd: string) => cwd);
  return Layer.succeed(WriterLeaseService, {
    platform: options.platform ?? "linux",
    canonicalize: (cwd) => {
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
    acquire: ({ cwd, sessionId, runId }) => {
      if (remainingAcquireFailures > 0) {
        remainingAcquireFailures -= 1;
        return Effect.fail(
          new WriterLeaseConflictError({
            reason: "live",
            message: "Fixture cross-process writer conflict.",
            ownerPid: 99,
            ownerSessionId: "other-session",
            ownerRunId: "other-run",
          }),
        );
      }
      const ownershipToken = (++ordinal).toString(16).padStart(64, "0");
      const lease: WriterLease = {
        canonicalCwd: cwd.path,
        filesystemIdentityDigest: cwd.digest,
        leasePath: `/private-agent/writer-leases-v2/${cwd.digest}.lease`,
        ownershipToken,
        evidence: {
          version: 2,
          phase: "reserved",
          ownershipToken,
          filesystemIdentityDigest: cwd.digest,
          parentPid: 1,
          parentProcessStartedAtMillis: 1,
          ownerNonce: "d".repeat(64),
          sessionId,
          runId,
          acquiredAtMillis: ordinal,
        },
      };
      const acquire = Effect.gen(function* () {
        options.onAcquireStarted?.();
        if (options.acquireGate) yield* Deferred.await(options.acquireGate);
        options.onAcquire?.(lease);
        return lease;
      });
      return options.acquireUninterruptible
        ? acquire.pipe(Effect.uninterruptible)
        : acquire.pipe(Effect.interruptible);
    },
    markSpawnStarted: (lease) =>
      Effect.gen(function* () {
        if (options.markGate) yield* Deferred.await(options.markGate);
        options.onMark?.(lease);
        if (options.failMark)
          return yield* new WriterLeaseMarkError({
            message: "Fixture spawn-started mark failed ambiguously.",
          });
        return {
          ...lease,
          evidence: { ...lease.evidence, phase: "spawn-started", spawnStartedAtMillis: ordinal },
        };
      }),
    release: (lease) => {
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

export const serviceLayer = (
  options: SubagentServiceOptions = {},
  profiles = profileLayerFor({}),
  writerLeases: Layer.Layer<WriterLeaseService> = fakeWriterLeaseLayer(),
) =>
  SubagentService["layer"](options).pipe(
    Layer.provide(Layer.merge(localPiBackendRegistryLayer, writerLeases)),
    Layer.provideMerge(profiles),
  );

export interface FakeRetainedControl {
  readonly prompts: string[];
  readonly assignmentEpochs: number[];
  readonly terminations: Array<"graceful" | "force">;
  readonly gateNextStart: (gate: Deferred.Deferred<void, never>) => void;
  readonly failNextStart: (code?: string) => void;
  readonly offer: (
    event: BackendEvent | ({ readonly type: "report" } & Omit<BackendReport, "assignmentEpoch">),
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
          const control: FakeRetainedControl = {
            prompts,
            assignmentEpochs,
            terminations,
            gateNextStart: (gate) => void startGates.push(gate),
            failNextStart: (code) => void startFailures.push(code),
            offer: (event) => {
              // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
              const normalized: BackendEvent =
                event.type === "report" && !("assignmentEpoch" in event)
                  ? { ...event, assignmentEpoch }
                  : (event as BackendEvent);
              Queue.offerUnsafe(events, normalized);
            },
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
                      return yield* new SubagentProcessError(
                        (() => {
                          const baseResult = { operation: "start assignment in" };
                          const withCode = code ? { ...baseResult, code } : baseResult;
                          const withMessage = {
                            ...withCode,
                            message: "Fixture retained start failure.",
                          };
                          return withMessage;
                        })(),
                      );
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

export const retainedServiceLayer = (
  backend: ReturnType<typeof fakeRetainedBackendLayer>,
  options: SubagentServiceOptions = {},
) =>
  SubagentService["layer"](options).pipe(
    Layer.provide(Layer.merge(backend.layer, fakeWriterLeaseLayer())),
    Layer.provideMerge(profileLayerFor({})),
  );

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
