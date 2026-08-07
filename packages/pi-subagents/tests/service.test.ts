// Explicit test entry-point Layer provision owns each scoped service runtime.
// @effect-diagnostics effect/strictEffectProvide:off
// @effect-diagnostics effect/nodeBuiltinImport:off
import { setImmediate as scheduleImmediate } from "node:timers";
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import { makeLocalPiBackendDriver } from "../src/backend/local-pi.ts";
import type { BackendDriver, BackendEvent, BackendReport } from "../src/backend/model.ts";
import { makeSubagentBackendRegistry, SubagentBackendRegistry } from "../src/backend/service.ts";
import type { SubagentNotification } from "../src/boundary/host-notifier.ts";
import {
  WriterCwdCanonicalizationError,
  WriterLeaseConflictError,
  WriterLeaseMarkError,
  WriterLeaseReleaseError,
  WriterLeaseService,
  type WriterLease,
} from "../src/boundary/writer-lease.ts";
import { resolveSubagentConfig } from "../src/config/options.ts";
import { decodeSubagentConfig } from "../src/config/schema.ts";
import { makeSubagentProfileService, SubagentProfileService } from "../src/profiles/service.ts";
import type { ParentReply, PeerNotice, RpcCommand } from "../src/backend/local-pi-protocol.ts";
import {
  ChildProcess,
  type ChildLaunchRequest,
  type ChildProcessHandle,
  type ChildWireEvent,
} from "../src/boundary/child-process.ts";
import { SubagentProcessError } from "../src/run/errors.ts";
import type {
  StartSubagentRequest,
  SubagentProjection,
  SubagentRunView,
} from "../src/run/model.ts";
import { SubagentService, type SubagentServiceOptions } from "../src/run/service.ts";
import { yieldUntil } from "pi-cosmic-core/testing";

interface FakeChildControl {
  readonly launch: ChildLaunchRequest;
  readonly commands: RpcCommand[];
  readonly ipc: Array<ParentReply | PeerNotice>;
  readonly terminations: Array<"graceful" | "force">;
  readonly released: () => number;
  readonly failNext: (type: RpcCommand["type"], error: string) => void;
  readonly failTransportNext: (type: RpcCommand["type"], code: string) => void;
  readonly failNextIpc: (code: string) => void;
  readonly dropNext: (type: RpcCommand["type"]) => void;
  readonly gateNextSend: (type: RpcCommand["type"], gate: Deferred.Deferred<void, never>) => void;
  readonly gateNextIpc: (gate: Deferred.Deferred<void, never>) => void;
  readonly gateRelease: (gate: Deferred.Deferred<void, never>) => void;
  readonly beforeNextResponse: (type: RpcCommand["type"], value: unknown) => void;
  readonly offer: (value: unknown) => void;
  readonly offerIpc: (value: unknown) => void;
  readonly exit: (exitCode?: number | null) => void;
  readonly failExit: (message: string) => void;
}

function fakeChildLayer(
  beforeSpawn: Effect.Effect<void, never, never> = Effect.void,
  options: {
    readonly dropInitialState?: boolean;
    readonly releaseDefect?: boolean;
    readonly omitSessionFile?: boolean;
    readonly stateThinkingLevel?: string;
    readonly onRelease?: ((spawnIndex: number) => void) | undefined;
    readonly failReclaim?: boolean | undefined;
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
          const ipc: Array<ParentReply | PeerNotice> = [];
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
          if (remainingInitialStateDrops > 0) remainingInitialStateDrops -= 1;
          const sendGates: Array<{
            readonly type: RpcCommand["type"];
            readonly gate: Deferred.Deferred<void, never>;
          }> = [];
          const ipcGates: Array<Deferred.Deferred<void, never>> = [];
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
          const dropNext = (type: RpcCommand["type"]) => {
            dropped.push(type);
          };
          const gateNextSend = (type: RpcCommand["type"], gate: Deferred.Deferred<void, never>) => {
            sendGates.push({ type, gate });
          };
          const gateNextIpc = (gate: Deferred.Deferred<void, never>) => {
            ipcGates.push(gate);
          };
          const gateRelease = (gate: Deferred.Deferred<void, never>) => {
            releaseGate = gate;
          };
          const beforeNextResponse = (type: RpcCommand["type"], value: unknown) => {
            beforeResponses.push({ type, value });
          };
          const offer = (value: unknown) =>
            Queue.offerUnsafe(events, { type: "rpc_message", value });
          const offerIpc = (value: unknown) =>
            Queue.offerUnsafe(events, { type: "ipc_message", value });
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
                            ? {
                                sessionId: "child-session",
                                ...(options.omitSessionFile
                                  ? {}
                                  : { sessionFile: "/tmp/child-session.jsonl" }),
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
                              }
                            : undefined,
                      },
                );
              }),
            sendIpc: (message) =>
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
                const gate = ipcGates.shift();
                if (gate) yield* Deferred.await(gate);
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
            dropNext,
            gateNextSend,
            gateNextIpc,
            gateRelease,
            beforeNextResponse,
            offer,
            offerIpc,
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

const profileLayerFor = (global: unknown) =>
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

function fakeWriterLeaseLayer(
  options: {
    readonly platform?: NodeJS.Platform | undefined;
    readonly canonicalize?: ((cwd: string) => string) | undefined;
    readonly filesystemIdentity?: ((cwd: string, canonicalPath: string) => string) | undefined;
    readonly onCanonicalize?: ((cwd: string) => void) | undefined;
    readonly failCanonicalization?: boolean | undefined;
    readonly onAcquireStarted?: (() => void) | undefined;
    readonly onAcquire?: ((lease: WriterLease) => void) | undefined;
    readonly acquireGate?: Deferred.Deferred<void, never> | undefined;
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
      return Effect.gen(function* () {
        options.onAcquireStarted?.();
        if (options.acquireGate) yield* Deferred.await(options.acquireGate);
        options.onAcquire?.(lease);
        return lease;
      });
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

const localPiBackendRegistryLayer = Layer.effect(
  SubagentBackendRegistry,
  ChildProcess.use((childProcesses) =>
    Effect.succeed(makeSubagentBackendRegistry([makeLocalPiBackendDriver(childProcesses)])),
  ),
);

const serviceLayer = (
  options: SubagentServiceOptions = {},
  profiles = profileLayerFor({}),
  writerLeases: Layer.Layer<WriterLeaseService> = fakeWriterLeaseLayer(),
) =>
  SubagentService["layer"](options).pipe(
    Layer.provide(Layer.merge(localPiBackendRegistryLayer, writerLeases)),
    Layer.provideMerge(profiles),
  );

interface FakeRetainedControl {
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

function fakeRetainedBackendLayer(
  options: {
    readonly initialStartGate?: Deferred.Deferred<void, never> | undefined;
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
                      return yield* new SubagentProcessError({
                        operation: "start assignment in",
                        ...(code ? { code } : {}),
                        message: "Fixture retained start failure.",
                      });
                    }
                  }),
                steer: (message: string) =>
                  Effect.sync(() => void prompts.push(`steer:${message}`)),
                interrupt: Effect.void,
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

const retainedServiceLayer = (
  backend: ReturnType<typeof fakeRetainedBackendLayer>,
  options: SubagentServiceOptions = {},
) =>
  SubagentService["layer"](options).pipe(
    Layer.provide(Layer.merge(backend.layer, fakeWriterLeaseLayer())),
    Layer.provideMerge(profileLayerFor({})),
  );

const request = (overrides: Partial<StartSubagentRequest> = {}): StartSubagentRequest => ({
  host: "local",
  runtime: "pi",
  closeOnReport: true,
  task: "Inspect authentication",
  cwd: "/project",
  context: "fresh",
  writeIntent: "read-only",
  fastMode: false,
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

describe("SubagentService", () => {
  it.effect("namespaces run IDs across runtime replacement and rejects stale IDs", () =>
    Effect.gen(function* () {
      const firstFake = fakeChildLayer();
      const firstLayer = serviceLayer().pipe(Layer.provide(firstFake.layer));
      const first = yield* SubagentService.use((service) => service.start(request())).pipe(
        Effect.scoped,
        Effect.provide(firstLayer),
      );

      const secondFake = fakeChildLayer();
      const secondLayer = serviceLayer().pipe(Layer.provide(secondFake.layer));
      const result = yield* Effect.gen(function* () {
        const service = yield* SubagentService;
        const second = yield* service.start(request());
        const stale = yield* service.status(first.id).pipe(Effect.flip);
        return { second, stale };
      }).pipe(Effect.scoped, Effect.provide(secondLayer));

      expect(first.id).toMatch(/^agent-r[0-9a-z]+-1$/);
      expect(result.second.id).toMatch(/^agent-r[0-9a-z]+-1$/);
      expect(result.second.id).not.toBe(first.id);
      expect(result.stale).toMatchObject({ _tag: "SubagentNotFoundError", id: first.id });
    }),
  );

  it.effect("allocates concurrent unnamed IDs, ordinals, and fallback names atomically", () => {
    const fake = fakeChildLayer();
    const layer = serviceLayer().pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const runs = yield* Effect.all(
        Array.from({ length: 12 }, () => service.start(request({ name: undefined }))),
        { concurrency: "unbounded" },
      );
      expect(new Set(runs.map((run) => run.id)).size).toBe(12);
      expect(new Set(runs.map((run) => run.name)).size).toBe(12);
      for (const run of runs) {
        const ordinal = run.id.slice(run.id.lastIndexOf("-") + 1);
        expect(run.name).toBe(`subagent-${ordinal}`);
      }
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("rejects an unsupported backend before reserving or spawning a run", () => {
    const fake = fakeChildLayer();
    const layer = serviceLayer().pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const failure = yield* Effect.flip(
        service.start(request({ host: "herdr", runtime: "claude" })),
      );
      expect(failure).toMatchObject({
        _tag: "InvalidSubagentRequestError",
        code: "backend_not_implemented",
      });
      expect(fake.controls).toHaveLength(0);
      expect(yield* service.list).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("injects profile guidance and retains selection provenance", () => {
    const fake = fakeChildLayer();
    const layer = serviceLayer().pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const started = yield* service.start(
        request({
          profile: "reviewer",
          profileGuidance: "Act as an independent reviewer.",
          selection: {
            source: "profile-parent-candidate",
            reason: "Profile reviewer explicitly fell back to the parent model.",
            skippedCandidates: [],
          },
        }),
      );
      expect(started).toMatchObject({
        profile: "reviewer",
        selection: { source: "profile-parent-candidate" },
      });
      expect(fake.controls[0]?.launch.systemPrompt).toContain("assigned profile is reviewer");
      expect(fake.controls[0]?.launch.systemPrompt).toContain("independent reviewer");
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("preserves selected fork context through run state and child launch", () => {
    const fake = fakeChildLayer();
    const layer = serviceLayer().pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const started = yield* service.start(
        request({ context: "fork", profile: "oracle", name: "forked-oracle" }),
      );
      expect(started.context).toBe("fork");
      expect(fake.controls[0]?.launch.context).toBe("fork");
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect(
    "keeps soft-effort runs alive on a non-reasoning model and reports the effective level",
    () => {
      // Models the parent's Pi child resolving to a non-reasoning model whose effective level is off.
      const fake = fakeChildLayer(Effect.void, { stateThinkingLevel: "off" });
      const layer = serviceLayer().pipe(Layer.provide(fake.layer));
      return Effect.gen(function* () {
        const service = yield* SubagentService;
        const started = yield* service.start(request({ effort: "high", effortWasExplicit: false }));
        expect(started).toMatchObject({ state: "running", effort: "off" });

        const failure = yield* Effect.flip(
          service.start(request({ effort: "high", effortWasExplicit: true })),
        );
        expect(failure._tag).toBe("InvalidSubagentRequestError");
        expect(failure.message).toContain(
          "does not support requested effort high; effective level was off",
        );
      }).pipe(Effect.scoped, Effect.provide(layer));
    },
  );

  it.effect("clears a waiting parent question when its MCP caller cancels", () => {
    const backend = fakeRetainedBackendLayer();
    const projections: SubagentProjection[] = [];
    const layer = retainedServiceLayer(backend, {
      publish: (projection) => void projections.push(projection),
    });
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.startSessionOwned(
        request({
          name: "cancelled-question",
          host: "herdr",
          runtime: "claude",
          closeOnReport: false,
          model: "claude-retained",
          effortWasExplicit: false,
        }),
      );
      backend.controls[0]?.offer({
        type: "supervisor_contact",
        assignmentEpoch: 1,
        requestId: "question-cancelled",
        kind: "question",
        message: "Should this continue?",
      });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "waiting_for_parent");
      backend.controls[0]?.offer({
        type: "supervisor_question_cancelled",
        assignmentEpoch: 1,
        requestId: "question-cancelled",
      });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "running");
      expect(yield* service.status(run.id)).toMatchObject({
        state: "running",
        question: undefined,
      });
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect(
    "keeps a report arriving during start admission queued for exact-once await delivery",
    () => {
      const report = "Report completed while prompt admission was in flight.";
      const initialStartGate = Deferred.makeUnsafe<void>();
      const backend = fakeRetainedBackendLayer({ initialStartGate });
      const projections: SubagentProjection[] = [];
      const notifications: SubagentNotification[] = [];
      const layer = retainedServiceLayer(backend, {
        notify: (notification) => void notifications.push(notification),
        publish: (projection) => void projections.push(projection),
      });
      return Effect.gen(function* () {
        const service = yield* SubagentService;
        const starting = yield* service
          .startSessionOwned(
            request({
              name: "fast-report",
              host: "herdr",
              runtime: "claude",
              closeOnReport: false,
              model: "claude-retained",
              effortWasExplicit: false,
            }),
          )
          .pipe(Effect.forkScoped);
        yield* yieldUntil(() => backend.controls[0]?.assignmentEpochs[0] === 1);
        const id = projections.at(-1)?.runs[0]?.id;
        expect(id).toBeDefined();
        backend.controls[0]?.offer({
          type: "assistant_message",
          assignmentEpoch: 1,
          text: report,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: 0,
          },
        });
        backend.controls[0]?.offer({
          type: "report",
          assignmentEpoch: 1,
          runId: id!,
          sequence: 1,
          deliveryId: "report-during-start",
          text: report,
        });
        yield* yieldUntil(() =>
          Boolean(
            projections
              .at(-1)
              ?.runs[0]?.sessionEvents.some(
                (event) => event.type === "assistant" && event.text === report,
              ),
          ),
        );
        yield* Effect.yieldNow;
        yield* Deferred.succeed(initialStartGate, undefined);

        const started = yield* Fiber.join(starting);
        expect(started.state).toBe("reported");
        expect(started).not.toHaveProperty("finalText");
        expect(started.sessionEvents).not.toEqual(
          expect.arrayContaining([expect.objectContaining({ text: report })]),
        );

        const delivered = yield* service.withAwaitTerminalObservations(
          [started.id],
          "all_finished",
          undefined,
          (observations) =>
            service
              .consumeCompletions(
                observations.flatMap((observation) =>
                  observation.completionReceipt ? [observation.completionReceipt] : [],
                ),
              )
              .pipe(Effect.as(observations)),
        );
        expect(delivered).toHaveLength(1);
        expect(delivered[0]?.run.finalText).toBe(report);
        expect(delivered[0]?.run.sessionEvents).toEqual(
          expect.arrayContaining([expect.objectContaining({ type: "assistant", text: report })]),
        );

        yield* TestClock.adjust("1 second");
        expect(notifications).toEqual([]);
        expect(yield* service.status(started.id)).not.toHaveProperty("finalText");
      }).pipe(Effect.scoped, Effect.provide(layer));
    },
  );

  it.effect("starts a child, projects completion, and retains bounded result state", () => {
    const fake = fakeChildLayer();
    const projections: SubagentProjection[] = [];
    const layer = serviceLayer({
      publish: (projection) => projections.push(projection),
    }).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const started = yield* service.start(request({ name: "auth-reader" }));
      expect(started).toMatchObject({
        name: "auth-reader",
        state: "running",
        model: "openai-codex/gpt-5.6-sol",
        sessionFile: "/tmp/child-session.jsonl",
      });
      expect(started.id).toMatch(/^agent-r[0-9a-z]+-1$/);
      expect(fake.controls[0]?.commands.map((command) => command.type)).toEqual([
        "get_state",
        "prompt",
      ]);

      fake.controls[0]?.offer({
        type: "tool_execution_start",
        toolCallId: "tool-1",
        toolName: "read",
        args: { path: "src/auth.ts" },
      });
      fake.controls[0]?.offer({
        type: "tool_execution_end",
        toolCallId: "tool-1",
        toolName: "read",
        result: { content: [{ type: "text", text: "auth source" }] },
        isError: false,
      });
      fake.controls[0]?.offer({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "Review complete." },
      });
      fake.controls[0]?.offer({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Review complete." }],
          usage: { totalTokens: 12, cost: { total: 0.001 } },
        },
      });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.usage.totalTokens === 12);
      expect((yield* service.status(started.id)).finalText).toBeUndefined();

      fake.controls[0]?.offer({ type: "agent_settled" });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "completed");

      const completed = yield* service.status(started.id);
      expect(completed.finalText).toBe("Review complete.");
      expect(completed.reportGeneration).toBe(1);
      expect(completed.usage.totalTokens).toBe(12);
      expect(completed.sessionEvents).toMatchObject([
        { type: "tool", toolName: "read", target: "src/auth.ts", state: "completed" },
        { type: "assistant", text: "Review complete." },
      ]);
      yield* yieldUntil(() => fake.controls[0]?.released() === 1);
      expect(fake.reclaimedRunIds).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("reclaims completed local Pi run state when the session scope ends", () =>
    Effect.gen(function* () {
      const fake = fakeChildLayer();
      const projections: SubagentProjection[] = [];
      const layer = serviceLayer({
        publish: (projection) => projections.push(projection),
      }).pipe(Layer.provide(fake.layer));

      const runId = yield* Effect.gen(function* () {
        const service = yield* SubagentService;
        const run = yield* service.start(request({ name: "session-reclaim" }));
        fake.controls[0]?.offer({ type: "agent_settled" });
        yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "completed");
        yield* yieldUntil(() => fake.controls[0]?.released() === 1);
        expect(fake.reclaimedRunIds).toEqual([]);
        return run.id;
      }).pipe(Effect.scoped, Effect.provide(layer));

      expect(fake.reclaimedRunIds).toEqual([runId]);
    }),
  );

  it.effect("quarantines a stopped run when private state reclamation fails", () => {
    const fake = fakeChildLayer(Effect.void, { failReclaim: true });
    const layer = serviceLayer().pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.start(request({ name: "reclaim-failure" }));
      const stopped = yield* service.stop(run.id);
      expect(stopped.state).toBe("stopped");
      expect(stopped.warning).toContain("remains quarantined");
      expect(fake.reclaimedRunIds).toEqual([run.id]);
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("starts retained follow-ups without advertising unconfirmable active steering", () => {
    const backend = fakeRetainedBackendLayer({ capabilities: ["rename-display"] });
    const projections: SubagentProjection[] = [];
    const layer = retainedServiceLayer(backend, {
      publish: (projection) => projections.push(projection),
    });
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.start(
        request({
          host: "herdr",
          runtime: "claude",
          closeOnReport: false,
          model: "claude-retained",
          effortWasExplicit: false,
        }),
      );
      const activeGuidanceFailure = yield* service
        .send(run.id, "Unconfirmed active guidance")
        .pipe(Effect.flip);
      expect(activeGuidanceFailure).toMatchObject({
        _tag: "UnsupportedSubagentCapabilityError",
        capability: "steer",
      });

      backend.controls[0]?.offer({
        type: "report",
        runId: run.id,
        sequence: 1,
        deliveryId: "retained-without-steer",
        text: "First retained report.",
      });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "reported");

      const followUp = yield* service.send(run.id, "Begin a new retained assignment.");
      expect(followUp).toMatchObject({ state: "running", reportGeneration: 1 });
      expect(backend.controls[0]?.prompts.at(-1)).toBe("Begin a new retained assignment.");
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect(
    "claims retained reports, deduplicates delivery, begins the next assignment, and notifies a cancelled await exactly once",
    () => {
      const backend = fakeRetainedBackendLayer();
      const projections: SubagentProjection[] = [];
      const notifications: SubagentNotification[] = [];
      const layer = retainedServiceLayer(backend, {
        publish: (projection) => projections.push(projection),
        notify: (notification) => void notifications.push(notification),
      });
      return Effect.gen(function* () {
        const service = yield* SubagentService;
        const run = yield* service.start(
          request({
            host: "herdr",
            runtime: "claude",
            closeOnReport: false,
            model: "claude-retained",
            effortWasExplicit: false,
          }),
        );
        expect(run).toMatchObject({ state: "running", reportGeneration: 0, pid: 22_001 });
        expect(backend.controls[0]?.prompts).toHaveLength(1);

        const firstAwait = yield* service
          .withAwaitTerminalObservations([run.id], "all_finished", undefined, (observations) =>
            service
              .consumeCompletions(
                observations.flatMap((observation) =>
                  observation.completionReceipt ? [observation.completionReceipt] : [],
                ),
              )
              .pipe(Effect.as(observations)),
          )
          .pipe(Effect.forkScoped);
        yield* Effect.yieldNow;
        backend.controls[0]?.offer({
          type: "report",
          runId: run.id,
          sequence: 1,
          deliveryId: "report-one",
          evidence: "fixture-owned-pane",
          text: "First retained report.",
        });
        const first = yield* Fiber.join(firstAwait);
        expect(first[0]).toMatchObject({
          run: {
            state: "reported",
            reportGeneration: 1,
            finalText: "First retained report.",
            pid: 22_001,
          },
          completionReceipt: {
            id: run.id,
            generation: 1,
            claimToken: expect.any(String),
          },
        });
        backend.controls[0]?.offer({
          type: "report",
          runId: run.id,
          sequence: 1,
          deliveryId: "report-one",
          text: "Duplicate must be ignored.",
        });
        yield* Effect.yieldNow;
        const redactedStatus = yield* service.status(run.id);
        expect(redactedStatus).toMatchObject({
          state: "reported",
          reportGeneration: 1,
          pid: 22_001,
        });
        expect(redactedStatus).not.toHaveProperty("finalText");
        expect(projections.at(-1)?.runs[0]?.finalText).toBe("First retained report.");
        expect(backend.controls[0]?.released()).toBe(0);

        const guided = yield* service.send(run.id, "Investigate the follow-up.");
        expect(guided).toMatchObject({ state: "running", reportGeneration: 1 });
        expect(guided.finalText).toBeUndefined();
        expect(backend.controls[0]?.prompts.at(-1)).toBe("Investigate the follow-up.");

        const cancelledAwait = yield* service
          .awaitTerminal([run.id], "all_finished")
          .pipe(Effect.forkScoped);
        yield* Effect.yieldNow;
        yield* Fiber.interrupt(cancelledAwait);
        backend.controls[0]?.offer({
          type: "report",
          runId: run.id,
          sequence: 2,
          deliveryId: "report-two",
          text: "Second retained report.",
        });
        yield* yieldUntil(
          () =>
            projections.at(-1)?.runs.find((candidate) => candidate.id === run.id)?.state ===
            "reported",
        );
        yield* TestClock.adjust("100 millis");
        yield* yieldUntil(
          () =>
            notifications.filter((notification) => notification.type === "completed").length === 1,
        );
        expect(notifications).toMatchObject([
          {
            type: "completed",
            runs: [
              {
                id: run.id,
                generation: 2,
                finalText: "Second retained report.",
                retained: true,
              },
            ],
          },
        ]);
        yield* TestClock.adjust("1 second");
        expect(
          notifications.filter((notification) => notification.type === "completed"),
        ).toHaveLength(1);

        const stopped = yield* service.stop(run.id);
        expect(stopped.state).toBe("stopped");
        expect(backend.controls[0]?.released()).toBe(1);
      }).pipe(Effect.scoped, Effect.provide(layer));
    },
  );

  it.effect("delivers a retained report and later failure as distinct outcome generations", () => {
    const backend = fakeRetainedBackendLayer();
    const notifications: SubagentNotification[] = [];
    const projections: SubagentProjection[] = [];
    const layer = retainedServiceLayer(backend, {
      notify: (notification) => notifications.push(notification),
      publish: (projection) => projections.push(projection),
    });
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.start(
        request({
          name: "retained-failure-generation",
          host: "herdr",
          runtime: "claude",
          closeOnReport: false,
          model: "claude-retained",
          effortWasExplicit: false,
        }),
      );
      backend.controls[0]?.offer({
        type: "report",
        runId: run.id,
        sequence: 1,
        deliveryId: "retained-success",
        text: "First report.",
      });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "reported");
      yield* TestClock.adjust("100 millis");
      yield* yieldUntil(() => notifications.length === 1);
      expect(notifications[0]).toMatchObject({
        type: "completed",
        runs: [{ id: run.id, generation: 1, outcome: "completed", retained: true }],
      });

      expect((yield* service.send(run.id, "Begin the next assignment.")).state).toBe("running");
      backend.controls[0]?.offer({
        type: "exit",
        exitCode: 1,
        diagnostic: "Retained backend exited.",
      });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "failed");
      yield* TestClock.adjust("100 millis");
      yield* yieldUntil(() => notifications.length === 2);
      expect(notifications[1]).toMatchObject({
        type: "completed",
        runs: [
          {
            id: run.id,
            generation: 2,
            outcome: "failed",
            error: "Retained backend exited.",
          },
        ],
      });
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("rejects parallel await ownership and releases only the cancelled claim", () => {
    const fake = fakeChildLayer();
    const notifications: SubagentNotification[] = [];
    const updates: SubagentProjection["runs"][] = [];
    const layer = serviceLayer({
      notify: (notification) => void notifications.push(notification),
    }).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.start(request({ name: "exclusive-await" }));
      const enteredRender = yield* Deferred.make<void>();
      const first = yield* service
        .withAwaitTerminalObservations(
          [run.id],
          "all_finished",
          (runs) => updates.push(runs),
          () => Deferred.succeed(enteredRender, undefined).pipe(Effect.andThen(Effect.never)),
        )
        .pipe(Effect.forkScoped);
      yield* yieldUntil(() => updates.length > 0);
      fake.controls[0]?.offer({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Exclusively delivered." }],
        },
      });
      fake.controls[0]?.offer({ type: "agent_settled" });
      yield* Deferred.await(enteredRender);

      const conflict = yield* service.awaitTerminal([run.id], "all_finished").pipe(Effect.flip);
      expect(conflict).toMatchObject({
        _tag: "InvalidSubagentRequestError",
        code: "completion_claim_conflict",
      });

      yield* Fiber.interrupt(first);
      const replacement = yield* service
        .awaitTerminal([run.id], "all_finished")
        .pipe(Effect.forkScoped);
      expect(yield* Fiber.join(replacement)).toMatchObject([
        { state: "completed", finalText: "Exclusively delivered." },
      ]);
      yield* TestClock.adjust("1 second");
      expect(notifications).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("redacts a completed report from status while an await owns its receipt", () => {
    const fake = fakeChildLayer();
    const notifications: SubagentNotification[] = [];
    const layer = serviceLayer({
      notify: (notification) => void notifications.push(notification),
    }).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.start(request({ name: "await-status-race" }));
      const entered = yield* Deferred.make<void>();
      const releaseRender = yield* Deferred.make<void>();
      const awaiting = yield* service
        .withAwaitTerminalObservations([run.id], "all_finished", undefined, (observations) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(releaseRender);
            const receipt = observations[0]?.completionReceipt;
            if (receipt) yield* service.consumeCompletions([receipt]);
            return observations;
          }),
        )
        .pipe(Effect.forkScoped);

      fake.controls[0]?.offer({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Owned report text." }],
        },
      });
      fake.controls[0]?.offer({ type: "agent_settled" });
      yield* Deferred.await(entered);

      const competingStatus = yield* service.status(run.id);
      expect(competingStatus).not.toHaveProperty("finalText");
      expect(competingStatus.sessionEvents).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ text: "Owned report text." })]),
      );
      yield* service.consumeCompletions([
        { id: run.id, generation: 1, claimToken: "forged-owner" },
      ]);
      expect(yield* service.status(run.id)).not.toHaveProperty("finalText");

      yield* Deferred.succeed(releaseRender, undefined);
      const observations = yield* Fiber.join(awaiting);
      expect(observations[0]?.run.finalText).toBe("Owned report text.");
      yield* TestClock.adjust("1 second");
      expect(notifications).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("commits an initial report only after the matching start command confirms", () => {
    const initialStartGate = Deferred.makeUnsafe<void>();
    const backend = fakeRetainedBackendLayer({ initialStartGate });
    const projections: SubagentProjection[] = [];
    const layer = retainedServiceLayer(backend, {
      publish: (projection) => projections.push(projection),
    });
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const starting = yield* service
        .start(
          request({
            host: "herdr",
            runtime: "claude",
            closeOnReport: false,
            model: "claude-retained",
            effortWasExplicit: false,
          }),
        )
        .pipe(Effect.forkScoped);
      yield* yieldUntil(() => backend.controls[0]?.assignmentEpochs[0] === 1);
      const id = projections.at(-1)?.runs[0]?.id;
      expect(id).toBeDefined();
      backend.controls[0]?.offer({
        type: "report",
        assignmentEpoch: 1,
        runId: id!,
        sequence: 1,
        deliveryId: "initial-in-flight",
        text: "Fast initial report.",
      });
      yield* Effect.yieldNow;
      expect(projections.at(-1)?.runs[0]?.state).not.toBe("reported");
      yield* Deferred.succeed(initialStartGate, undefined);
      expect(yield* Fiber.join(starting)).toMatchObject({
        state: "reported",
        reportGeneration: 1,
        finalText: "Fast initial report.",
      });
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect(
    "buffers an in-flight retained report and does not poison its later valid retry",
    () => {
      const backend = fakeRetainedBackendLayer();
      const projections: SubagentProjection[] = [];
      const layer = retainedServiceLayer(backend, {
        publish: (projection) => projections.push(projection),
      });
      return Effect.gen(function* () {
        const service = yield* SubagentService;
        const run = yield* service.start(
          request({
            host: "herdr",
            runtime: "claude",
            closeOnReport: false,
            model: "claude-retained",
            effortWasExplicit: false,
          }),
        );
        backend.controls[0]?.offer({
          type: "report",
          runId: run.id,
          sequence: 1,
          deliveryId: "first-delivery",
          text: "First assignment.",
        });
        yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "reported");
        expect((yield* service.status(run.id)).finalText).toBe("First assignment.");

        backend.controls[0]?.offer({
          type: "report",
          assignmentEpoch: 1,
          runId: run.id,
          sequence: 2,
          deliveryId: "second-delivery",
          text: "Too early.",
        });
        yield* yieldUntil(() =>
          Boolean(projections.at(-1)?.runs[0]?.warning?.includes("protocol-invalid")),
        );
        expect(projections.at(-1)?.runs[0]).toMatchObject({
          state: "reported",
          reportGeneration: 1,
          finalText: "First assignment.",
        });
        expect(
          (yield* service.status(run.id)).sessionEvents.some(
            (event) =>
              event.type === "notice" &&
              event.kind === "warning" &&
              event.text.includes("protocol-invalid"),
          ),
        ).toBe(true);

        backend.controls[0]?.offer({
          type: "report",
          assignmentEpoch: 1,
          runId: run.id,
          sequence: 1,
          deliveryId: "first-delivery",
          text: "Exact retry with changed text is ignored.",
        });
        const startGate = yield* Deferred.make<void>();
        backend.controls[0]?.gateNextStart(startGate);
        const sending = yield* service
          .send(run.id, "Begin the second assignment.")
          .pipe(Effect.forkScoped);
        yield* yieldUntil(() => backend.controls[0]?.prompts.length === 2);
        backend.controls[0]?.offer({
          type: "report",
          assignmentEpoch: 2,
          runId: run.id,
          sequence: 2,
          deliveryId: "second-delivery",
          text: "Second assignment committed after start.",
        });
        yield* Effect.yieldNow;
        expect(projections.at(-1)?.runs[0]?.state).not.toBe("reported");
        yield* Deferred.succeed(startGate, undefined);
        expect(yield* Fiber.join(sending)).toMatchObject({
          state: "reported",
          reportGeneration: 2,
          finalText: "Second assignment committed after start.",
        });
      }).pipe(Effect.scoped, Effect.provide(layer));
    },
  );

  it.effect("caps one retained run at 64 unresolved report generations", () => {
    const backend = fakeRetainedBackendLayer();
    const projections: SubagentProjection[] = [];
    const layer = retainedServiceLayer(backend, {
      notify: (notification) =>
        notification.type === "completed" ? { deliveredCompletionKeys: [] } : undefined,
      publish: (projection) => projections.push(projection),
    });
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.start(
        request({
          host: "herdr",
          runtime: "claude",
          closeOnReport: false,
          model: "claude-retained",
          effortWasExplicit: false,
        }),
      );
      for (let generation = 1; generation <= 64; generation += 1) {
        backend.controls[0]?.offer({
          type: "report",
          runId: run.id,
          sequence: generation,
          deliveryId: `backlog-${generation}`,
          text: `Backlog report ${generation}.`,
        });
        yield* yieldUntil(() => projections.at(-1)?.runs[0]?.reportGeneration === generation);
        if (generation < 64) yield* service.send(run.id, `Begin assignment ${generation + 1}.`);
      }
      const failure = yield* service.send(run.id, "Exceed the backlog.").pipe(Effect.flip);
      expect(failure).toMatchObject({
        _tag: "InvalidSubagentRequestError",
        code: "report_delivery_backlog",
      });
      expect((yield* service.list)[0]?.reportGeneration).toBe(64);
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("caps resumed runs at 64 unresolved report generations", () => {
    const fake = fakeChildLayer();
    const projections: SubagentProjection[] = [];
    const layer = serviceLayer({
      notify: (notification) =>
        notification.type === "completed" ? { deliveredCompletionKeys: [] } : undefined,
      publish: (projection) => projections.push(projection),
    }).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.start(request({ name: "resume-backlog" }));
      for (let generation = 1; generation <= 64; generation += 1) {
        fake.controls[generation - 1]?.offer({ type: "agent_settled" });
        yield* yieldUntil(
          () =>
            projections.at(-1)?.runs[0]?.state === "completed" &&
            projections.at(-1)?.runs[0]?.reportGeneration === generation,
        );
        if (generation < 64)
          yield* service.resume(run.id, `Continue assignment ${generation + 1}.`);
      }

      const failure = yield* service.resume(run.id, "Exceed the backlog.").pipe(Effect.flip);
      expect(failure).toMatchObject({
        _tag: "InvalidSubagentRequestError",
        code: "report_delivery_backlog",
      });
      expect(fake.controls).toHaveLength(64);
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("rolls back a raced retained start and never reuses its assignment epoch", () => {
    const backend = fakeRetainedBackendLayer();
    const projections: SubagentProjection[] = [];
    const layer = retainedServiceLayer(backend, {
      publish: (projection) => projections.push(projection),
    });
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.start(
        request({
          host: "herdr",
          runtime: "claude",
          closeOnReport: false,
          model: "claude-retained",
          effortWasExplicit: false,
        }),
      );
      backend.controls[0]?.offer({
        type: "report",
        runId: run.id,
        sequence: 1,
        deliveryId: "rollback-report",
        text: "Preserve this report.",
      });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "reported");

      const failureGate = yield* Deferred.make<void>();
      backend.controls[0]?.gateNextStart(failureGate);
      backend.controls[0]?.failNextStart();
      const failing = yield* service
        .send(run.id, "Definite failing assignment.")
        .pipe(Effect.forkScoped);
      yield* yieldUntil(() => backend.controls[0]?.assignmentEpochs.at(-1) === 2);
      backend.controls[0]?.offer({ type: "run_started", assignmentEpoch: 2 });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "running");
      backend.controls[0]?.offer({
        type: "supervisor_contact",
        assignmentEpoch: 2,
        requestId: "failed-child-warning",
        kind: "warning",
        message: "Warning from the failed assignment.",
      });
      backend.controls[0]?.offer({
        type: "warning",
        source: "runtime-extension",
        message: "Handle warning during failed assignment.",
      });
      yield* yieldUntil(() =>
        Boolean(projections.at(-1)?.runs[0]?.warning?.includes("Handle warning")),
      );
      yield* Deferred.succeed(failureGate, undefined);
      expect(yield* Fiber.join(failing).pipe(Effect.flip)).toMatchObject({
        _tag: "SubagentProcessError",
      });
      const rolledBack = yield* service.status(run.id);
      expect(rolledBack).toMatchObject({
        state: "reported",
        reportGeneration: 1,
        finalText: "Preserve this report.",
      });
      expect(rolledBack.warning).toBeUndefined();
      expect(
        rolledBack.sessionEvents.filter(
          (event) => event.type === "notice" && event.kind === "warning",
        ),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ text: "Warning from the failed assignment." }),
          expect.objectContaining({
            text: "Extension error: Handle warning during failed assignment.",
          }),
        ]),
      );

      const nextGate = yield* Deferred.make<void>();
      backend.controls[0]?.gateNextStart(nextGate);
      const next = yield* service.send(run.id, "Next valid assignment.").pipe(Effect.forkScoped);
      yield* yieldUntil(() => backend.controls[0]?.assignmentEpochs.at(-1) === 3);
      backend.controls[0]?.offer({
        type: "supervisor_contact",
        assignmentEpoch: 2,
        requestId: "old-progress",
        kind: "progress",
        message: "Stale progress must not apply.",
      });
      backend.controls[0]?.offer({
        type: "tool_started",
        assignmentEpoch: 2,
        toolCallId: "old-tool",
        toolName: "stale-tool",
        args: {},
      });
      backend.controls[0]?.offer({
        type: "warning",
        source: "runtime-extension",
        message: "Lifecycle warning remains handle-scoped.",
      });
      yield* yieldUntil(() =>
        Boolean(projections.at(-1)?.runs[0]?.warning?.includes("Lifecycle warning")),
      );
      expect(projections.at(-1)?.runs[0]?.progress).toBeUndefined();
      expect(projections.at(-1)?.runs[0]?.currentTool).toBeUndefined();
      yield* Deferred.succeed(nextGate, undefined);
      expect((yield* Fiber.join(next)).state).toBe("running");
      expect(backend.controls[0]?.assignmentEpochs).toEqual([1, 2, 3]);
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("keeps outcome-uncertain retained work and ignores idle assignment events", () => {
    const backend = fakeRetainedBackendLayer();
    const projections: SubagentProjection[] = [];
    const layer = retainedServiceLayer(backend, {
      publish: (projection) => projections.push(projection),
    });
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.start(
        request({
          host: "herdr",
          runtime: "claude",
          closeOnReport: false,
          model: "claude-retained",
          effortWasExplicit: false,
        }),
      );
      backend.controls[0]?.offer({
        type: "report",
        runId: run.id,
        sequence: 1,
        deliveryId: "idle-report",
        text: "Idle report.",
      });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "reported");
      const beforeIdle = projections.at(-1)?.runs[0];
      backend.controls[0]?.offer({ type: "activity", assignmentEpoch: 1 });
      backend.controls[0]?.offer({
        type: "assistant_message",
        assignmentEpoch: 1,
        text: "Late assistant text.",
        usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: 1 },
      });
      backend.controls[0]?.offer({
        type: "tool_started",
        assignmentEpoch: 1,
        toolCallId: "late-tool",
        toolName: "late",
        args: {},
      });
      backend.controls[0]?.offer({
        type: "supervisor_contact",
        assignmentEpoch: 1,
        requestId: "late-question",
        kind: "question",
        message: "Late question?",
      });
      backend.controls[0]?.offer({
        type: "supervisor_contact",
        assignmentEpoch: 1,
        requestId: "late-progress",
        kind: "progress",
        message: "Late progress.",
      });
      backend.controls[0]?.offer({
        type: "warning",
        source: "runtime-extension",
        message: "Handle warning after report.",
      });
      yield* yieldUntil(
        () => projections.at(-1)?.runs[0]?.warning === "Handle warning after report.",
      );
      const afterIdle = projections.at(-1)?.runs[0];
      expect(afterIdle).toMatchObject({
        state: "reported",
        lastActivityAt: beforeIdle?.lastActivityAt,
        usage: beforeIdle?.usage,
        finalText: "Idle report.",
      });
      expect(afterIdle?.currentTool).toBeUndefined();
      expect(afterIdle?.progress).toBeUndefined();
      expect(afterIdle?.question).toBeUndefined();

      const uncertainGate = yield* Deferred.make<void>();
      backend.controls[0]?.gateNextStart(uncertainGate);
      backend.controls[0]?.failNextStart("transport_outcome_uncertain");
      const uncertain = yield* service
        .send(run.id, "Uncertain assignment.")
        .pipe(Effect.forkScoped);
      yield* yieldUntil(() => backend.controls[0]?.assignmentEpochs.at(-1) === 2);
      backend.controls[0]?.offer({ type: "run_started", assignmentEpoch: 2 });
      backend.controls[0]?.offer({
        type: "report",
        assignmentEpoch: 2,
        runId: run.id,
        sequence: 2,
        deliveryId: "uncertain-report",
        text: "Applied despite uncertain response.",
      });
      yield* Deferred.succeed(uncertainGate, undefined);
      expect(yield* Fiber.join(uncertain).pipe(Effect.flip)).toMatchObject({
        _tag: "SubagentProcessError",
        code: "resume_outcome_uncertain",
      });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.reportGeneration === 2);
      expect(projections.at(-1)?.runs[0]).toMatchObject({
        state: "reported",
        finalText: "Applied despite uncertain response.",
        warning: expect.stringContaining("may already have applied"),
      });
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("closes an idle retained backend on session shutdown", () => {
    const backend = fakeRetainedBackendLayer();
    const layer = retainedServiceLayer(backend);
    return Effect.gen(function* () {
      const run = yield* Effect.gen(function* () {
        const service = yield* SubagentService;
        const started = yield* service.start(
          request({
            host: "herdr",
            runtime: "claude",
            closeOnReport: false,
            model: "claude-retained",
            effortWasExplicit: false,
          }),
        );
        backend.controls[0]?.offer({
          type: "report",
          runId: started.id,
          sequence: 1,
          deliveryId: "shutdown-report",
          text: "Idle now.",
        });
        yield* yieldUntil(() =>
          Boolean(backend.controls[0] && backend.controls[0].released() === 0),
        );
        return started;
      }).pipe(Effect.scoped, Effect.provide(layer));
      expect(run.id).toBeDefined();
      expect(backend.controls[0]?.released()).toBe(1);
    });
  });

  it.effect("coalesces streamed token activity publications", () => {
    const fake = fakeChildLayer();
    const projections: SubagentProjection[] = [];
    const layer = serviceLayer({
      publish: (projection) => projections.push(projection),
    }).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.start(request({ name: "streaming-reader" }));
      const beforeTokens = projections.length;
      for (let index = 0; index < 100; index += 1)
        fake.controls[0]?.offer({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: String(index) },
        });
      fake.controls[0]?.offer({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Still working." }],
          usage: { totalTokens: 1 },
        },
      });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.usage.totalTokens === 1);
      expect(projections).toHaveLength(beforeTokens + 1);

      yield* TestClock.adjust("1 second");
      const beforeActivityTick = projections.length;
      fake.controls[0]?.offer({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "next" },
      });
      yield* yieldUntil(() => projections.length === beforeActivityTick + 1);
      expect((yield* service.status(run.id)).lastActivityAt).toBe(run.lastActivityAt + 1_000);
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("terminates a completed Pi process and restores its saved session", () => {
    const fake = fakeChildLayer();
    const projections: SubagentProjection[] = [];
    const layer = serviceLayer({
      publish: (projection) => projections.push(projection),
    }).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.start(request({ name: "terminate-and-resume" }));
      fake.controls[0]?.offer({ type: "agent_settled" });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "completed");
      yield* yieldUntil(() => fake.controls[0]?.released() === 1);
      const completed = yield* service.status(run.id);
      expect(completed.state).toBe("completed");
      expect(completed.reportGeneration).toBe(1);
      expect(completed.pid).toBeUndefined();
      expect(completed.sessionFile).toBe("/tmp/child-session.jsonl");

      yield* service.rename(run.id, "renamed-before-resume");
      const resumed = yield* service.resume(run.id, "Continue from disk.");
      expect(resumed.state).toBe("running");
      expect(fake.controls).toHaveLength(2);
      expect(fake.controls[1]?.launch.name).toBe("renamed-before-resume");
      expect(fake.controls[1]?.launch.resumeSessionFile).toBe("/tmp/child-session.jsonl");
      expect(fake.controls[1]?.commands.map((command) => command.type)).toEqual([
        "get_state",
        "prompt",
      ]);
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("reports a backend-generic error when completed resume state is unavailable", () => {
    const fake = fakeChildLayer(Effect.void, { omitSessionFile: true });
    const projections: SubagentProjection[] = [];
    const layer = serviceLayer({
      publish: (projection) => projections.push(projection),
    }).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.start(request({ name: "no-resume-token" }));
      fake.controls[0]?.offer({ type: "agent_settled" });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "completed");
      yield* yieldUntil(() => fake.controls[0]?.released() === 1);

      const failure = yield* service.resume(run.id).pipe(Effect.flip);
      expect(failure).toMatchObject({
        _tag: "InvalidSubagentRequestError",
        code: "backend_resume_unavailable",
      });
      expect(failure.message).toContain("local/pi did not provide continuation state");
      expect(failure.message).not.toContain("session file");
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("waits for completed-process cleanup before restoring the session", () => {
    const fake = fakeChildLayer();
    const projections: SubagentProjection[] = [];
    const layer = serviceLayer({
      publish: (projection) => projections.push(projection),
    }).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const cleanupGate = yield* Deferred.make<void>();
      const run = yield* service.start(request({ name: "cleanup-race" }));
      fake.controls[0]?.gateRelease(cleanupGate);
      fake.controls[0]?.offer({ type: "agent_settled" });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "completed");

      const resuming = yield* service
        .resume(run.id, "Continue after cleanup.")
        .pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      expect(fake.controls).toHaveLength(1);

      yield* Deferred.succeed(cleanupGate, undefined);
      yield* yieldUntil(() => fake.controls[0]?.released() === 1);
      yield* TestClock.adjust("25 millis");
      expect((yield* Fiber.join(resuming)).state).toBe("running");
      expect(fake.controls).toHaveLength(2);
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect(
    "enforces active and cleanup-owned capacity before admitting work after release",
    () => {
      const fake = fakeChildLayer();
      const projections: SubagentProjection[] = [];
      const layer = serviceLayer({ publish: (projection) => projections.push(projection) }).pipe(
        Layer.provide(fake.layer),
      );
      return Effect.gen(function* () {
        const service = yield* SubagentService;
        const runs: SubagentRunView[] = [];
        for (let index = 0; index < 12; index += 1)
          runs.push(yield* service.start(request({ name: `active-${index + 1}` })));
        expect(fake.controls).toHaveLength(12);

        const activeSaturation = yield* service
          .start(request({ name: "thirteenth-active" }))
          .pipe(Effect.flip);
        expect(activeSaturation).toMatchObject({ _tag: "SubagentCapacityError", limit: 12 });
        expect(activeSaturation.message).toContain("Stop an active run");
        expect(fake.controls).toHaveLength(12);

        const cleanupGate = yield* Deferred.make<void>();
        fake.controls[0]?.gateRelease(cleanupGate);
        fake.controls[0]?.offer({ type: "agent_settled" });
        yield* yieldUntil(() =>
          Boolean(
            projections
              .at(-1)
              ?.runs.some(
                (candidate) => candidate.id === runs[0]?.id && candidate.state === "completed",
              ),
          ),
        );
        const cleanupSaturation = yield* service
          .start(request({ name: "thirteenth-cleanup" }))
          .pipe(Effect.flip);
        expect(cleanupSaturation).toMatchObject({ _tag: "SubagentCapacityError", limit: 12 });
        expect(cleanupSaturation.message).toContain("finish cleanup");
        expect(fake.controls).toHaveLength(12);

        yield* Deferred.succeed(cleanupGate, undefined);
        yield* yieldUntil(() => fake.controls[0]?.released() === 1);
        const admitted = yield* service.start(request({ name: "admitted-after-cleanup" }));
        expect(admitted.state).toBe("running");
        expect(fake.controls).toHaveLength(13);
      }).pipe(Effect.scoped, Effect.provide(layer));
    },
  );

  it.effect("distinguishes cleanup-owned capacity saturation and bounded cleanup timeout", () => {
    const fake = fakeChildLayer();
    const projections: SubagentProjection[] = [];
    const layer = serviceLayer({
      publish: (projection) => projections.push(projection),
    }).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const gates = yield* Effect.all(Array.from({ length: 12 }, () => Deferred.make<void>()));
      const runs = [];
      for (let index = 0; index < 12; index += 1) {
        const run = yield* service.start(request({ name: `cleanup-${index + 1}` }));
        runs.push(run);
        fake.controls[index]?.gateRelease(gates[index]!);
        fake.controls[index]?.offer({ type: "agent_settled" });
        yield* yieldUntil(() =>
          Boolean(
            projections
              .at(-1)
              ?.runs.find(
                (candidate) => candidate.id === run.id && candidate.state === "completed",
              ),
          ),
        );
      }
      const saturated = yield* service.start(request({ name: "capacity-probe" })).pipe(Effect.flip);
      expect(saturated).toMatchObject({ _tag: "SubagentCapacityError", limit: 12 });
      expect(saturated.message).toContain("finish cleanup");

      const resuming = yield* service.resume(runs[0]!.id).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* TestClock.adjust("10 seconds");
      const timeout = yield* Fiber.join(resuming).pipe(Effect.flip);
      expect(timeout).toMatchObject({
        _tag: "SubagentProcessError",
        code: "cleanup_timeout",
      });
      yield* Effect.forEach(gates, (gate) => Deferred.succeed(gate, undefined), {
        discard: true,
      });
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("routes blocking child questions and peer notices through supervisor IPC", () => {
    const fake = fakeChildLayer();
    const projections: SubagentProjection[] = [];
    const layer = serviceLayer({
      publish: (projection) => projections.push(projection),
    }).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const first = yield* service.start(request({ name: "reader-one" }));
      fake.controls[0]?.offer({
        type: "extension_ui_request",
        id: "dialog-1",
        method: "confirm",
      });
      yield* yieldUntil(
        () =>
          fake.controls[0]?.commands.some((command) => command.type === "extension_ui_response") ??
          false,
      );
      expect(fake.controls[0]?.commands).toContainEqual({
        type: "extension_ui_response",
        id: "dialog-1",
        cancelled: true,
      });
      fake.controls[0]?.offerIpc({
        channel: "pi-subagents",
        type: "contact_parent",
        requestId: "question-1",
        kind: "question",
        message: "Which API should I use?",
      });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "waiting_for_parent");

      const waiting = yield* service.status(first.id);
      expect(waiting.question?.message).toBe("Which API should I use?");
      const guidanceFailure = yield* Effect.flip(service.send(first.id, "Use the public API."));
      expect(guidanceFailure.message).toContain(
        `subagent_reply({ runId: "${first.id}", message: "..." })`,
      );
      const replied = yield* service.reply(first.id, "Use the public API.");
      expect(replied.state).toBe("running");
      expect(fake.controls[0]?.ipc).toContainEqual({
        channel: "pi-subagents",
        type: "parent_reply",
        requestId: "question-1",
        message: "Use the public API.",
      });

      yield* service.start(request({ name: "reader-two", task: "Review tests" }));
      expect(
        fake.controls[0]?.ipc.some(
          (message) => message.type === "peer_notice" && message.message.includes("reader-two"),
        ),
      ).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("returns an await when a selected run needs a parent reply", () => {
    const fake = fakeChildLayer();
    const projections: SubagentProjection[] = [];
    const layer = serviceLayer({
      publish: (projection) => projections.push(projection),
    }).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.start(request({ name: "awaiting-question" }));
      const awaiting = yield* service
        .awaitTerminal([run.id], "all_finished")
        .pipe(Effect.forkScoped);

      fake.controls[0]?.offerIpc({
        channel: "pi-subagents",
        type: "contact_parent",
        requestId: "question-during-await",
        kind: "question",
        message: "Should I update the fixture?",
      });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "waiting_for_parent");

      const [attention] = yield* Fiber.join(awaiting);
      expect(attention).toMatchObject({
        id: run.id,
        state: "waiting_for_parent",
        question: { requestId: "question-during-await" },
      });
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("reports every missing await ID before waiting", () => {
    const fake = fakeChildLayer();
    const layer = serviceLayer().pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const failure = yield* Effect.flip(
        service.awaitTerminal(["agent-missing-1", "agent-missing-2"], "all_finished"),
      );
      expect(failure).toMatchObject({
        _tag: "InvalidSubagentRequestError",
        code: "subagent_runs_not_found",
      });
      expect(failure.message).toContain("agent-missing-1, agent-missing-2");
      expect(failure.message).toContain("subagent_list");
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("delivers a claimed failure through await without a background notification", () => {
    const fake = fakeChildLayer();
    const notifications: SubagentNotification[] = [];
    const projections: SubagentProjection[] = [];
    const layer = serviceLayer({
      notify: (notification) => notifications.push(notification),
      publish: (projection) => projections.push(projection),
    }).pipe(Layer.provide(fake.layer));

    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.start(request({ name: "awaited-failure" }));
      const awaiting = yield* service
        .awaitTerminal([run.id], "all_finished")
        .pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      fake.controls[0]?.exit(1);
      const [failed] = yield* Fiber.join(awaiting);
      expect(failed).toMatchObject({ id: run.id, state: "failed", error: expect.any(String) });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "failed");
      yield* TestClock.adjust("1 second");
      expect(notifications).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("finishes an accepted interrupt after its requesting fiber is cancelled", () => {
    const fake = fakeChildLayer();
    const projections: SubagentProjection[] = [];
    const layer = serviceLayer({
      publish: (projection) => projections.push(projection),
    }).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.start(request({ name: "cancelled-interrupt-request" }));
      const gate = yield* Deferred.make<void>();
      fake.controls[0]?.gateNextSend("abort", gate);
      const interrupting = yield* service.interrupt(run.id).pipe(Effect.forkScoped);
      yield* yieldUntil(
        () => fake.controls[0]?.commands.some((command) => command.type === "abort") ?? false,
      );
      yield* Fiber.interrupt(interrupting);
      yield* Deferred.succeed(gate, undefined);
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "paused");
      expect((yield* service.status(run.id)).state).toBe("paused");
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("finishes an accepted resume after its requesting fiber is cancelled", () => {
    const fake = fakeChildLayer();
    const projections: SubagentProjection[] = [];
    const layer = serviceLayer({
      publish: (projection) => projections.push(projection),
    }).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.start(request({ name: "cancelled-resume-request" }));
      expect((yield* service.interrupt(run.id)).state).toBe("paused");

      const gate = yield* Deferred.make<void>();
      fake.controls[0]?.gateNextSend("prompt", gate);
      const resuming = yield* service.resume(run.id, "Continue safely.").pipe(Effect.forkScoped);
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "starting");
      yield* Fiber.interrupt(resuming);
      yield* Deferred.succeed(gate, undefined);
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "running");
      const resumed = yield* service.status(run.id);
      expect(resumed.sessionEvents).toContainEqual(
        expect.objectContaining({
          type: "notice",
          kind: "parent",
          text: "Resume: Continue safely.",
        }),
      );
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("clears a pending question when settlement wins the interrupt race", () => {
    const fake = fakeChildLayer();
    const projections: SubagentProjection[] = [];
    const layer = serviceLayer({
      publish: (projection) => projections.push(projection),
    }).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.start(request({ name: "question-pause" }));
      fake.controls[0]?.offerIpc({
        channel: "pi-subagents",
        type: "contact_parent",
        requestId: "question-before-pause",
        kind: "question",
        message: "Should I continue?",
      });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "waiting_for_parent");
      fake.controls[0]?.beforeNextResponse("abort", { type: "agent_settled" });

      const paused = yield* service.interrupt(run.id);
      expect(paused.state).toBe("paused");
      expect(paused.question).toBeUndefined();
      const guidanceFailure = yield* Effect.flip(service.send(run.id, "Continue."));
      expect(guidanceFailure.message).toContain(
        `subagent_lifecycle({ action: "resume", runIds: ["${run.id}"] })`,
      );

      const resumed = yield* service.resume(run.id);
      expect(resumed.state).toBe("running");
      expect(resumed.question).toBeUndefined();
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("ignores child settlement that arrives after interruption is confirmed", () => {
    const fake = fakeChildLayer();
    const projections: SubagentProjection[] = [];
    const layer = serviceLayer({
      publish: (projection) => projections.push(projection),
    }).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.start(request({ name: "settled-after-pause" }));
      expect((yield* service.interrupt(run.id)).state).toBe("paused");

      fake.controls[0]?.offer({ type: "agent_settled" });
      for (let index = 0; index < 10; index += 1) yield* Effect.yieldNow;

      expect(yield* service.status(run.id)).toMatchObject({
        state: "paused",
        reportGeneration: 0,
      });
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("keeps a timed-out interrupt pending until child settlement", () => {
    const fake = fakeChildLayer();
    const projections: SubagentProjection[] = [];
    const layer = serviceLayer({
      publish: (projection) => projections.push(projection),
    }).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.start(request({ name: "late-pause" }));
      fake.controls[0]?.dropNext("abort");
      const interrupting = yield* service.interrupt(run.id).pipe(Effect.forkScoped);
      yield* yieldUntil(
        () => fake.controls[0]?.commands.some((command) => command.type === "abort") ?? false,
      );
      yield* TestClock.adjust("10 seconds");
      const error = yield* Fiber.join(interrupting).pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "SubagentProcessError",
        code: "interrupt_outcome_uncertain",
      });
      expect(error.message).toContain("may still apply");
      expect(error.message).toContain("subagent_status");

      fake.controls[0]?.offer({ type: "agent_settled" });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "paused");
      expect((yield* service.status(run.id)).state).toBe("paused");
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("does not accept RPC lifecycle events from child IPC", () => {
    const fake = fakeChildLayer();
    const projections: SubagentProjection[] = [];
    const layer = serviceLayer({
      publish: (projection) => projections.push(projection),
    }).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.start(request({ name: "ipc-boundary" }));
      fake.controls[0]?.offerIpc({ type: "agent_settled" });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "failed");
      expect((yield* service.status(run.id)).state).toBe("failed");
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("finalizes and releases slots when a backend awaitExit fails", () => {
    const fake = fakeChildLayer();
    const projections: SubagentProjection[] = [];
    const layer = serviceLayer({
      publish: (projection) => projections.push(projection),
    }).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const failedRun = yield* service.start(
        request({ name: "await-exit-failure", writeIntent: "writer" }),
      );
      fake.controls[0]?.failExit("Fixture awaitExit failure.");
      yield* yieldUntil(
        () =>
          projections
            .at(-1)
            ?.runs.some((run) => run.id === failedRun.id && run.state === "failed") === true,
      );
      yield* yieldUntil(() => fake.controls[0]?.released() === 1);
      const failed = yield* service.status(failedRun.id);
      expect(failed).toMatchObject({
        state: "failed",
        error: expect.stringContaining("Fixture awaitExit failure"),
      });
      expect(failed.pid).toBeUndefined();

      const replacement = yield* service.start(
        request({ name: "replacement-after-await-failure", writeIntent: "writer" }),
      );
      expect(replacement.state).toBe("running");
      expect(fake.controls).toHaveLength(2);
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect(
    "quarantines a spawn-started writer when a failed Herdr acquisition owns uncertain cleanup",
    () => {
      let leaseReleases = 0;
      const projections: SubagentProjection[] = [];
      const driver: BackendDriver = {
        host: "herdr",
        runtime: "pi",
        capabilities: ["steer"],
        supportsContext: (context) => context === "fresh",
        preflight: () => Effect.void,
        spawn: () =>
          Effect.gen(function* () {
            yield* Effect.addFinalizer(() =>
              Effect.fail(
                new SubagentProcessError({
                  operation: "finalize Herdr launch",
                  code: "herdr_launch_cleanup_unconfirmed",
                  message: "Fixture applied start and failed rollback cleanup.",
                }),
              ).pipe(Effect.orDie),
            );
            return yield* new SubagentProcessError({
              operation: "launch Herdr agent",
              code: "herdr_start_agent_outcome_uncertain",
              message: "Fixture Herdr start may have applied.",
            });
          }),
      };
      const registry = Layer.succeed(
        SubagentBackendRegistry,
        makeSubagentBackendRegistry([driver]),
      );
      const leases = fakeWriterLeaseLayer({
        onRelease: () => {
          leaseReleases += 1;
        },
      });
      const layer = SubagentService["layer"]({
        publish: (projection) => projections.push(projection),
      }).pipe(
        Layer.provide(Layer.merge(registry, leases)),
        Layer.provideMerge(profileLayerFor({})),
      );
      return Effect.gen(function* () {
        const service = yield* SubagentService;
        const failure = yield* service
          .start(
            request({
              host: "herdr",
              runtime: "pi",
              writeIntent: "writer",
              closeOnReport: true,
              name: "uncertain-herdr-writer",
            }),
          )
          .pipe(Effect.flip);
        expect(failure).toMatchObject({ code: "herdr_start_agent_outcome_uncertain" });
        expect(leaseReleases).toBe(0);
        expect(projections.at(-1)?.runs[0]).toMatchObject({
          state: "failed",
          warning: expect.stringContaining("ownership remain quarantined"),
        });
        const conflict = yield* service
          .start(
            request({
              host: "herdr",
              runtime: "pi",
              name: "replacement",
              writeIntent: "writer",
            }),
          )
          .pipe(Effect.flip);
        expect(conflict).toMatchObject({ _tag: "SubagentWriterConflictError" });
      }).pipe(Effect.scoped, Effect.provide(layer));
    },
  );

  it.effect("quarantines a writer when awaitExit failure finalization defects", () => {
    const fake = fakeChildLayer(Effect.void, { releaseDefect: true });
    const projections: SubagentProjection[] = [];
    const layer = serviceLayer({
      publish: (projection) => projections.push(projection),
    }).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.start(
        request({ name: "await-failure-defect", writeIntent: "writer" }),
      );
      fake.controls[0]?.failExit("Fixture awaitExit failure.");
      yield* yieldUntil(
        () =>
          projections
            .at(-1)
            ?.runs.some(
              (candidate) =>
                candidate.id === run.id &&
                candidate.state === "failed" &&
                candidate.warning?.includes("ownership remain quarantined") === true,
            ) === true,
      );

      const conflict = yield* service
        .start(request({ name: "blocked-writer", writeIntent: "writer" }))
        .pipe(Effect.flip);
      expect(conflict).toMatchObject({
        _tag: "SubagentWriterConflictError",
        activeId: run.id,
        message: expect.stringContaining("cleanup could not be confirmed"),
      });
      expect(fake.controls).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("drains buffered lifecycle output before processing child exit", () => {
    const fake = fakeChildLayer();
    const projections: SubagentProjection[] = [];
    const layer = serviceLayer({
      publish: (projection) => projections.push(projection),
    }).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.start(request({ name: "exit-drain" }));
      fake.controls[0]?.offer({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Final output before exit." }],
        },
      });
      fake.controls[0]?.offer({ type: "agent_settled" });
      fake.controls[0]?.exit(0);

      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "completed");
      const completed = yield* service.status(run.id);
      expect(completed.state).toBe("completed");
      expect(completed.finalText).toBe("Final output before exit.");
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("awaits a fleet without polling and consumes its completion notifications", () => {
    const fake = fakeChildLayer();
    const notifications: SubagentNotification[] = [];
    const updates: SubagentProjection["runs"][] = [];
    const layer = serviceLayer({
      notify: (notification) => notifications.push(notification),
    }).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const first = yield* service.start(request({ name: "await-one" }));
      const second = yield* service.start(request({ name: "await-two" }));
      const waiting = yield* service
        .awaitTerminal([first.id, second.id], "all_finished", (runs) => updates.push(runs))
        .pipe(Effect.forkScoped);
      yield* yieldUntil(() => updates.length > 0);

      fake.controls[0]?.offer({ type: "agent_settled" });
      yield* yieldUntil(() => updates.at(-1)?.[0]?.state === "completed");
      expect(updates.at(-1)?.[1]?.state).toBe("running");
      fake.controls[1]?.offer({ type: "agent_settled" });

      const completed = yield* Fiber.join(waiting);
      expect(completed.map((run) => run.state)).toEqual(["completed", "completed"]);
      yield* TestClock.adjust("100 millis");
      expect(notifications).toEqual([]);
      expect(updates.at(-1)?.every((run) => run.state === "completed")).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("rejects empty awaits at the service boundary", () => {
    const fake = fakeChildLayer();
    const layer = serviceLayer().pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      for (const until of ["all_finished", "any_finished"] as const) {
        const error = yield* Effect.flip(service.awaitTerminal([], until));
        expect(error._tag).toBe("InvalidSubagentRequestError");
      }
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("supports any-terminal awaits without consuming running peers", () => {
    const fake = fakeChildLayer();
    const updates: SubagentProjection["runs"][] = [];
    const layer = serviceLayer().pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const first = yield* service.start(request({ name: "any-one" }));
      const second = yield* service.start(request({ name: "any-two" }));
      const waiting = yield* service
        .awaitTerminal([first.id, second.id], "any_finished", (runs) => updates.push(runs))
        .pipe(Effect.forkScoped);
      yield* yieldUntil(() => updates.length > 0);
      fake.controls[1]?.offer({ type: "agent_settled" });
      const runs = yield* Fiber.join(waiting);
      expect(runs.map((run) => run.state)).toEqual(["running", "completed"]);
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("releases await claims when the waiting fiber is interrupted", () => {
    const fake = fakeChildLayer();
    const notifications: SubagentNotification[] = [];
    const updates: SubagentProjection["runs"][] = [];
    const projections: SubagentProjection[] = [];
    const layer = serviceLayer({
      notify: (notification) => notifications.push(notification),
      publish: (projection) => projections.push(projection),
    }).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.start(request({ name: "cancelled-await" }));
      const waiting = yield* service
        .awaitTerminal([run.id], "all_finished", (runs) => updates.push(runs))
        .pipe(Effect.forkScoped);
      yield* yieldUntil(() => updates.length > 0);
      yield* Fiber.interrupt(waiting);
      fake.controls[0]?.offer({ type: "agent_settled" });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "completed");
      yield* TestClock.adjust("100 millis");
      yield* yieldUntil(() => notifications.length === 1);
      expect(notifications[0]).toMatchObject({
        type: "completed",
        runs: [{ id: run.id }],
      });
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("keeps unconsumed observations notification-eligible", () => {
    const fake = fakeChildLayer();
    const notifications: SubagentNotification[] = [];
    const updates: SubagentProjection["runs"][] = [];
    const layer = serviceLayer({
      notify: (notification) => notifications.push(notification),
    }).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.start(request({ name: "observed-report" }));
      const waiting = yield* service
        .withAwaitTerminalObservations(
          [run.id],
          "all_finished",
          (runs) => updates.push(runs),
          Effect.succeed,
        )
        .pipe(Effect.forkScoped);
      yield* yieldUntil(() => updates.length > 0);
      fake.controls[0]?.offer({ type: "agent_settled" });
      const observations = yield* Fiber.join(waiting);
      expect(observations[0]?.completionReceipt).toEqual({
        id: run.id,
        generation: 1,
        claimToken: expect.any(String),
      });
      yield* TestClock.adjust("100 millis");
      yield* yieldUntil(() => notifications.length === 1);
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("returns found status observations alongside every stale ID", () => {
    const fake = fakeChildLayer();
    const layer = serviceLayer().pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.start(request({ name: "status-selection" }));

      const selection = yield* service.withStatusObservations(
        [run.id, "agent-stale-1", "agent-stale-2"],
        Effect.succeed,
      );

      expect(selection.observations.map((observation) => observation.run.id)).toEqual([run.id]);
      expect(selection.missingIds).toEqual(["agent-stale-1", "agent-stale-2"]);
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("holds a completion claim through observation formatting and consumption", () => {
    const fake = fakeChildLayer();
    const notifications: SubagentNotification[] = [];
    const projections: SubagentProjection[] = [];
    const layer = serviceLayer({
      notify: (notification) => notifications.push(notification),
      publish: (projection) => projections.push(projection),
    }).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.start(request({ name: "leased-observation" }));
      fake.controls[0]?.offer({ type: "agent_settled" });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "completed");

      const acquired = yield* Deferred.make<void>();
      const releaseUse = yield* Deferred.make<void>();
      const observing = yield* service
        .withStatusObservations([run.id], ({ observations }) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(acquired, undefined);
            yield* Deferred.await(releaseUse);
            const receipt = observations[0]?.completionReceipt;
            if (receipt) yield* service.consumeCompletions([receipt]);
          }),
        )
        .pipe(Effect.forkScoped);
      yield* Deferred.await(acquired);
      yield* TestClock.adjust("100 millis");
      expect(notifications).toEqual([]);
      yield* Deferred.succeed(releaseUse, undefined);
      yield* Fiber.join(observing);
      yield* TestClock.adjust("1 second");
      expect(notifications).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("settles interrupted startup as stopped without a warning", () => {
    const fake = fakeChildLayer(Effect.void, { dropInitialState: true });
    const notifications: SubagentNotification[] = [];
    const projections: SubagentProjection[] = [];
    const layer = serviceLayer({
      notify: (notification) => notifications.push(notification),
      publish: (projection) => projections.push(projection),
    }).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const starting = yield* service
        .start(request({ name: "cancelled-start" }))
        .pipe(Effect.forkScoped);
      yield* yieldUntil(
        () => fake.controls[0]?.commands.some((command) => command.type === "get_state") ?? false,
      );
      yield* Fiber.interrupt(starting);
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "stopped");
      expect(notifications).toEqual([]);
      expect(fake.controls[0]?.released()).toBe(1);
      const id = projections.at(-1)?.runs[0]?.id;
      expect(id).toBeDefined();
      expect((yield* service.status(id!)).error).toBeUndefined();
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect(
    "settles writer preparation when interruption is already queued at the start boundary",
    () => {
      const fake = fakeChildLayer();
      const projections: SubagentProjection[] = [];
      let interruptAtBoundary: () => void = () => undefined;
      const layer = serviceLayer({
        publish: (projection) => {
          projections.push(projection);
          if (projection.runs[0]?.state === "starting") interruptAtBoundary();
        },
      }).pipe(Layer.provide(fake.layer));
      return Effect.gen(function* () {
        const service = yield* SubagentService;
        const starting = yield* service
          .start(request({ name: "boundary-interrupted-writer", writeIntent: "writer" }))
          .pipe(Effect.forkScoped({ startImmediately: false }));
        interruptAtBoundary = () => starting.interruptUnsafe();
        const interrupted = yield* Fiber.await(starting);
        expect(Exit.isFailure(interrupted)).toBe(true);
        yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "stopped");
        expect(fake.controls).toHaveLength(0);

        const replacement = yield* service.start(
          request({ name: "after-boundary-interrupt", writeIntent: "writer" }),
        );
        expect(replacement.state).toBe("running");
        expect(fake.controls).toHaveLength(1);
        yield* service.stop(replacement.id);
      }).pipe(Effect.scoped, Effect.provide(layer));
    },
  );

  it.effect("settles in-flight writer preparation when session shutdown starts at startup", () =>
    Effect.gen(function* () {
      const acquireGate = yield* Deferred.make<void>();
      const acquireStarted = yield* Deferred.make<void>();
      const fake = fakeChildLayer();
      let releases = 0;
      const writerLeases = fakeWriterLeaseLayer({
        acquireGate,
        onAcquireStarted: () => Deferred.doneUnsafe(acquireStarted, Effect.void),
        onRelease: () => {
          releases += 1;
        },
      });
      const layer = serviceLayer({}, profileLayerFor({}), writerLeases).pipe(
        Layer.provide(fake.layer),
      );

      yield* Effect.gen(function* () {
        const service = yield* SubagentService;
        yield* service
          .startSessionOwned(request({ name: "shutdown-start-boundary", writeIntent: "writer" }))
          .pipe(Effect.forkScoped({ startImmediately: true }));
        yield* Deferred.await(acquireStarted);
        scheduleImmediate(() => Deferred.doneUnsafe(acquireGate, Effect.void));
      }).pipe(Effect.scoped, Effect.provide(layer));

      expect(fake.controls).toHaveLength(0);
      expect(releases).toBe(1);
    }),
  );

  it.effect("coalesces unclaimed fleet completions into one notification", () => {
    const fake = fakeChildLayer();
    const notifications: SubagentNotification[] = [];
    const projections: SubagentProjection[] = [];
    const layer = serviceLayer({
      notify: (notification) => notifications.push(notification),
      publish: (projection) => projections.push(projection),
    }).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const first = yield* service.start(request({ name: "notify-one" }));
      const second = yield* service.start(request({ name: "notify-two" }));
      fake.controls[0]?.offer({ type: "agent_settled" });
      fake.controls[1]?.offer({ type: "agent_settled" });
      yield* yieldUntil(() =>
        Boolean(projections.at(-1)?.runs.every((run) => run.state === "completed")),
      );
      yield* TestClock.adjust("100 millis");
      yield* yieldUntil(() => notifications.length === 1);

      expect(notifications[0]).toMatchObject({
        type: "completed",
        runs: [
          { id: first.id, name: "notify-one", generation: 1 },
          { id: second.id, name: "notify-two", generation: 1 },
        ],
      });
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("bounds failed-delivery history at 50 and recovers admission after consumption", () => {
    const fake = fakeChildLayer();
    const projections: SubagentProjection[] = [];
    let deliveryAttempts = 0;
    const layer = serviceLayer({
      notify: (notification) => {
        if (notification.type !== "completed") return undefined;
        deliveryAttempts += 1;
        return { deliveredCompletionKeys: [] };
      },
      publish: (projection) => projections.push(projection),
    }).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      let firstId = "";
      for (let index = 0; index < 50; index += 1) {
        const run = yield* service.start(request({ name: `retained-${index + 1}` }));
        if (index === 0) firstId = run.id;
        fake.controls[index]?.offer({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: `Report ${index + 1}` }],
          },
        });
        fake.controls[index]?.offer({ type: "agent_settled" });
        yield* yieldUntil(
          () =>
            projections.at(-1)?.runs.find((candidate) => candidate.id === run.id)?.state ===
            "completed",
        );
        yield* yieldUntil(() => fake.controls[index]?.released() === 1);
      }
      yield* TestClock.adjust("100 millis");
      yield* yieldUntil(() => deliveryAttempts === 1);
      const capacity = yield* service
        .start(request({ name: "capacity-rejected" }))
        .pipe(Effect.flip);
      expect(capacity).toMatchObject({
        _tag: "SubagentHistoryCapacityError",
        code: "history_outbox_capacity",
        limit: 50,
      });
      expect(yield* service.list).toHaveLength(50);

      expect((yield* service.status(firstId)).finalText).toBe("Report 1");
      const recovered = yield* service.start(request({ name: "capacity-recovered" }));
      expect(recovered.state).toBe("running");
      const retained = yield* service.list;
      expect(retained).toHaveLength(50);
      expect(retained.some((run) => run.id === firstId)).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("retries an unacknowledged completion generation", () => {
    const fake = fakeChildLayer();
    const notifications: SubagentNotification[] = [];
    const projections: SubagentProjection[] = [];
    let attempts = 0;
    const layer = serviceLayer({
      notify: (notification) => {
        notifications.push(notification);
        if (notification.type !== "completed") return undefined;
        attempts += 1;
        return {
          deliveredCompletionKeys:
            attempts === 1 ? [] : notification.runs.map((run) => `${run.id}:${run.generation}`),
        };
      },
      publish: (projection) => projections.push(projection),
    }).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      yield* service.start(request({ name: "retry-notification" }));
      fake.controls[0]?.offer({ type: "agent_settled" });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "completed");

      yield* TestClock.adjust("100 millis");
      yield* yieldUntil(() => attempts === 1);
      yield* TestClock.adjust("200 millis");
      yield* yieldUntil(() => attempts === 2);
      yield* TestClock.adjust("500 millis");
      expect(attempts).toBe(2);
      expect(notifications).toHaveLength(2);
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("caps persistent completion retry backoff at thirty seconds", () => {
    const fake = fakeChildLayer();
    const projections: SubagentProjection[] = [];
    let attempts = 0;
    const layer = serviceLayer({
      notify: (notification) => {
        if (notification.type !== "completed") return undefined;
        attempts += 1;
        return { deliveredCompletionKeys: [] };
      },
      publish: (projection) => projections.push(projection),
    }).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      yield* service.start(request({ name: "persistent-retry" }));
      fake.controls[0]?.offer({ type: "agent_settled" });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "completed");
      for (const [index, delay] of [
        100, 200, 400, 800, 1_600, 3_200, 6_400, 12_800, 25_600, 30_000, 30_000,
      ].entries()) {
        yield* TestClock.adjust(`${delay} millis`);
        yield* yieldUntil(() => attempts === index + 1);
      }
      expect(attempts).toBe(11);
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("allows local display rename for stopped runs", () => {
    const fake = fakeChildLayer();
    const layer = serviceLayer().pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.start(request({ name: "stopped-name" }));
      expect((yield* service.stop(run.id)).state).toBe("stopped");

      const renamed = yield* service.rename(run.id, "renamed-stopped-run");
      expect(renamed).toMatchObject({ state: "stopped", name: "renamed-stopped-run" });
      expect(
        fake.controls[0]?.commands.some((command) => command.type === "set_session_name"),
      ).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("preserves terminal state, completion delivery, and local completed rename", () => {
    const fake = fakeChildLayer();
    const notifications: SubagentNotification[] = [];
    const projections: SubagentProjection[] = [];
    const layer = serviceLayer({
      notify: (notification) => notifications.push(notification),
      publish: (projection) => projections.push(projection),
    }).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const completedRun = yield* service.start(request({ name: "completed-name" }));
      fake.controls[0]?.offer({ type: "agent_settled" });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "completed");
      const before = projections.at(-1)?.runs.find((run) => run.id === completedRun.id);

      const renamed = yield* service.rename(completedRun.id, "retained-name");
      expect(renamed).toMatchObject({ state: "completed", name: "retained-name" });
      expect(
        fake.controls[0]?.commands.some((command) => command.type === "set_session_name"),
      ).toBe(false);
      const stoppedCompleted = yield* service.stop(completedRun.id);
      expect(stoppedCompleted.state).toBe("completed");
      expect(stoppedCompleted.endedAt).toBe(before?.endedAt);

      yield* TestClock.adjust("100 millis");
      yield* yieldUntil(() => notifications.some((item) => item.type === "completed"));
      expect(notifications).toMatchObject([
        { type: "completed", runs: [{ id: completedRun.id, name: "retained-name" }] },
      ]);

      const failedRun = yield* service.start(request({ name: "failed-name" }));
      fake.controls[1]?.exit(1);
      yield* yieldUntil(() =>
        Boolean(
          projections.at(-1)?.runs.some((run) => run.id === failedRun.id && run.state === "failed"),
        ),
      );
      const failedBeforeStop = projections
        .at(-1)
        ?.runs.find((candidate) => candidate.id === failedRun.id);
      for (let attempt = 0; attempt < 5 && notifications.length < 2; attempt += 1) {
        yield* Effect.yieldNow;
        yield* TestClock.adjust("100 millis");
      }
      expect(notifications.filter((item) => item.type === "completed")).toHaveLength(2);
      expect(notifications[1]).toMatchObject({
        type: "completed",
        runs: [
          {
            id: failedRun.id,
            name: "failed-name",
            generation: 1,
            outcome: "failed",
            error: expect.any(String),
          },
        ],
      });
      const stoppedFailed = yield* service.stop(failedRun.id);
      expect(stoppedFailed.state).toBe("failed");
      expect(stoppedFailed.endedAt).toBe(failedBeforeStop?.endedAt);
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("emits only one completion for repeated terminal events", () => {
    const fake = fakeChildLayer();
    const notifications: SubagentNotification[] = [];
    const projections: SubagentProjection[] = [];
    const layer = serviceLayer({
      notify: (notification) => notifications.push(notification),
      publish: (projection) => projections.push(projection),
    }).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.start(request({ name: "single-settlement" }));
      fake.controls[0]?.offer({ type: "agent_settled" });
      fake.controls[0]?.offer({ type: "agent_settled" });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "completed");
      yield* TestClock.adjust("100 millis");
      yield* yieldUntil(() => notifications.length > 0);
      yield* Effect.yieldNow;
      expect((yield* service.status(run.id)).state).toBe("completed");
      expect(
        notifications.filter((notification) => notification.type === "completed"),
      ).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("ignores child contact and lifecycle events after a run is terminal", () => {
    const fake = fakeChildLayer();
    const projections: SubagentProjection[] = [];
    const layer = serviceLayer({
      publish: (projection) => projections.push(projection),
    }).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.start(request({ name: "terminal-reader" }));
      fake.controls[0]?.offer({ type: "agent_settled" });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "completed");
      fake.controls[0]?.offerIpc({
        channel: "pi-subagents",
        type: "contact_parent",
        requestId: "late-question",
        kind: "question",
        message: "Too late?",
      });
      fake.controls[0]?.offer({ type: "agent_start" });
      fake.controls[0]?.offer({ type: "agent_settled" });
      yield* Effect.yieldNow;
      expect((yield* service.status(run.id)).state).toBe("completed");
      expect((yield* service.status(run.id)).question).toBeUndefined();
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("keeps a run stopped when startup finishes late", () =>
    Effect.gen(function* () {
      const spawnGate = yield* Deferred.make<void>();
      const cleanupOrder: string[] = [];
      const fake = fakeChildLayer(Deferred.await(spawnGate), {
        onRelease: () => cleanupOrder.push("backend"),
      });
      const projections: SubagentProjection[] = [];
      const layer = serviceLayer(
        { publish: (projection) => projections.push(projection) },
        profileLayerFor({}),
        fakeWriterLeaseLayer({ onRelease: () => cleanupOrder.push("lease") }),
      ).pipe(Layer.provide(fake.layer));

      yield* Effect.gen(function* () {
        const service = yield* SubagentService;
        const starting = yield* service
          .start(request({ name: "slow-start", writeIntent: "writer" }))
          .pipe(Effect.forkScoped);
        yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "starting");
        const id = projections.at(-1)?.runs[0]?.id;
        expect(id).toBeDefined();
        const stopping = yield* service.stop(id!).pipe(Effect.forkScoped);
        yield* Effect.yieldNow;
        expect(projections.at(-1)?.runs[0]?.state).toBe("stopping");
        yield* Deferred.succeed(spawnGate, undefined);
        expect((yield* Fiber.join(stopping)).state).toBe("stopped");
        yield* Fiber.await(starting);
        expect((yield* service.status(id!)).state).toBe("stopped");
        expect(fake.reclaimedRunIds).toContain(id);
        expect(cleanupOrder).toEqual(["backend", "lease"]);
      }).pipe(Effect.scoped, Effect.provide(layer));
    }),
  );

  it.effect("does not resume a completed writer while another writer owns the cwd", () => {
    const fake = fakeChildLayer();
    const projections: SubagentProjection[] = [];
    const layer = serviceLayer({
      publish: (projection) => projections.push(projection),
    }).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const first = yield* service.start(
        request({ name: "writer-one", writeIntent: "writer", task: "Implement auth" }),
      );
      fake.controls[0]?.offer({ type: "agent_settled" });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "completed");
      yield* service.start(
        request({ name: "writer-two", writeIntent: "writer", task: "Implement tests" }),
      );

      const conflict = yield* Effect.flip(service.resume(first.id, "Make another edit"));
      expect(conflict._tag).toBe("SubagentWriterConflictError");
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("terminates a child after malformed known protocol input", () => {
    const fake = fakeChildLayer();
    const projections: SubagentProjection[] = [];
    const layer = serviceLayer({
      publish: (projection) => projections.push(projection),
    }).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      yield* service.start(request({ name: "bad-protocol" }));
      fake.controls[0]?.offer({ type: "tool_execution_start" });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "failed");
      expect(fake.controls[0]?.terminations).toContain("force");
      fake.controls[0]?.offer({ type: "agent_start" });
      fake.controls[0]?.offer({ type: "agent_settled" });
      yield* Effect.yieldNow;
      expect((yield* service.list)[0]?.state).toBe("failed");
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("clears the delivered final report while a completed run resumes", () => {
    const fake = fakeChildLayer();
    const projections: SubagentProjection[] = [];
    const layer = serviceLayer({
      publish: (projection) => projections.push(projection),
    }).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.start(request({ name: "resume-report" }));
      fake.controls[0]?.offer({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "First report." }],
        },
      });
      fake.controls[0]?.offer({ type: "agent_settled" });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "completed");
      expect((yield* service.status(run.id)).finalText).toBe("First report.");

      const resumed = yield* service.resume(run.id, "Continue");
      expect(resumed.state).toBe("running");
      expect(resumed.finalText).toBeUndefined();
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("keeps a failed resume terminal and redacts the RPC error", () => {
    const fake = fakeChildLayer(Effect.void, {
      initialFailures: [{ spawnIndex: 1, type: "prompt", error: "token=secret-value" }],
    });
    const projections: SubagentProjection[] = [];
    const layer = serviceLayer({
      publish: (projection) => projections.push(projection),
    }).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.start(request({ name: "resume-failure" }));
      fake.controls[0]?.offer({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Preserved report." }],
        },
      });
      fake.controls[0]?.offer({ type: "agent_settled" });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "completed");

      const failure = yield* Effect.flip(service.resume(run.id, "Continue"));
      expect(failure.message).toContain("[REDACTED]");
      expect(failure.message).not.toContain("secret-value");
      const failed = yield* service.status(run.id);
      expect(failed.state).toBe("failed");
      expect(failed.finalText).toBe("Preserved report.");
      expect(fake.controls[1]?.terminations).toContain("force");
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("resolves completed-writer resume uncertainty and releases ownership on exit", () => {
    const fake = fakeChildLayer(Effect.void, {
      initialTransportFailures: [
        { spawnIndex: 1, type: "prompt", code: "transport_outcome_uncertain" },
      ],
    });
    const projections: SubagentProjection[] = [];
    const layer = serviceLayer({
      publish: (projection) => projections.push(projection),
    }).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.start(
        request({ name: "uncertain-completed-writer", writeIntent: "writer" }),
      );
      fake.controls[0]?.offer({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "First writer turn complete." }],
        },
      });
      fake.controls[0]?.offer({ type: "agent_settled" });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "completed");
      yield* yieldUntil(() => fake.controls[0]?.released() === 1);

      const failure = yield* service.resume(run.id, "Continue writer work.").pipe(Effect.flip);
      expect(failure).toMatchObject({ code: "resume_outcome_uncertain" });
      expect(fake.controls).toHaveLength(2);
      expect((yield* service.status(run.id)).state).toBe("starting");

      fake.controls[1]?.exit(1);
      yield* yieldUntil(() =>
        Boolean(
          projections
            .at(-1)
            ?.runs.some((candidate) => candidate.id === run.id && candidate.state === "failed"),
        ),
      );
      yield* yieldUntil(() => fake.controls[1]?.released() === 1);
      expect(fake.controls).toHaveLength(2);

      const replacement = yield* service.start(
        request({ name: "replacement-writer", writeIntent: "writer" }),
      );
      expect(replacement.state).toBe("running");
      expect(fake.controls).toHaveLength(3);
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("retains only the newest 50 terminal records", () => {
    const fake = fakeChildLayer();
    const layer = serviceLayer().pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      let firstId = "";
      for (let index = 0; index < 51; index += 1) {
        const run = yield* service.start(request({ name: `history-${index}` }));
        if (index === 0) firstId = run.id;
        yield* service.stop(run.id);
      }
      const history = yield* service.list;
      expect(history).toHaveLength(50);
      expect(history.some((run) => run.id === firstId)).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("keys the fast in-memory writer guard by canonical cwd aliases", () => {
    const fake = fakeChildLayer();
    let acquisitions = 0;
    const writerLeases = fakeWriterLeaseLayer({
      canonicalize: (cwd) => (cwd === "/project-alias" ? "/project" : cwd),
      onAcquire: () => {
        acquisitions += 1;
      },
    });
    const layer = serviceLayer({}, profileLayerFor({}), writerLeases).pipe(
      Layer.provide(fake.layer),
    );
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const first = yield* service.start(
        request({ name: "canonical-writer", writeIntent: "writer", cwd: "/project" }),
      );
      const aliasConflict = yield* service
        .start(request({ name: "alias-writer", writeIntent: "writer", cwd: "/project-alias" }))
        .pipe(Effect.flip);
      expect(aliasConflict).toMatchObject({
        _tag: "SubagentWriterConflictError",
        activeId: first.id,
      });
      expect(acquisitions).toBe(1);

      const other = yield* service.start(
        request({ name: "other-cwd-writer", writeIntent: "writer", cwd: "/other-project" }),
      );
      expect(other.state).toBe("running");
      expect(acquisitions).toBe(2);
      yield* service.stop(first.id);
      yield* service.stop(other.id);
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect(
    "keys the fast writer guard by filesystem identity even when canonical paths differ",
    () => {
      const fake = fakeChildLayer();
      let acquisitions = 0;
      const writerLeases = fakeWriterLeaseLayer({
        filesystemIdentity: (cwd) =>
          cwd === "/project-before-rename" || cwd === "/project-after-rename"
            ? "dev:1;ino:2"
            : `dev:1;ino:${cwd}`,
        onAcquire: () => {
          acquisitions += 1;
        },
      });
      const layer = serviceLayer({}, profileLayerFor({}), writerLeases).pipe(
        Layer.provide(fake.layer),
      );
      return Effect.gen(function* () {
        const service = yield* SubagentService;
        const first = yield* service.start(
          request({
            name: "identity-writer",
            writeIntent: "writer",
            cwd: "/project-before-rename",
          }),
        );
        const conflict = yield* service
          .start(
            request({
              name: "renamed-identity-writer",
              writeIntent: "writer",
              cwd: "/project-after-rename",
            }),
          )
          .pipe(Effect.flip);
        expect(conflict).toMatchObject({
          _tag: "SubagentWriterConflictError",
          activeId: first.id,
        });
        expect(acquisitions).toBe(1);
        yield* service.stop(first.id);
      }).pipe(Effect.scoped, Effect.provide(layer));
    },
  );

  it.effect("rejects Windows writers before canonicalization, lease acquisition, or spawn", () => {
    const fake = fakeChildLayer();
    let canonicalizations = 0;
    let acquisitions = 0;
    const writerLeases = fakeWriterLeaseLayer({
      platform: "win32",
      onCanonicalize: () => {
        canonicalizations += 1;
      },
      onAcquire: () => {
        acquisitions += 1;
      },
    });
    const layer = serviceLayer({}, profileLayerFor({}), writerLeases).pipe(
      Layer.provide(fake.layer),
    );
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const failure = yield* service
        .start(request({ name: "windows-writer", writeIntent: "writer" }))
        .pipe(Effect.flip);
      expect(failure).toMatchObject({
        _tag: "UnsupportedSafeWriterOwnershipError",
        code: "unsupported_safe_writer_ownership",
        platform: "win32",
      });
      expect(canonicalizations).toBe(0);
      expect(acquisitions).toBe(0);
      expect(fake.controls).toHaveLength(0);
      expect(yield* service.list).toEqual([]);

      const reader = yield* service.start(
        request({ name: "windows-reader", writeIntent: "read-only" }),
      );
      expect(reader.state).toBe("running");
      expect(fake.controls).toHaveLength(1);
      yield* service.stop(reader.id);
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("does not canonicalize or acquire a lease for read-only runs", () => {
    const fake = fakeChildLayer();
    let canonicalizations = 0;
    let acquisitions = 0;
    const writerLeases = fakeWriterLeaseLayer({
      onCanonicalize: () => {
        canonicalizations += 1;
      },
      onAcquire: () => {
        acquisitions += 1;
      },
    });
    const layer = serviceLayer({}, profileLayerFor({}), writerLeases).pipe(
      Layer.provide(fake.layer),
    );
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const reader = yield* service.start(request({ name: "reader", writeIntent: "read-only" }));
      expect(reader.state).toBe("running");
      expect(canonicalizations).toBe(0);
      expect(acquisitions).toBe(0);
      yield* service.stop(reader.id);
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("fails typed writer canonicalization before reservation or backend spawn", () => {
    const fake = fakeChildLayer();
    const writerLeases = fakeWriterLeaseLayer({ failCanonicalization: true });
    const layer = serviceLayer({}, profileLayerFor({}), writerLeases).pipe(
      Layer.provide(fake.layer),
    );
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const failure = yield* service
        .start(request({ name: "bad-cwd-writer", writeIntent: "writer" }))
        .pipe(Effect.flip);
      expect(failure).toMatchObject({
        _tag: "InvalidSubagentRequestError",
        code: "writer_cwd_canonicalization_failed",
      });
      expect(fake.controls).toHaveLength(0);
      expect(yield* service.list).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect(
    "settles a failed cross-process reservation without spawning or retaining the slot",
    () => {
      const fake = fakeChildLayer();
      const writerLeases = fakeWriterLeaseLayer({ failAcquire: true });
      const layer = serviceLayer({}, profileLayerFor({}), writerLeases).pipe(
        Layer.provide(fake.layer),
      );
      return Effect.gen(function* () {
        const service = yield* SubagentService;
        const conflict = yield* service
          .start(request({ name: "cross-process-conflict", writeIntent: "writer" }))
          .pipe(Effect.flip);
        expect(conflict).toMatchObject({
          _tag: "SubagentWriterConflictError",
          activeId: "other-run",
        });
        expect(fake.controls).toHaveLength(0);
        expect(yield* service.list).toEqual([
          expect.objectContaining({ name: "cross-process-conflict", state: "failed" }),
        ]);

        const admitted = yield* service.start(
          request({ name: "after-cross-process-conflict", writeIntent: "writer" }),
        );
        expect(admitted.state).toBe("running");
        expect(fake.controls).toHaveLength(1);
        yield* service.stop(admitted.id);
      }).pipe(Effect.scoped, Effect.provide(layer));
    },
  );

  it.effect("releases a stopped startup lease without ever spawning the backend", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      const projections: SubagentProjection[] = [];
      const fake = fakeChildLayer();
      let releases = 0;
      const writerLeases = fakeWriterLeaseLayer({
        acquireGate: gate,
        onRelease: () => {
          releases += 1;
        },
      });
      const layer = serviceLayer(
        { publish: (projection) => projections.push(projection) },
        profileLayerFor({}),
        writerLeases,
      ).pipe(Layer.provide(fake.layer));
      yield* Effect.gen(function* () {
        const service = yield* SubagentService;
        const starting = yield* service
          .start(request({ name: "stopped-during-lease", writeIntent: "writer" }))
          .pipe(Effect.exit, Effect.forkScoped);
        yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "starting");
        const id = projections.at(-1)?.runs[0]?.id;
        expect(id).toBeDefined();
        const stopping = yield* service.stop(id!).pipe(Effect.forkScoped);
        yield* Effect.yieldNow;
        yield* Deferred.succeed(gate, undefined);
        yield* TestClock.adjust("25 millis");
        expect((yield* Fiber.join(stopping)).state).toBe("stopped");
        expect(Exit.isFailure(yield* Fiber.join(starting))).toBe(true);
        expect(fake.controls).toHaveLength(0);
        expect(releases).toBe(1);
      }).pipe(Effect.scoped, Effect.provide(layer));
    }),
  );

  it.effect("acquires before spawn and releases only after backend cleanup confirms", () => {
    const order: string[] = [];
    const fake = fakeChildLayer(
      Effect.sync(() => void order.push("spawn")),
      {
        onRelease: () => void order.push("backend"),
      },
    );
    const writerLeases = fakeWriterLeaseLayer({
      onAcquire: () => void order.push("lease-acquire"),
      onMark: () => void order.push("lease-spawn-started"),
      onRelease: () => void order.push("lease-release"),
    });
    const layer = serviceLayer({}, profileLayerFor({}), writerLeases).pipe(
      Layer.provide(fake.layer),
    );
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const writer = yield* service.start(
        request({ name: "ordered-writer", writeIntent: "writer" }),
      );
      expect(order).toEqual(["lease-acquire", "lease-spawn-started", "spawn"]);
      yield* service.stop(writer.id);
      expect(order).toEqual([
        "lease-acquire",
        "lease-spawn-started",
        "spawn",
        "backend",
        "lease-release",
      ]);
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("does not spawn when the durable spawn-started mark fails", () => {
    const order: string[] = [];
    const fake = fakeChildLayer(Effect.sync(() => void order.push("spawn")));
    const writerLeases = fakeWriterLeaseLayer({
      failMark: true,
      onAcquire: () => void order.push("lease-acquire"),
      onMark: () => void order.push("lease-mark-attempt"),
      onRelease: () => void order.push("lease-release"),
    });
    const layer = serviceLayer({}, profileLayerFor({}), writerLeases).pipe(
      Layer.provide(fake.layer),
    );
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const failure = yield* service
        .start(request({ name: "mark-failure-writer", writeIntent: "writer" }))
        .pipe(Effect.flip);
      expect(failure).toMatchObject({
        _tag: "SubagentProcessError",
        code: "writer_lease_mark_failed",
      });
      expect(order).toEqual(["lease-acquire", "lease-mark-attempt", "lease-release"]);
      expect(fake.controls).toHaveLength(0);
      expect(yield* service.list).toEqual([
        expect.objectContaining({ name: "mark-failure-writer", state: "failed" }),
      ]);
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("marks a fresh lease before every backend respawn", () => {
    const order: string[] = [];
    const fake = fakeChildLayer(
      Effect.sync(() => void order.push("spawn")),
      {
        onRelease: () => void order.push("backend-release"),
      },
    );
    const writerLeases = fakeWriterLeaseLayer({
      onAcquire: () => void order.push("lease-acquire"),
      onMark: () => void order.push("lease-spawn-started"),
      onRelease: () => void order.push("lease-release"),
    });
    const projections: SubagentProjection[] = [];
    const layer = serviceLayer(
      { publish: (projection) => projections.push(projection) },
      profileLayerFor({}),
      writerLeases,
    ).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const writer = yield* service.start(
        request({ name: "respawn-mark-writer", writeIntent: "writer" }),
      );
      expect(order.slice(0, 3)).toEqual(["lease-acquire", "lease-spawn-started", "spawn"]);
      fake.controls[0]?.offer({ type: "agent_settled" });
      yield* yieldUntil(() =>
        projections.some((projection) => projection.runs[0]?.state === "completed"),
      );
      yield* yieldUntil(() => fake.controls[0]?.released() === 1);
      order.length = 0;

      const resumed = yield* service.resume(writer.id, "Continue after respawn.");
      expect(resumed.state).toBe("running");
      expect(order.slice(0, 3)).toEqual(["lease-acquire", "lease-spawn-started", "spawn"]);
      yield* service.stop(writer.id);
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("quarantines the session and retains ownership when lease release fails", () => {
    const fake = fakeChildLayer();
    let releases = 0;
    const writerLeases = fakeWriterLeaseLayer({
      failRelease: true,
      onRelease: () => {
        releases += 1;
      },
    });
    const layer = serviceLayer({}, profileLayerFor({}), writerLeases).pipe(
      Layer.provide(fake.layer),
    );
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const writer = yield* service.start(
        request({ name: "release-failure-writer", writeIntent: "writer" }),
      );
      const stopped = yield* service.stop(writer.id);
      expect(fake.controls[0]?.released()).toBe(1);
      expect(releases).toBe(1);
      expect(stopped).toMatchObject({
        state: "stopped",
        warning: expect.stringContaining("ownership remain quarantined"),
      });
      const conflict = yield* service
        .start(request({ name: "blocked-after-release-failure", writeIntent: "writer" }))
        .pipe(Effect.flip);
      expect(conflict).toMatchObject({
        _tag: "SubagentWriterConflictError",
        activeId: writer.id,
      });
      expect(fake.controls).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("closes every owned writer lease after backend cleanup on session shutdown", () => {
    const order: string[] = [];
    const fake = fakeChildLayer(Effect.void, {
      onRelease: (index) => void order.push(`backend-${index}`),
    });
    const writerLeases = fakeWriterLeaseLayer({
      onRelease: (lease) => void order.push(`lease-${lease.evidence.runId}`),
    });
    const layer = serviceLayer({}, profileLayerFor({}), writerLeases).pipe(
      Layer.provide(fake.layer),
    );
    return Effect.gen(function* () {
      const ids = yield* Effect.gen(function* () {
        const service = yield* SubagentService;
        const first = yield* service.start(
          request({ name: "shutdown-one", writeIntent: "writer", cwd: "/project-one" }),
        );
        const second = yield* service.start(
          request({ name: "shutdown-two", writeIntent: "writer", cwd: "/project-two" }),
        );
        return [first.id, second.id] as const;
      }).pipe(Effect.scoped, Effect.provide(layer));
      for (const [index, id] of ids.entries()) {
        const backendIndex = order.indexOf(`backend-${index}`);
        const leaseIndex = order.indexOf(`lease-${id}`);
        expect(backendIndex).toBeGreaterThanOrEqual(0);
        expect(leaseIndex).toBeGreaterThan(backendIndex);
      }
    });
  });

  it.effect("releases shared-cwd writer ownership after scope cleanup succeeds", () => {
    const fake = fakeChildLayer();
    const layer = serviceLayer().pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const first = yield* service.start(
        request({ name: "writer-one", writeIntent: "writer", task: "Implement auth" }),
      );
      const conflict = yield* Effect.flip(
        service.start(
          request({ name: "writer-two", writeIntent: "writer", task: "Implement tests" }),
        ),
      );
      expect(conflict._tag).toBe("SubagentWriterConflictError");

      const stopped = yield* service.stop(first.id);
      expect(stopped.state).toBe("stopped");
      expect(stopped.warning).toBeUndefined();
      expect(fake.controls[0]?.released()).toBe(1);
      const second = yield* service.start(
        request({ name: "writer-two", writeIntent: "writer", task: "Implement tests" }),
      );
      expect(second.state).toBe("running");
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("quarantines writer ownership when child scope cleanup defects", () => {
    const fake = fakeChildLayer(Effect.void, { releaseDefect: true });
    const layer = serviceLayer().pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const first = yield* service.start(
        request({ name: "defective-writer", writeIntent: "writer" }),
      );
      const stopped = yield* service.stop(first.id);
      expect(stopped).toMatchObject({
        state: "stopped",
        warning: expect.stringContaining("ownership remain quarantined"),
      });
      expect(fake.controls[0]?.released()).toBe(1);

      const conflict = yield* service
        .start(request({ name: "replacement-writer", writeIntent: "writer" }))
        .pipe(Effect.flip);
      expect(conflict).toMatchObject({
        _tag: "SubagentWriterConflictError",
        activeId: first.id,
        message: expect.stringContaining("cleanup could not be confirmed"),
      });
      expect(fake.controls).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("retains failed writer ownership until its child scope is released", () => {
    const fake = fakeChildLayer();
    const projections: SubagentProjection[] = [];
    const layer = serviceLayer({
      publish: (projection) => projections.push(projection),
    }).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      yield* service.start(request({ name: "failed-writer", writeIntent: "writer" }));
      fake.controls[0]?.offer({ type: "tool_execution_start" });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "failed");
      expect(fake.controls[0]?.released()).toBe(0);

      const conflict = yield* Effect.flip(
        service.start(request({ name: "next-writer", writeIntent: "writer" })),
      );
      expect(conflict._tag).toBe("SubagentWriterConflictError");

      fake.controls[0]?.exit(1);
      yield* yieldUntil(() => fake.controls[0]?.released() === 1);
      const next = yield* service.start(request({ name: "next-writer", writeIntent: "writer" }));
      expect(next.state).toBe("running");
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("fails an in-flight RPC promptly when stop sweeps its registration", () => {
    const fake = fakeChildLayer();
    const layer = serviceLayer().pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.start(request({ name: "stop-rpc" }));
      const sendGate = yield* Deferred.make<void>();
      fake.controls[0]?.gateNextSend("steer", sendGate);
      const sending = yield* service.send(run.id, "Continue").pipe(Effect.forkScoped);
      yield* yieldUntil(
        () => fake.controls[0]?.commands.some((command) => command.type === "steer") ?? false,
      );
      expect((yield* service.stop(run.id)).state).toBe("stopped");
      const error = yield* Fiber.join(sending).pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "SubagentProcessError", operation: "stop" });
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("fails an in-flight RPC promptly when the run protocol fails", () => {
    const fake = fakeChildLayer();
    const projections: SubagentProjection[] = [];
    const layer = serviceLayer({
      publish: (projection) => projections.push(projection),
    }).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.start(request({ name: "failed-rpc" }));
      const sendGate = yield* Deferred.make<void>();
      fake.controls[0]?.gateNextSend("steer", sendGate);
      const sending = yield* service.send(run.id, "Continue").pipe(Effect.forkScoped);
      yield* yieldUntil(
        () => fake.controls[0]?.commands.some((command) => command.type === "steer") ?? false,
      );
      fake.controls[0]?.offer({ type: "tool_execution_start" });
      const error = yield* Fiber.join(sending).pipe(Effect.flip);
      expect(error._tag).toBe("SubagentProtocolError");
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "failed");
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("finishes stop cleanup after the requesting fiber is interrupted", () => {
    const fake = fakeChildLayer();
    const projections: SubagentProjection[] = [];
    const layer = serviceLayer({
      publish: (projection) => projections.push(projection),
    }).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.start(request({ name: "cancel-safe-stop" }));
      const releaseGate = yield* Deferred.make<void>();
      fake.controls[0]?.gateRelease(releaseGate);
      const stopping = yield* service.stop(run.id).pipe(Effect.forkScoped);
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "stopping");
      yield* Fiber.interrupt(stopping);
      yield* Deferred.succeed(releaseGate, undefined);
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "stopped");
      expect(fake.controls[0]?.released()).toBe(1);
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("ignores a parent question that arrives after interruption", () => {
    const fake = fakeChildLayer();
    const projections: SubagentProjection[] = [];
    const layer = serviceLayer({
      publish: (projection) => projections.push(projection),
    }).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.start(request({ name: "late-question" }));
      expect((yield* service.interrupt(run.id)).state).toBe("paused");
      fake.controls[0]?.offerIpc({
        channel: "pi-subagents",
        type: "contact_parent",
        requestId: "late-question",
        kind: "question",
        message: "Too late?",
      });
      yield* Effect.yieldNow;
      const paused = yield* service.status(run.id);
      expect(paused.state).toBe("paused");
      expect(paused.question).toBeUndefined();
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("claims a parent question before sending its reply", () => {
    const fake = fakeChildLayer();
    const projections: SubagentProjection[] = [];
    const layer = serviceLayer({
      publish: (projection) => projections.push(projection),
    }).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.start(request({ name: "single-reply" }));
      fake.controls[0]?.offerIpc({
        channel: "pi-subagents",
        type: "contact_parent",
        requestId: "question-1",
        kind: "question",
        message: "Which answer?",
      });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "waiting_for_parent");
      const ipcGate = yield* Deferred.make<void>();
      fake.controls[0]?.gateNextIpc(ipcGate);
      const first = yield* service.reply(run.id, "First").pipe(Effect.forkScoped);
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "running");
      const second = yield* Effect.flip(service.reply(run.id, "Second"));
      expect(second._tag).toBe("InvalidSubagentRequestError");
      yield* Deferred.succeed(ipcGate, undefined);
      expect((yield* Fiber.join(first)).state).toBe("running");
      expect(fake.controls[0]?.ipc.filter((message) => message.type === "parent_reply")).toEqual([
        {
          channel: "pi-subagents",
          type: "parent_reply",
          requestId: "question-1",
          message: "First",
        },
      ]);
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("finishes a delivered parent reply after the requesting fiber is interrupted", () => {
    const fake = fakeChildLayer();
    const projections: SubagentProjection[] = [];
    const layer = serviceLayer({
      publish: (projection) => projections.push(projection),
    }).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.start(request({ name: "cancel-safe-reply" }));
      fake.controls[0]?.offerIpc({
        channel: "pi-subagents",
        type: "contact_parent",
        requestId: "question-1",
        kind: "question",
        message: "Which answer?",
      });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "waiting_for_parent");
      const ipcGate = yield* Deferred.make<void>();
      fake.controls[0]?.gateNextIpc(ipcGate);
      const replying = yield* service.reply(run.id, "First").pipe(Effect.forkScoped);
      yield* yieldUntil(
        () => fake.controls[0]?.ipc.some((message) => message.type === "parent_reply") ?? false,
      );

      yield* Fiber.interrupt(replying);
      const claimed = yield* service.status(run.id);
      expect(claimed.state).toBe("running");
      expect(claimed.question).toBeUndefined();
      expect((yield* Effect.flip(service.reply(run.id, "Second")))._tag).toBe(
        "InvalidSubagentRequestError",
      );

      yield* Deferred.succeed(ipcGate, undefined);
      yield* yieldUntil(() =>
        Boolean(
          projections
            .at(-1)
            ?.runs[0]?.sessionEvents.some(
              (event) => event.type === "notice" && event.text.includes("Reply: First"),
            ),
        ),
      );
      expect(
        fake.controls[0]?.ipc.filter((message) => message.type === "parent_reply"),
      ).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("rejects guidance that a parent reply claimed mid-transport", () => {
    const fake = fakeChildLayer();
    const projections: SubagentProjection[] = [];
    const layer = serviceLayer({
      publish: (projection) => projections.push(projection),
    }).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.start(request({ name: "steer-vs-reply" }));

      // Hold the steer transport open: `send` is past its guards but has recorded nothing.
      const steerGate = yield* Deferred.make<void>();
      fake.controls[0]?.gateNextSend("steer", steerGate);
      const sending = yield* service.send(run.id, "Continue").pipe(Effect.forkScoped);
      yield* yieldUntil(
        () => fake.controls[0]?.commands.some((command) => command.type === "steer") ?? false,
      );

      // A question arrives and the parent claims it while that steer is still in flight.
      fake.controls[0]?.offerIpc({
        channel: "pi-subagents",
        type: "contact_parent",
        requestId: "question-1",
        kind: "question",
        message: "Which answer?",
      });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "waiting_for_parent");
      const replyGate = yield* Deferred.make<void>();
      fake.controls[0]?.gateNextIpc(replyGate);
      const replying = yield* service.reply(run.id, "Answer").pipe(Effect.forkScoped);
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "running");

      // The run is "running" again, so only the reply claim can reject the guidance.
      yield* Deferred.succeed(steerGate, undefined);
      const failure = yield* Fiber.join(sending).pipe(Effect.flip);
      expect(failure).toMatchObject({
        _tag: "InvalidSubagentRequestError",
        code: "guidance_outcome_uncertain",
      });
      expect(failure.message).toContain("may already have applied");
      expect(failure.message).toContain("subagent_status");

      yield* Deferred.succeed(replyGate, undefined);
      expect((yield* Fiber.join(replying)).state).toBe("running");
      const { sessionEvents } = yield* service.status(run.id);
      const notices = sessionEvents.filter((event) => event.type === "notice");
      expect(notices.some((event) => event.text.includes("Guidance:"))).toBe(false);
      expect(notices.some((event) => event.text.includes("Reply: Answer"))).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect(
    "maps ambiguous send, reply, interrupt, and resume outcomes without unsafe rollback",
    () => {
      const fake = fakeChildLayer();
      const projections: SubagentProjection[] = [];
      const layer = serviceLayer({ publish: (projection) => projections.push(projection) }).pipe(
        Layer.provide(fake.layer),
      );
      return Effect.gen(function* () {
        const service = yield* SubagentService;
        const run = yield* service.start(request({ name: "uncertain-controls" }));

        fake.controls[0]?.failTransportNext("steer", "transport_outcome_uncertain");
        const sendFailure = yield* service.send(run.id, "Potential guidance.").pipe(Effect.flip);
        expect(sendFailure).toMatchObject({ code: "guidance_outcome_uncertain" });
        expect((yield* service.status(run.id)).state).toBe("running");

        fake.controls[0]?.offerIpc({
          channel: "pi-subagents",
          type: "contact_parent",
          requestId: "uncertain-question",
          kind: "question",
          message: "Apply this?",
        });
        yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "waiting_for_parent");
        fake.controls[0]?.failNextIpc("transport_outcome_uncertain");
        const replyFailure = yield* service.reply(run.id, "Yes.").pipe(Effect.flip);
        expect(replyFailure).toMatchObject({ code: "reply_outcome_uncertain" });
        expect((yield* service.status(run.id)).state).toBe("running");
        expect(
          (yield* service.reply(run.id, "Do not duplicate.").pipe(Effect.flip)).message,
        ).toContain("no pending parent question");
        fake.controls[0]?.offerIpc({
          channel: "pi-subagents",
          type: "contact_parent",
          requestId: "uncertain-question",
          kind: "question",
          message: "Duplicate request ID",
        });
        yield* Effect.yieldNow;
        expect((yield* service.status(run.id)).state).toBe("running");

        fake.controls[0]?.offerIpc({
          channel: "pi-subagents",
          type: "contact_parent",
          requestId: "authoritative-new-question",
          kind: "question",
          message: "A distinct next request?",
        });
        yield* yieldUntil(() =>
          Boolean(
            projections
              .at(-1)
              ?.runs.some(
                (candidate) => candidate.id === run.id && candidate.state === "waiting_for_parent",
              ),
          ),
        );
        expect((yield* service.reply(run.id, "Resolved.")).state).toBe("running");

        const interruptRun = yield* service.start(request({ name: "uncertain-interrupt" }));
        fake.controls[1]?.dropNext("abort");
        const interrupting = yield* service.interrupt(interruptRun.id).pipe(Effect.forkScoped);
        yield* TestClock.adjust("10 seconds");
        expect(yield* Fiber.join(interrupting).pipe(Effect.flip)).toMatchObject({
          code: "interrupt_outcome_uncertain",
        });

        const resumeRun = yield* service.start(request({ name: "uncertain-resume" }));
        expect((yield* service.interrupt(resumeRun.id)).state).toBe("paused");
        fake.controls[2]?.failTransportNext("prompt", "transport_outcome_uncertain");
        const resumeFailure = yield* service
          .resume(resumeRun.id, "Continue once.")
          .pipe(Effect.flip);
        expect(resumeFailure).toMatchObject({ code: "resume_outcome_uncertain" });
        const uncertain = yield* service.status(resumeRun.id);
        expect(uncertain.state).toBe("starting");
        expect(uncertain.warning).toContain("may already have applied");
      }).pipe(Effect.scoped, Effect.provide(layer));
    },
  );

  it.effect("clears an uncertain reply claim after terminal settlement and a resumed turn", () => {
    const fake = fakeChildLayer();
    const projections: SubagentProjection[] = [];
    const layer = serviceLayer({ publish: (projection) => projections.push(projection) }).pipe(
      Layer.provide(fake.layer),
    );
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.start(request({ name: "reply-resolution" }));
      fake.controls[0]?.offerIpc({
        channel: "pi-subagents",
        type: "contact_parent",
        requestId: "uncertain-terminal-question",
        kind: "question",
        message: "Finish this turn?",
      });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "waiting_for_parent");
      fake.controls[0]?.failNextIpc("transport_outcome_uncertain");
      expect(yield* service.reply(run.id, "Finish.").pipe(Effect.flip)).toMatchObject({
        code: "reply_outcome_uncertain",
      });
      fake.controls[0]?.offer({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "Turn resolved." }] },
      });
      fake.controls[0]?.offer({ type: "agent_settled" });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "completed");
      yield* yieldUntil(() => fake.controls[0]?.released() === 1);

      expect((yield* service.resume(run.id, "Next turn.")).state).toBe("running");
      fake.controls[1]?.offerIpc({
        channel: "pi-subagents",
        type: "contact_parent",
        requestId: "resumed-question",
        kind: "question",
        message: "Question in resumed turn?",
      });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "waiting_for_parent");
      expect((yield* service.reply(run.id, "Answered.")).state).toBe("running");
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("keeps warnings in projection and session history without host notification", () => {
    const fake = fakeChildLayer();
    const notifications: SubagentNotification[] = [];
    const projections: SubagentProjection[] = [];
    const layer = serviceLayer({
      notify: (notification) => notifications.push(notification),
      publish: (projection) => projections.push(projection),
    }).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.start(request({ name: "bounded-notices" }));
      for (const [kind, message] of [
        ["progress", "First progress"],
        ["progress", "Second progress"],
        ["warning", "First warning"],
        ["warning", "Second warning"],
      ] as const)
        fake.controls[0]?.offerIpc({
          channel: "pi-subagents",
          type: "contact_parent",
          requestId: `${kind}-${message}`,
          kind,
          message,
        });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.warning === "Second warning");
      expect(notifications).toEqual([]);

      fake.controls[0]?.offer({
        type: "extension_error",
        error: "Extension bridge failed token=secret-value",
      });
      yield* yieldUntil(() =>
        Boolean(projections.at(-1)?.runs[0]?.warning?.includes("Extension bridge failed")),
      );
      expect(notifications).toEqual([]);
      const status = yield* service.status(run.id);
      expect(status.progress).toBe("Second progress");
      expect(status.warning).toContain("Extension bridge failed");
      expect(status.warning).not.toContain("secret-value");
      expect(
        status.sessionEvents.filter((event) => event.type === "notice" && event.kind === "warning"),
      ).toHaveLength(3);

      fake.controls[0]?.offer({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "Final report." }] },
      });
      fake.controls[0]?.offer({ type: "agent_settled" });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "completed");
      yield* TestClock.adjust("100 millis");
      yield* yieldUntil(() => notifications.length === 1);
      expect(notifications).toMatchObject([
        {
          type: "completed",
          runs: [
            {
              id: run.id,
              outcome: "completed",
              finalText: "Final report.",
              warning: expect.stringContaining("Extension bridge failed"),
            },
          ],
        },
      ]);
      const completion = notifications[0];
      expect(completion?.type).toBe("completed");
      if (completion?.type === "completed") {
        expect(completion.runs[0]?.warning).toContain("System warning: Extension bridge failed");
        expect(completion.runs[0]?.warning).toContain("Child warning: Second warning");
        expect(completion.runs[0]?.warning).not.toContain("First warning");
        expect(completion.runs[0]?.warning).not.toContain("secret-value");
      }
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("folds child and system warnings into a failed outcome", () => {
    const fake = fakeChildLayer();
    const notifications: SubagentNotification[] = [];
    const projections: SubagentProjection[] = [];
    const layer = serviceLayer({
      notify: (notification) => notifications.push(notification),
      publish: (projection) => projections.push(projection),
    }).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.start(request({ name: "warning-failure" }));
      fake.controls[0]?.offerIpc({
        channel: "pi-subagents",
        type: "contact_parent",
        requestId: "child-risk",
        kind: "warning",
        message: "Child validation is incomplete.",
      });
      yield* yieldUntil(
        () => projections.at(-1)?.runs[0]?.warning === "Child validation is incomplete.",
      );
      fake.controls[0]?.offer({
        type: "extension_error",
        error: "Extension transport degraded.",
      });
      yield* yieldUntil(
        () => projections.at(-1)?.runs[0]?.warning === "Extension transport degraded.",
      );
      fake.controls[0]?.exit(1);
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "failed");
      yield* TestClock.adjust("100 millis");
      yield* yieldUntil(() => notifications.length === 1);
      expect(notifications).toMatchObject([
        {
          type: "completed",
          runs: [
            {
              id: run.id,
              outcome: "failed",
              warning: expect.stringContaining("System warning: Extension transport degraded."),
            },
          ],
        },
      ]);
      const notification = notifications[0];
      expect(notification?.type).toBe("completed");
      if (notification?.type === "completed")
        expect(notification.runs[0]?.warning).toContain(
          "Child warning: Child validation is incomplete.",
        );
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("retries actionable question delivery once without warning interference", () => {
    const fake = fakeChildLayer();
    let attempts = 0;
    const delivered: SubagentNotification[] = [];
    const projections: SubagentProjection[] = [];
    const layer = serviceLayer({
      publish: (projection) => projections.push(projection),
      notify: (notification) => {
        if (notification.type === "completed") return undefined;
        attempts += 1;
        if (attempts === 1) throw new Error("transient parent delivery failure");
        delivered.push(notification);
        return {
          deliveredActionKeys: [`${notification.id}:question:default:${notification.generation}`],
        };
      },
    }).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.start(request({ name: "retry-actions" }));
      fake.controls[0]?.offerIpc({
        channel: "pi-subagents",
        type: "contact_parent",
        requestId: "retry-question",
        kind: "question",
        message: "Retry this question?",
      });
      yield* yieldUntil(() => attempts === 1);

      fake.controls[0]?.offerIpc({
        channel: "pi-subagents",
        type: "contact_parent",
        requestId: "projection-warning",
        kind: "warning",
        message: "Keep this warning in status only.",
      });
      yield* yieldUntil(
        () => projections.at(-1)?.runs[0]?.warning === "Keep this warning in status only.",
      );
      expect(attempts).toBe(1);

      yield* TestClock.adjust("200 millis");
      yield* yieldUntil(() => delivered.length === 1);
      yield* TestClock.adjust("30 seconds");
      expect(attempts).toBe(2);
      expect(delivered).toMatchObject([{ type: "question", message: "Retry this question?" }]);
      expect((yield* service.status(run.id)).state).toBe("waiting_for_parent");
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("restarts question delivery after a stale queue drains to idle", () => {
    const fake = fakeChildLayer();
    const attempts: Array<Extract<SubagentNotification, { type: "question" }>> = [];
    const layer = serviceLayer({
      notify: (notification) => {
        if (notification.type === "completed") return undefined;
        attempts.push(notification);
        return notification.requestId === "stale-question"
          ? { deliveredActionKeys: [] }
          : {
              deliveredActionKeys: [
                `${notification.id}:question:default:${notification.generation}`,
              ],
            };
      },
    }).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.start(request({ name: "action-idle-restart" }));
      fake.controls[0]?.offerIpc({
        channel: "pi-subagents",
        type: "contact_parent",
        requestId: "stale-question",
        kind: "question",
        message: "This will become stale.",
      });
      yield* yieldUntil(() => attempts.some((value) => value.requestId === "stale-question"));
      yield* service.reply(run.id, "Resolved before retry.");
      yield* TestClock.adjust("200 millis");

      fake.controls[0]?.offerIpc({
        channel: "pi-subagents",
        type: "contact_parent",
        requestId: "new-question",
        kind: "question",
        message: "Delivery after idle?",
      });
      yield* yieldUntil(() => attempts.some((value) => value.requestId === "new-question"));
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("keeps currentTool accurate while parallel tools finish", () => {
    const fake = fakeChildLayer();
    const projections: SubagentProjection[] = [];
    const layer = serviceLayer({
      publish: (projection) => projections.push(projection),
    }).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.start(request({ name: "parallel-tools" }));
      fake.controls[0]?.offer({
        type: "tool_execution_start",
        toolCallId: "tool-a",
        toolName: "read",
        args: {},
      });
      fake.controls[0]?.offer({
        type: "tool_execution_start",
        toolCallId: "tool-b",
        toolName: "grep",
        args: {},
      });
      fake.controls[0]?.offer({
        type: "tool_execution_end",
        toolCallId: "tool-a",
        toolName: "read",
        result: {},
        isError: false,
      });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.currentTool === "grep");
      expect((yield* service.status(run.id)).currentTool).toBe("grep");
      fake.controls[0]?.offer({
        type: "tool_execution_end",
        toolCallId: "tool-b",
        toolName: "grep",
        result: {},
        isError: false,
      });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.currentTool === undefined);
      expect((yield* service.status(run.id)).currentTool).toBeUndefined();
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("times out when an RPC transport write never completes", () => {
    const fake = fakeChildLayer();
    const layer = serviceLayer().pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.start(request({ name: "blocked-write" }));
      const sendGate = yield* Deferred.make<void>();
      fake.controls[0]?.gateNextSend("steer", sendGate);
      const sending = yield* service.send(run.id, "Continue").pipe(Effect.forkScoped);
      yield* yieldUntil(
        () => fake.controls[0]?.commands.some((command) => command.type === "steer") ?? false,
      );
      yield* TestClock.adjust("10 seconds");
      const failure = yield* Fiber.join(sending).pipe(Effect.flip);
      expect(failure).toMatchObject({
        _tag: "SubagentProcessError",
        operation: "await RPC response from",
      });
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("fails pending RPCs immediately after a schema-invalid event", () => {
    const fake = fakeChildLayer();
    const projections: SubagentProjection[] = [];
    const layer = serviceLayer({
      publish: (projection) => projections.push(projection),
    }).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.start(request({ name: "invalid-event-rpc" }));
      fake.controls[0]?.dropNext("set_session_name");
      const renaming = yield* service.rename(run.id, "renamed").pipe(Effect.forkScoped);
      yield* yieldUntil(
        () =>
          fake.controls[0]?.commands.some((command) => command.type === "set_session_name") ??
          false,
      );
      fake.controls[0]?.offer({ type: "tool_execution_start" });
      const failure = yield* Fiber.join(renaming).pipe(Effect.flip);
      expect(failure._tag).toBe("SubagentProtocolError");
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "failed");
      expect((yield* service.status(run.id)).name).toBe("invalid-event-rpc");
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("rejects oversized parent messages before transport", () => {
    const fake = fakeChildLayer();
    const layer = serviceLayer().pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.start(request({ name: "bounded-message" }));
      const failure = yield* Effect.flip(service.send(run.id, "x".repeat(64 * 1024 + 1)));
      expect(failure._tag).toBe("InvalidSubagentRequestError");
      expect(fake.controls[0]?.commands.filter((command) => command.type === "steer")).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("silently releases children when the session runtime is replaced", () => {
    const fake = fakeChildLayer();
    const notifications: SubagentNotification[] = [];
    const layer = serviceLayer({
      notify: (notification) => notifications.push(notification),
    }).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const service = yield* SubagentService;
        yield* service.start(request());
      }).pipe(Effect.scoped, Effect.provide(layer));

      expect(fake.controls[0]?.released()).toBe(1);
      expect(notifications).toEqual([]);
    });
  });
});
