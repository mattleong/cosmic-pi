// Explicit test entry-point Layer provision owns each scoped service runtime.
// @effect-diagnostics effect/strictEffectProvide:off
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import type { SubagentNotification } from "../src/boundary/host-notifier.ts";
import { resolveSubagentConfig } from "../src/config/options.ts";
import { decodeSubagentConfig } from "../src/config/schema.ts";
import { makeSubagentProfileService, SubagentProfileService } from "../src/profiles/service.ts";
import type { ParentReply, PeerNotice, RpcCommand } from "../src/run/protocol.ts";
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
  readonly offerClaude: (value: unknown) => void;
  readonly exit: (exitCode?: number | null) => void;
}

function fakeChildLayer(
  beforeSpawn: Effect.Effect<void, never, never> = Effect.void,
  options: {
    readonly dropInitialState?: boolean;
    readonly dropInitialStateAttempts?: number;
    readonly releaseDefect?: boolean;
    readonly stateThinkingLevel?: string;
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
    readonly initialBeforeResponses?: ReadonlyArray<{
      readonly spawnIndex: number;
      readonly type: RpcCommand["type"];
      readonly value: unknown;
    }>;
  } = {},
) {
  const controls: FakeChildControl[] = [];
  let nextSpawnIndex = 0;
  let remainingInitialStateDrops =
    options.dropInitialStateAttempts ?? (options.dropInitialState ? Number.POSITIVE_INFINITY : 0);
  const layer: Layer.Layer<ChildProcess> = Layer.succeed(ChildProcess, {
    spawn: (launch) =>
      Effect.acquireRelease(
        Effect.gen(function* () {
          const spawnIndex = nextSpawnIndex++;
          yield* beforeSpawn;
          const events = yield* Queue.unbounded<ChildWireEvent, Cause.Done>();
          const exited = yield* Deferred.make<Extract<ChildWireEvent, { readonly type: "exit" }>>();
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
          }> = (options.initialBeforeResponses ?? [])
            .filter((response) => response.spawnIndex === spawnIndex)
            .map(({ type, value }) => ({ type, value }));
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
          const offerClaude = (value: unknown) =>
            Queue.offerUnsafe(events, { type: "claude_message", value });
          const exit = (exitCode: number | null = 0) => {
            Queue.endUnsafe(events);
            Deferred.doneUnsafe(exited, Effect.succeed({ type: "exit", exitCode, stderr: "" }));
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
                if (before) {
                  if (launch.backend === "claude-cli") offerClaude(before.value);
                  else offer(before.value);
                }
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
                                sessionFile: "/tmp/child-session.jsonl",
                                thinkingLevel: options.stateThinkingLevel ?? "high",
                                model:
                                  launch.backend === "claude-cli"
                                    ? "claude-sonnet-resolved"
                                    : {
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
            offerClaude,
            exit,
          });
          return {
            handle,
            release: Effect.gen(function* () {
              if (releaseGate) yield* Deferred.await(releaseGate);
              releaseCount += 1;
              Queue.endUnsafe(events);
              if (options.releaseDefect) return yield* Effect.die("fixture release defect");
            }),
          };
        }),
        ({ release }) => release,
      ).pipe(Effect.map(({ handle }) => handle)),
  });
  return { controls, layer };
}

const profileLayerFor = (global: unknown) =>
  Layer.succeed(
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

const serviceLayer = (options: SubagentServiceOptions = {}, profiles = profileLayerFor({})) =>
  SubagentService["layer"](options).pipe(Layer.provideMerge(profiles));

const request = (overrides: Partial<StartSubagentRequest> = {}): StartSubagentRequest => ({
  backend: "pi",
  task: "Inspect authentication",
  cwd: "/project",
  execution: "background",
  context: "fresh",
  writeIntent: "read-only",
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

  it.effect("reauthorizes hard-denied models before reserving or spawning a run", () => {
    const fake = fakeChildLayer();
    const layer = serviceLayer(
      {},
      profileLayerFor({
        denied: [{ backend: "pi", model: "openai-codex/gpt-5.6-sol" }],
      }),
    ).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const failure = yield* Effect.flip(service.start(request()));
      expect(failure).toMatchObject({
        _tag: "InvalidSubagentRequestError",
        code: "model_denied",
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
      expect(completed.usage.totalTokens).toBe(12);
      expect(completed.sessionEvents).toMatchObject([
        { type: "tool", toolName: "read", target: "src/auth.ts", state: "completed" },
        { type: "assistant", text: "Review complete." },
      ]);
    }).pipe(Effect.scoped, Effect.provide(layer));
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

  it.effect("terminates a completed Claude process and restores its session ID", () => {
    const fake = fakeChildLayer();
    const projections: SubagentProjection[] = [];
    const layer = serviceLayer({
      publish: (projection) => projections.push(projection),
    }).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.start(
        request({ backend: "claude-cli", model: "sonnet", name: "resume-claude" }),
      );
      fake.controls[0]?.offerClaude({
        type: "result",
        subtype: "success",
        result: "Done for now.",
      });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "completed");
      yield* yieldUntil(() => fake.controls[0]?.released() === 1);

      const resumed = yield* service.resume(run.id, "Continue the Claude session.");
      expect(resumed.state).toBe("running");
      expect(fake.controls[1]?.launch.resumeSessionId).toBe("child-session");
      expect(fake.controls[1]?.launch.resumeSessionFile).toBeUndefined();
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("exposes backend capabilities and rejects unsupported Claude controls", () => {
    const fake = fakeChildLayer();
    const projections: SubagentProjection[] = [];
    const layer = serviceLayer({
      publish: (projection) => projections.push(projection),
    }).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const untrusted = yield* Effect.flip(
        service.start(request({ backend: "claude-cli", model: "sonnet", projectTrusted: false })),
      );
      expect(untrusted).toMatchObject({
        _tag: "InvalidSubagentRequestError",
        message: "Claude CLI subagents require a trusted project.",
      });
      expect(fake.controls).toHaveLength(0);

      const invalidModel = yield* Effect.flip(
        service.start(request({ backend: "claude-cli", model: "--permission-mode" })),
      );
      expect(invalidModel).toMatchObject({
        _tag: "InvalidSubagentRequestError",
        message:
          'Claude model must be fable, sonnet, opus, haiku, or a full model ID beginning with "claude" (at most 128 characters).',
      });
      const nonClaudeModel = yield* Effect.flip(
        service.start(request({ backend: "claude-cli", model: "gpt-4o" })),
      );
      expect(nonClaudeModel).toMatchObject({
        _tag: "InvalidSubagentRequestError",
        message:
          'Claude model must be fable, sonnet, opus, haiku, or a full model ID beginning with "claude" (at most 128 characters).',
      });
      const providerStyleClaudeModel = yield* Effect.flip(
        service.start(request({ backend: "claude-cli", model: "claude/opus" })),
      );
      expect(providerStyleClaudeModel).toMatchObject({
        _tag: "InvalidSubagentRequestError",
        code: "claude_model_invalid",
      });
      expect(fake.controls).toHaveLength(0);

      const run = yield* service.start(
        request({ backend: "claude-cli", model: "sonnet", name: "claude-reader" }),
      );
      expect(run.backend).toBe("claude-cli");
      expect(run.model).toBe("claude-sonnet-resolved");
      expect(run.capabilities).toEqual(["resume", "rename-display"]);
      expect(fake.controls[0]?.commands.map((command) => command.type)).toEqual([
        "prompt",
        "get_state",
      ]);

      const renamed = yield* service.rename(run.id, "claude-local-name");
      expect(renamed.name).toBe("claude-local-name");
      expect(
        fake.controls[0]?.commands.some((command) => command.type === "set_session_name"),
      ).toBe(false);

      const steering = yield* Effect.flip(service.send(run.id, "Check tests too."));
      expect(steering).toMatchObject({
        _tag: "UnsupportedSubagentCapabilityError",
        backend: "claude-cli",
        capability: "steer",
        message: expect.stringContaining(`subagent_await({ runIds: ["${run.id}"]`),
      });
      const interrupting = yield* Effect.flip(service.interrupt(run.id));
      expect(interrupting).toMatchObject({
        _tag: "UnsupportedSubagentCapabilityError",
        capability: "interrupt",
        message: expect.stringContaining(
          `subagent_lifecycle({ action: "stop", runIds: ["${run.id}"] })`,
        ),
      });
      expect(fake.controls[0]?.commands.some((command) => command.type === "steer")).toBe(false);
      expect(fake.controls[0]?.commands.some((command) => command.type === "abort")).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("allows local display rename while a run is still starting", () => {
    const fake = fakeChildLayer(Effect.void, { dropInitialState: true });
    const layer = serviceLayer().pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const starting = yield* service
        .start(request({ name: "initial-name" }))
        .pipe(Effect.forkScoped);
      yield* yieldUntil(
        () => fake.controls[0]?.commands.some((command) => command.type === "get_state") ?? false,
      );
      const [run] = yield* service.list;
      expect(run?.state).toBe("starting");

      const renamed = yield* service.rename(run!.id, "renamed-while-starting");
      expect(renamed).toMatchObject({ state: "starting", name: "renamed-while-starting" });
      expect((yield* service.status(run!.id)).name).toBe("renamed-while-starting");

      yield* Fiber.interrupt(starting);
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("allows a longer readiness window for Claude initialization", () => {
    const fake = fakeChildLayer(Effect.void, { dropInitialState: true });
    const projections: SubagentProjection[] = [];
    const layer = serviceLayer({
      publish: (projection) => projections.push(projection),
    }).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const starting = yield* service
        .start(request({ backend: "claude-cli", model: "sonnet", name: "slow-claude" }))
        .pipe(Effect.forkScoped);
      yield* yieldUntil(
        () => fake.controls[0]?.commands.some((command) => command.type === "get_state") ?? false,
      );

      yield* TestClock.adjust("10 seconds");
      expect(projections.at(-1)?.runs[0]?.state).toBe("starting");

      yield* TestClock.adjust("50 seconds");
      yield* TestClock.adjust("250 millis");
      yield* yieldUntil(
        () => fake.controls[1]?.commands.some((command) => command.type === "get_state") ?? false,
      );
      expect(fake.controls).toHaveLength(2);
      expect(projections.at(-1)?.runs[0]?.state).toBe("starting");

      yield* TestClock.adjust("60 seconds");
      const failure = yield* Fiber.join(starting).pipe(Effect.flip);
      expect(failure).toMatchObject({
        _tag: "SubagentProcessError",
        operation: "await RPC response from",
      });
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("bootstraps each transient Claude initialization attempt with the task", () => {
    const fake = fakeChildLayer(Effect.void, { dropInitialStateAttempts: 1 });
    const layer = serviceLayer().pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const starting = yield* service
        .start(request({ backend: "claude-cli", model: "sonnet", name: "retry-claude" }))
        .pipe(Effect.forkScoped);
      yield* yieldUntil(
        () => fake.controls[0]?.commands.some((command) => command.type === "get_state") ?? false,
      );
      expect(fake.controls[0]?.commands.map((command) => command.type)).toEqual([
        "prompt",
        "get_state",
      ]);

      yield* TestClock.adjust("60 seconds");
      yield* TestClock.adjust("250 millis");
      const started = yield* Fiber.join(starting);
      expect(started.state).toBe("running");
      expect(fake.controls).toHaveLength(2);
      expect(fake.controls[1]?.commands.map((command) => command.type)).toEqual([
        "prompt",
        "get_state",
      ]);
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect(
    "commits Claude initialization before an immediate terminal result closes scope",
    () => {
      const fake = fakeChildLayer(Effect.void, {
        initialBeforeResponses: [
          {
            spawnIndex: 0,
            type: "prompt",
            value: {
              type: "result",
              subtype: "success",
              is_error: false,
              result: "Immediate terminal report.",
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          },
        ],
      });
      const layer = serviceLayer().pipe(Layer.provide(fake.layer));
      return Effect.gen(function* () {
        const service = yield* SubagentService;
        const run = yield* service.start(
          request({ backend: "claude-cli", model: "sonnet", name: "immediate-claude" }),
        );
        expect(run).toMatchObject({
          state: "completed",
          sessionId: "child-session",
          model: "claude-sonnet-resolved",
          finalText: "Immediate terminal report.",
        });
        expect(fake.controls).toHaveLength(1);
        expect(fake.controls[0]?.commands.map((command) => command.type)).toEqual([
          "prompt",
          "get_state",
        ]);
      }).pipe(Effect.scoped, Effect.provide(layer));
    },
  );

  it.effect("never retries a Claude writer after its task frame may have been accepted", () => {
    const fake = fakeChildLayer(Effect.void, { dropInitialStateAttempts: 1 });
    const layer = serviceLayer().pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const starting = yield* service
        .start(
          request({
            backend: "claude-cli",
            model: "sonnet",
            name: "uncertain-writer",
            writeIntent: "writer",
          }),
        )
        .pipe(Effect.forkScoped);
      yield* yieldUntil(
        () => fake.controls[0]?.commands.some((command) => command.type === "get_state") ?? false,
      );
      yield* TestClock.adjust("60 seconds");
      const failure = yield* Fiber.join(starting).pipe(Effect.flip);
      expect(failure).toMatchObject({
        _tag: "SubagentProcessError",
        code: "start_outcome_uncertain",
      });
      expect(fake.controls).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("maps Claude stream events into the shared run projection", () => {
    const fake = fakeChildLayer();
    const projections: SubagentProjection[] = [];
    const layer = serviceLayer({
      publish: (projection) => projections.push(projection),
    }).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.start(
        request({ backend: "claude-cli", model: "sonnet", name: "claude-stream" }),
      );
      fake.controls[0]?.offerClaude({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "Reading authentication." },
            {
              type: "tool_use",
              id: "tool-claude",
              name: "Read",
              input: { file_path: "src/auth.ts" },
            },
          ],
        },
      });
      fake.controls[0]?.offerClaude({
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "tool-claude", content: "source" }],
        },
      });
      const finalReport = "Claude review\ncomplete.";
      fake.controls[0]?.offerClaude({
        type: "assistant",
        message: { content: [{ type: "text", text: finalReport }] },
      });
      fake.controls[0]?.offerClaude({
        type: "result",
        subtype: "success",
        is_error: false,
        result: finalReport,
        total_cost_usd: 0.02,
        usage: { input_tokens: 10, output_tokens: 5 },
      });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "completed");

      const completed = yield* service.status(run.id);
      expect(completed.finalText).toBe(finalReport);
      expect(completed.usage).toMatchObject({ input: 10, output: 5, totalTokens: 15, cost: 0.02 });
      expect(completed.sessionEvents).toMatchObject([
        { type: "assistant", text: "Reading authentication." },
        { type: "tool", toolName: "Read", target: "src/auth.ts", state: "completed" },
        { type: "assistant", text: finalReport },
      ]);
      expect(
        completed.sessionEvents.filter(
          (event) => event.type === "assistant" && event.text === finalReport,
        ),
      ).toHaveLength(1);

      const resumed = yield* service.resume(run.id, "Check one more thing.");
      expect(resumed.state).toBe("running");
      expect(fake.controls[1]?.launch.resumeSessionId).toBe("child-session");
      expect(fake.controls[1]?.commands.map((command) => command.type)).toEqual([
        "prompt",
        "get_state",
      ]);
      expect(fake.controls[1]?.commands[0]).toMatchObject({
        type: "prompt",
        message: "Check one more thing.",
      });
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("clips an oversized Claude final result instead of failing the run", () => {
    const fake = fakeChildLayer();
    const projections: SubagentProjection[] = [];
    const layer = serviceLayer({
      publish: (projection) => projections.push(projection),
    }).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.start(
        request({ backend: "claude-cli", model: "sonnet", name: "large-result" }),
      );
      fake.controls[0]?.offerClaude({
        type: "result",
        subtype: "success",
        result: "x".repeat(1024 * 1024 + 1),
        usage: { input_tokens: "future-shape" },
      });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "completed");
      const completed = yield* service.status(run.id);
      expect(completed.finalText?.length).toBe(32 * 1024 + 1);
      expect(completed.finalText?.endsWith("…")).toBe(true);
      expect(completed.usage.totalTokens).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect(
    "surfaces Claude limit warnings without treating unavailable overage as rejection",
    () => {
      const fake = fakeChildLayer();
      const notifications: SubagentNotification[] = [];
      const projections: SubagentProjection[] = [];
      const layer = serviceLayer({
        publish: (projection) => projections.push(projection),
        notify: (notification) => notifications.push(notification),
      }).pipe(Layer.provide(fake.layer));
      return Effect.gen(function* () {
        const service = yield* SubagentService;
        const run = yield* service.start(
          request({ backend: "claude-cli", model: "sonnet", name: "claude-limit-warning" }),
        );
        fake.controls[0]?.offerClaude({
          type: "rate_limit_event",
          rate_limit_info: {
            status: "allowed",
            rateLimitType: "five_hour",
            overageStatus: "rejected",
            overageDisabledReason: "org_level_disabled",
          },
        });
        yield* Effect.yieldNow;
        expect((yield* service.status(run.id)).warning).toBeUndefined();

        fake.controls[0]?.offerClaude({
          type: "rate_limit_event",
          rate_limit_info: {
            status: "allowed_warning",
            rateLimitType: "five_hour",
            utilization: 0.85,
            resetsAt: 7_200,
          },
        });
        yield* yieldUntil(() => projections.at(-1)?.runs[0]?.warning !== undefined);
        const warning = yield* service.status(run.id);
        expect(warning.state).toBe("running");
        expect(warning.warning).toContain(
          "approaching its five hour limit (85% used); resets in 2h",
        );
        expect(notifications).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: "warning",
              id: run.id,
              name: "claude-limit-warning",
              message: warning.warning,
              triggerTurn: false,
              generation: expect.any(Number),
            }),
          ]),
        );

        fake.controls[0]?.offerClaude({
          type: "rate_limit_event",
          rate_limit_info: {
            status: "allowed_warning",
            rateLimitType: "five_hour",
            utilization: 0.89,
            resetsAt: 7_200,
          },
        });
        yield* yieldUntil(() =>
          Boolean(projections.at(-1)?.runs[0]?.warning?.includes("89% used")),
        );
        expect(notifications.filter((value) => value.type === "warning")).toHaveLength(1);

        fake.controls[0]?.offerClaude({
          type: "rate_limit_event",
          rate_limit_info: {
            status: "allowed_warning",
            rateLimitType: "five_hour",
            utilization: 0.91,
            resetsAt: 7_200,
          },
        });
        yield* yieldUntil(
          () => notifications.filter((value) => value.type === "warning").length === 2,
        );

        fake.controls[0]?.offerClaude({
          type: "rate_limit_event",
          rate_limit_info: {
            status: "allowed_warning",
            rateLimitType: "five_hour",
            utilization: 0.94,
            resetsAt: 7_200,
          },
        });
        yield* yieldUntil(() =>
          Boolean(projections.at(-1)?.runs[0]?.warning?.includes("94% used")),
        );
        expect(notifications.filter((value) => value.type === "warning")).toHaveLength(2);

        fake.controls[0]?.offerClaude({
          type: "rate_limit_event",
          rate_limit_info: {
            status: "allowed_warning",
            rateLimitType: "five_hour",
            utilization: 0.96,
            resetsAt: 7_200,
          },
        });
        yield* yieldUntil(
          () => notifications.filter((value) => value.type === "warning").length === 3,
        );

        fake.controls[0]?.offerClaude({
          type: "rate_limit_event",
          rate_limit_info: {
            status: "allowed_warning",
            rateLimitType: "five_hour",
            utilization: 0.85,
            resetsAt: 10_800,
          },
        });
        yield* yieldUntil(
          () => notifications.filter((value) => value.type === "warning").length === 4,
        );

        fake.controls[0]?.offerClaude({
          type: "rate_limit_event",
          rate_limit_info: { status: "rejected", rateLimitType: "five_hour" },
        });
        yield* yieldUntil(() =>
          Boolean(projections.at(-1)?.runs[0]?.warning?.includes("was rejected")),
        );
        expect(notifications.filter((value) => value.type === "warning")).toHaveLength(5);
        expect(
          (yield* service.status(run.id)).sessionEvents.filter(
            (event) => event.type === "notice" && event.kind === "warning",
          ),
        ).toHaveLength(5);
        fake.controls[0]?.offerClaude({
          type: "rate_limit_event",
          rate_limit_info: { status: "allowed", rateLimitType: "five_hour" },
        });
        yield* yieldUntil(() => projections.at(-1)?.runs[0]?.warning === undefined);
        yield* TestClock.adjust("2 seconds");
        expect((yield* service.status(run.id)).state).toBe("running");
      }).pipe(Effect.scoped, Effect.provide(layer));
    },
  );

  it.effect(
    "correlates rejected settlement by limit key instead of cancelling it with another window",
    () => {
      const fake = fakeChildLayer();
      const projections: SubagentProjection[] = [];
      const layer = serviceLayer({ publish: (projection) => projections.push(projection) }).pipe(
        Layer.provide(fake.layer),
      );
      return Effect.gen(function* () {
        const service = yield* SubagentService;
        const run = yield* service.start(
          request({ backend: "claude-cli", model: "sonnet", name: "mixed-limits" }),
        );
        fake.controls[0]?.offerClaude({
          type: "rate_limit_event",
          rate_limit_info: {
            status: "rejected",
            rateLimitType: "five_hour",
            overageStatus: "rejected",
          },
        });
        fake.controls[0]?.offerClaude({
          type: "rate_limit_event",
          rate_limit_info: { status: "allowed", rateLimitType: "seven_day" },
        });
        yield* yieldUntil(() => projections.at(-1)?.runs[0]?.warning !== undefined);
        yield* TestClock.adjust("2 seconds");
        yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "failed");
        expect((yield* service.status(run.id)).error).toContain("five hour limit");
      }).pipe(Effect.scoped, Effect.provide(layer));
    },
  );

  it.effect(
    "retains failed actionable retries for two rejected limit windows through settlement",
    () => {
      const fake = fakeChildLayer();
      const attempts = new Map<string, number>();
      const delivered: SubagentNotification[] = [];
      let allowDelivery = false;
      const projections: SubagentProjection[] = [];
      const layer = serviceLayer({
        publish: (projection) => projections.push(projection),
        notify: (notification) => {
          if (notification.type !== "warning") return undefined;
          attempts.set(notification.message, (attempts.get(notification.message) ?? 0) + 1);
          if (!allowDelivery) return { deliveredActionKeys: [] };
          delivered.push(notification);
          return {
            deliveredActionKeys: [
              `${notification.id}:warning:${notification.slotKey ?? "default"}:${notification.generation}`,
            ],
          };
        },
      }).pipe(Layer.provide(fake.layer));
      return Effect.gen(function* () {
        const service = yield* SubagentService;
        yield* service.start(
          request({ backend: "claude-cli", model: "sonnet", name: "two-rejections" }),
        );
        fake.controls[0]?.offerClaude({
          type: "rate_limit_event",
          rate_limit_info: {
            status: "rejected",
            rateLimitType: "five_hour",
            overageStatus: "rejected",
            resetsAt: 7_200,
          },
        });
        fake.controls[0]?.offerClaude({
          type: "rate_limit_event",
          rate_limit_info: {
            status: "rejected",
            rateLimitType: "seven_day",
            overageStatus: "rejected",
            resetsAt: 604_800,
          },
        });
        yield* yieldUntil(() => attempts.size === 2);
        yield* TestClock.adjust("2 seconds");
        yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "failed");
        expect(delivered).toEqual([]);

        allowDelivery = true;
        yield* TestClock.adjust("4 seconds");
        yield* yieldUntil(() => delivered.length === 2);
        expect(delivered.map((notification) => notification.type)).toEqual(["warning", "warning"]);
        expect(
          delivered.some(
            (notification) =>
              notification.type === "warning" && notification.message.includes("five hour limit"),
          ),
        ).toBe(true);
        expect(
          delivered.some(
            (notification) =>
              notification.type === "warning" && notification.message.includes("seven day limit"),
          ),
        ).toBe(true);
        yield* TestClock.adjust("30 seconds");
        expect(delivered).toHaveLength(2);
      }).pipe(Effect.scoped, Effect.provide(layer));
    },
  );

  it.effect(
    "clears turn-local rate state on completion/resume while preserving window thresholds",
    () => {
      const fake = fakeChildLayer();
      const notifications: SubagentNotification[] = [];
      const projections: SubagentProjection[] = [];
      const layer = serviceLayer({
        notify: (notification) => notifications.push(notification),
        publish: (projection) => projections.push(projection),
      }).pipe(Layer.provide(fake.layer));
      return Effect.gen(function* () {
        const service = yield* SubagentService;
        const run = yield* service.start(
          request({ backend: "claude-cli", model: "sonnet", name: "resume-limits" }),
        );
        const warning = {
          type: "rate_limit_event",
          rate_limit_info: {
            status: "allowed_warning",
            rateLimitType: "five_hour",
            utilization: 0.85,
            resetsAt: 7_200,
          },
        } as const;
        fake.controls[0]?.offerClaude(warning);
        yield* yieldUntil(() => notifications.some((value) => value.type === "warning"));
        fake.controls[0]?.offerClaude({
          type: "result",
          subtype: "success",
          result: "Done.",
        });
        yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "completed");
        expect((yield* service.status(run.id)).warning).toBeUndefined();
        yield* yieldUntil(() => fake.controls[0]?.released() === 1);

        const resumed = yield* service.resume(run.id, "Continue.");
        expect(resumed.warning).toBeUndefined();
        fake.controls[1]?.offerClaude(warning);
        yield* Effect.yieldNow;
        expect(notifications.filter((value) => value.type === "warning")).toHaveLength(1);
      }).pipe(Effect.scoped, Effect.provide(layer));
    },
  );

  it.effect("keeps paid-overage Claude requests running with clear allowance wording", () => {
    const fake = fakeChildLayer();
    const notifications: SubagentNotification[] = [];
    const projections: SubagentProjection[] = [];
    const layer = serviceLayer({
      publish: (projection) => projections.push(projection),
      notify: (notification) => notifications.push(notification),
    }).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.start(
        request({ backend: "claude-cli", model: "sonnet", name: "claude-paid-overage" }),
      );
      const rateLimitEvent = {
        type: "rate_limit_event",
        rate_limit_info: {
          status: "rejected",
          rateLimitType: "five_hour",
          utilization: 1,
          resetsAt: 3_600,
          overageStatus: "allowed",
          isUsingOverage: true,
        },
      } as const;
      fake.controls[0]?.offerClaude(rateLimitEvent);
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.warning !== undefined);

      const warning = yield* service.status(run.id);
      expect(warning.warning).toBe(
        "Claude exhausted its five hour allowance (100% used); resets in 1h; continuing with paid overage.",
      );
      expect(notifications).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "warning",
            id: run.id,
            name: "claude-paid-overage",
            message: warning.warning,
            triggerTurn: false,
            generation: expect.any(Number),
          }),
        ]),
      );

      fake.controls[0]?.offerClaude(rateLimitEvent);
      yield* Effect.yieldNow;
      expect(notifications.filter((value) => value.type === "warning")).toHaveLength(1);
      yield* TestClock.adjust("2 seconds");
      expect((yield* service.status(run.id)).state).toBe("running");
      expect(fake.controls[0]?.terminations).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("keeps Claude running when paid usage credits are available", () => {
    const fake = fakeChildLayer();
    const notifications: SubagentNotification[] = [];
    const projections: SubagentProjection[] = [];
    const layer = serviceLayer({
      publish: (projection) => projections.push(projection),
      notify: (notification) => notifications.push(notification),
    }).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.start(
        request({ backend: "claude-cli", model: "sonnet", name: "claude-credits" }),
      );
      fake.controls[0]?.offerClaude({
        type: "rate_limit_event",
        rate_limit_info: {
          status: "rejected",
          rateLimitType: "five_hour",
          resetsAt: 3_600,
          overageStatus: "allowed",
          isUsingOverage: false,
        },
      });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.warning !== undefined);

      const warning = yield* service.status(run.id);
      expect(warning.warning).toBe(
        "Claude exhausted its five hour allowance; resets in 1h; paid overage is available.",
      );
      expect(notifications).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "warning",
            id: run.id,
            name: "claude-credits",
            message: warning.warning,
            triggerTurn: false,
            generation: expect.any(Number),
          }),
        ]),
      );

      yield* TestClock.adjust("2 seconds");
      expect((yield* service.status(run.id)).state).toBe("running");
      expect(fake.controls[0]?.terminations).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("defers ambiguous Claude limit events to the authoritative result", () => {
    const fake = fakeChildLayer();
    const projections: SubagentProjection[] = [];
    const layer = serviceLayer({
      publish: (projection) => projections.push(projection),
    }).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.start(
        request({ backend: "claude-cli", model: "sonnet", name: "claude-ambiguous-limit" }),
      );
      fake.controls[0]?.offerClaude({
        type: "rate_limit_event",
        rate_limit_info: { status: "rejected", rateLimitType: "five_hour" },
      });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.warning !== undefined);
      yield* TestClock.adjust("2 seconds");

      expect((yield* service.status(run.id)).state).toBe("running");
      expect(fake.controls[0]?.terminations).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("waits briefly for a Claude result before failing a rejected limit", () => {
    const fake = fakeChildLayer();
    const notifications: SubagentNotification[] = [];
    const projections: SubagentProjection[] = [];
    const layer = serviceLayer({
      publish: (projection) => projections.push(projection),
      notify: (notification) => notifications.push(notification),
    }).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.start(
        request({ backend: "claude-cli", model: "opus", name: "claude-limit-rejected" }),
      );
      fake.controls[0]?.offerClaude({
        type: "rate_limit_event",
        rate_limit_info: {
          status: "rejected",
          rateLimitType: "seven_day_opus",
          utilization: 1,
          resetsAt: 3_600,
          overageStatus: "rejected",
          overageDisabledReason: "out_of_credits",
        },
      });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.warning !== undefined);
      expect((yield* service.status(run.id)).state).toBe("running");

      yield* TestClock.adjust("1 second");
      fake.controls[0]?.offerClaude({
        type: "result",
        subtype: "error",
        is_error: true,
        errors: ["You've hit your Opus limit."],
        usage: { input_tokens: 3, output_tokens: 1 },
      });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "failed");
      yield* TestClock.adjust("2 seconds");

      const failed = yield* service.status(run.id);
      expect(failed.error).toBe("You've hit your Opus limit.");
      expect(failed.usage).toMatchObject({ input: 3, output: 1, totalTokens: 4 });
      expect(notifications.filter((value) => value.type === "warning")).toHaveLength(1);
      expect(fake.controls[0]?.terminations).toEqual(["force"]);
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("fails a Claude turn whose rejected limit produces no result", () => {
    const fake = fakeChildLayer();
    const projections: SubagentProjection[] = [];
    const layer = serviceLayer({
      publish: (projection) => projections.push(projection),
    }).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.start(
        request({ backend: "claude-cli", model: "opus", name: "claude-limit-hung" }),
      );
      fake.controls[0]?.offerClaude({
        type: "rate_limit_event",
        rate_limit_info: {
          status: "rejected",
          rateLimitType: "five_hour",
          overageStatus: "rejected",
          overageDisabledReason: "org_level_disabled",
        },
      });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.warning !== undefined);
      yield* TestClock.adjust("2 seconds");
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "failed");

      const failed = yield* service.status(run.id);
      expect(failed.error).toContain("rejected by its five hour limit");
      expect(failed.error).toContain("paid overage unavailable (org level disabled)");
      expect(fake.controls[0]?.terminations).toEqual(["force"]);
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("retains Claude usage when an error result fails the run", () => {
    const fake = fakeChildLayer();
    const projections: SubagentProjection[] = [];
    const layer = serviceLayer({
      publish: (projection) => projections.push(projection),
    }).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.start(
        request({ backend: "claude-cli", model: "sonnet", name: "claude-failure" }),
      );
      fake.controls[0]?.offerClaude({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        errors: ["Claude request failed."],
        total_cost_usd: 0.04,
        usage: { input_tokens: 8, output_tokens: 3 },
      });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "failed");

      const failed = yield* service.status(run.id);
      expect(failed.error).toBe("Claude request failed.");
      expect(failed.usage).toMatchObject({ input: 8, output: 3, totalTokens: 11, cost: 0.04 });
      expect(fake.controls[0]?.terminations).toContain("force");
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
      const first = yield* service.start(request({ name: "reader-one", execution: "foreground" }));
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

      const waiting = yield* service.waitForForeground(first.id);
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

  it.effect("notifies after a foreground waiter returns on a blocking question", () => {
    const fake = fakeChildLayer();
    const notifications: SubagentNotification[] = [];
    const projections: SubagentProjection[] = [];
    const layer = serviceLayer({
      notify: (notification) => notifications.push(notification),
      publish: (projection) => projections.push(projection),
    }).pipe(Layer.provide(fake.layer));

    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.start(
        request({ name: "foreground-reader", execution: "foreground" }),
      );
      fake.controls[0]?.offerIpc({
        channel: "pi-subagents",
        type: "contact_parent",
        requestId: "question-1",
        kind: "question",
        message: "First question?",
      });
      const waiting = yield* service.waitForForeground(run.id);
      expect(waiting.state).toBe("waiting_for_parent");
      expect(notifications).toEqual([]);
      yield* service.reply(run.id, "First answer.");

      fake.controls[0]?.offerIpc({
        channel: "pi-subagents",
        type: "contact_parent",
        requestId: "question-2",
        kind: "question",
        message: "Second question?",
      });
      yield* yieldUntil(() => notifications.length === 1);
      expect(notifications[0]).toMatchObject({
        type: "question",
        requestId: "question-2",
      });
      yield* service.reply(run.id, "Second answer.");
      fake.controls[0]?.offer({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Foreground report." }],
        },
      });
      fake.controls[0]?.offer({ type: "agent_settled" });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "completed");
      yield* TestClock.adjust("100 millis");
      yield* yieldUntil(() => notifications.length === 2);
      expect(notifications[1]).toMatchObject({
        type: "completed",
        runs: [{ id: run.id, finalText: "Foreground report." }],
      });
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect(
    "requeues a foreground report when a later batch start is gated and the owner cancels",
    () => {
      let spawnCount = 0;
      let secondSpawnGate!: Deferred.Deferred<void>;
      const fake = fakeChildLayer(
        Effect.suspend(() => (++spawnCount === 2 ? Deferred.await(secondSpawnGate) : Effect.void)),
      );
      const notifications: SubagentNotification[] = [];
      const projections: SubagentProjection[] = [];
      const layer = serviceLayer({
        notify: (notification) => notifications.push(notification),
        publish: (projection) => projections.push(projection),
      }).pipe(Layer.provide(fake.layer));
      return Effect.gen(function* () {
        secondSpawnGate = yield* Deferred.make<void>();
        const service = yield* SubagentService;
        const batch = yield* service
          .withForegroundStartObservation(
            request({ name: "batch-foreground", execution: "foreground" }),
            (_started, awaitObservation) =>
              Effect.gen(function* () {
                const background = yield* service
                  .startSessionOwned(request({ name: "gated-background" }))
                  .pipe(Effect.forkScoped);
                yield* Fiber.join(background);
                return yield* awaitObservation;
              }),
          )
          .pipe(Effect.forkScoped);
        yield* yieldUntil(() => spawnCount === 2);
        fake.controls[0]?.offer({
          type: "message_end",
          message: { role: "assistant", content: [{ type: "text", text: "Held report." }] },
        });
        fake.controls[0]?.offer({ type: "agent_settled" });
        yield* yieldUntil(
          () =>
            projections
              .at(-1)
              ?.runs.some(
                (candidate) =>
                  candidate.name === "batch-foreground" && candidate.state === "completed",
              ) === true,
        );

        yield* Fiber.interrupt(batch);
        yield* TestClock.adjust("100 millis");
        yield* yieldUntil(() => notifications.some((value) => value.type === "completed"));
        expect(notifications).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: "completed",
              runs: [expect.objectContaining({ finalText: "Held report." })],
            }),
          ]),
        );
        yield* Deferred.succeed(secondSpawnGate, undefined);
      }).pipe(Effect.scoped, Effect.provide(layer));
    },
  );

  it.effect(
    "requeues a foreground question when a later batch start is gated and the owner cancels",
    () => {
      let spawnCount = 0;
      let secondSpawnGate!: Deferred.Deferred<void>;
      const fake = fakeChildLayer(
        Effect.suspend(() => (++spawnCount === 2 ? Deferred.await(secondSpawnGate) : Effect.void)),
      );
      const notifications: SubagentNotification[] = [];
      const projections: SubagentProjection[] = [];
      const layer = serviceLayer({
        notify: (notification) => notifications.push(notification),
        publish: (projection) => projections.push(projection),
      }).pipe(Layer.provide(fake.layer));
      return Effect.gen(function* () {
        secondSpawnGate = yield* Deferred.make<void>();
        const service = yield* SubagentService;
        const batch = yield* service
          .withForegroundStartObservation(
            request({ name: "batch-question", execution: "foreground" }),
            (_started, awaitObservation) =>
              Effect.gen(function* () {
                const background = yield* service
                  .startSessionOwned(request({ name: "gated-question-peer" }))
                  .pipe(Effect.forkScoped);
                yield* Fiber.join(background);
                return yield* awaitObservation;
              }),
          )
          .pipe(Effect.forkScoped);
        yield* yieldUntil(() => spawnCount === 2);
        fake.controls[0]?.offerIpc({
          channel: "pi-subagents",
          type: "contact_parent",
          requestId: "held-question",
          kind: "question",
          message: "Which branch?",
        });
        yield* yieldUntil(
          () =>
            projections
              .at(-1)
              ?.runs.some(
                (candidate) =>
                  candidate.name === "batch-question" && candidate.state === "waiting_for_parent",
              ) === true,
        );

        yield* Fiber.interrupt(batch);
        yield* yieldUntil(() => notifications.some((value) => value.type === "question"));
        expect(notifications).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: "question",
              requestId: "held-question",
              message: "Which branch?",
            }),
          ]),
        );
        yield* Deferred.succeed(secondSpawnGate, undefined);
      }).pipe(Effect.scoped, Effect.provide(layer));
    },
  );

  it.effect("releases a foreground waiter when the run is interrupted", () => {
    const fake = fakeChildLayer();
    const layer = serviceLayer().pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.start(
        request({ name: "foreground-pause", execution: "foreground" }),
      );
      const waiting = yield* service.waitForForeground(run.id).pipe(Effect.forkScoped);
      const paused = yield* service.interrupt(run.id);
      expect(paused.state).toBe("paused");
      expect((yield* Fiber.join(waiting)).state).toBe("paused");
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
      expect(observations[0]?.completionReceipt).toEqual({ id: run.id, generation: 1 });
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

  it.effect("retains 51 unacknowledged completion reports after failed delivery", () => {
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
      for (let index = 0; index < 51; index += 1) {
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
      const retained = yield* service.list;
      expect(retained).toHaveLength(51);
      expect(retained.find((run) => run.id === firstId)?.finalText).toBe("Report 1");
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
      fake.controls[1]?.offer({ type: "tool_execution_start" });
      yield* yieldUntil(() =>
        Boolean(
          projections.at(-1)?.runs.some((run) => run.id === failedRun.id && run.state === "failed"),
        ),
      );
      const failedBeforeStop = yield* service.status(failedRun.id);
      const stoppedFailed = yield* service.stop(failedRun.id);
      expect(stoppedFailed.state).toBe("failed");
      expect(stoppedFailed.endedAt).toBe(failedBeforeStop.endedAt);
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
      const fake = fakeChildLayer(Deferred.await(spawnGate));
      const projections: SubagentProjection[] = [];
      const layer = serviceLayer({
        publish: (projection) => projections.push(projection),
      }).pipe(Layer.provide(fake.layer));

      yield* Effect.gen(function* () {
        const service = yield* SubagentService;
        const starting = yield* service
          .start(request({ name: "slow-start" }))
          .pipe(Effect.forkScoped);
        yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "starting");
        const id = projections.at(-1)?.runs[0]?.id;
        expect(id).toBeDefined();
        const stopped = yield* service.stop(id!);
        expect(stopped.state).toBe("stopped");
        yield* Deferred.succeed(spawnGate, undefined);
        yield* Fiber.await(starting);
        expect((yield* service.status(id!)).state).toBe("stopped");
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
        request({
          backend: "claude-cli",
          model: "sonnet",
          name: "uncertain-completed-writer",
          writeIntent: "writer",
        }),
      );
      fake.controls[0]?.offerClaude({
        type: "result",
        subtype: "success",
        result: "First writer turn complete.",
      });
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

  it.effect("rejects a second shared-cwd writer until the first writer stops", () => {
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
      const second = yield* service.start(
        request({ name: "writer-two", writeIntent: "writer", task: "Implement tests" }),
      );
      expect(second.state).toBe("running");
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("releases writer ownership even when child scope cleanup defects", () => {
    const fake = fakeChildLayer(Effect.void, { releaseDefect: true });
    const layer = serviceLayer().pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const first = yield* service.start(
        request({ name: "defective-writer", writeIntent: "writer" }),
      );
      expect((yield* service.stop(first.id)).state).toBe("stopped");
      expect(fake.controls[0]?.released()).toBe(1);

      const second = yield* service.start(
        request({ name: "replacement-writer", writeIntent: "writer" }),
      );
      expect(second.state).toBe("running");
      expect((yield* service.stop(second.id)).state).toBe("stopped");
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

  it.effect("delivers distinct warnings while triggering only the first warning turn", () => {
    const fake = fakeChildLayer();
    const notifications: SubagentNotification[] = [];
    const layer = serviceLayer({
      notify: (notification) => notifications.push(notification),
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
      yield* yieldUntil(() => notifications.length === 2);
      expect(notifications).toMatchObject([
        { type: "warning", message: "First warning", triggerTurn: true },
        { type: "warning", message: "Second warning", triggerTurn: false },
      ]);

      fake.controls[0]?.offer({
        type: "extension_error",
        error: "Extension bridge failed token=secret-value",
      });
      yield* yieldUntil(() => notifications.length === 3);
      expect(notifications[2]).toMatchObject({ type: "warning", triggerTurn: false });
      const extensionWarning = notifications[2];
      expect(extensionWarning?.type).toBe("warning");
      if (extensionWarning?.type === "warning")
        expect(extensionWarning.message).not.toContain("secret-value");
      const status = yield* service.status(run.id);
      expect(status.progress).toBe("Second progress");
      expect(status.warning).toContain("Extension bridge failed");
      expect(status.warning).not.toContain("secret-value");
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect(
    "retries actionable question, warning, and rate-limit delivery once without duplicates",
    () => {
      const fake = fakeChildLayer();
      const attempts = new Map<string, number>();
      const delivered: SubagentNotification[] = [];
      const layer = serviceLayer({
        notify: (notification) => {
          if (notification.type === "completed") return undefined;
          const key = notification.type === "question" ? "question" : notification.message;
          const attempt = (attempts.get(key) ?? 0) + 1;
          attempts.set(key, attempt);
          if (attempt === 1) throw new Error("transient parent delivery failure");
          delivered.push(notification);
          return {
            deliveredActionKeys: [
              `${notification.id}:${notification.type}:${notification.type === "warning" ? (notification.slotKey ?? "default") : "default"}:${notification.generation}`,
            ],
          };
        },
      }).pipe(Layer.provide(fake.layer));
      return Effect.gen(function* () {
        const service = yield* SubagentService;
        const run = yield* service.start(
          request({ backend: "claude-cli", model: "sonnet", name: "retry-actions" }),
        );
        fake.controls[0]?.offerIpc({
          channel: "pi-subagents",
          type: "contact_parent",
          requestId: "retry-question",
          kind: "question",
          message: "Retry this question?",
        });
        yield* yieldUntil(() => attempts.get("question") === 1);

        // A distinct warning must not supersede the still-undelivered question generation.
        fake.controls[0]?.offerIpc({
          channel: "pi-subagents",
          type: "contact_parent",
          requestId: "retry-warning",
          kind: "warning",
          message: "Retry this warning.",
        });
        yield* yieldUntil(() => delivered.some((notification) => notification.type === "question"));
        yield* yieldUntil(() => attempts.get("Retry this warning.") === 1);
        yield* TestClock.adjust("200 millis");
        yield* yieldUntil(() =>
          delivered.some(
            (notification) =>
              notification.type === "warning" && notification.message === "Retry this warning.",
          ),
        );

        fake.controls[0]?.offerClaude({
          type: "rate_limit_event",
          rate_limit_info: {
            status: "allowed_warning",
            rateLimitType: "seven_day",
            utilization: 0.81,
            resetsAt: 7_200,
          },
        });
        const rateMessage = "Claude is approaching its seven day limit (81% used); resets in 2h.";
        yield* yieldUntil(() => attempts.get(rateMessage) === 1);
        yield* TestClock.adjust("200 millis");
        yield* yieldUntil(() =>
          delivered.some(
            (notification) =>
              notification.type === "warning" && notification.message === rateMessage,
          ),
        );
        yield* TestClock.adjust("30 seconds");
        expect(delivered.filter((notification) => notification.type === "question")).toHaveLength(
          1,
        );
        expect(
          delivered.filter(
            (notification) =>
              notification.type === "warning" && notification.message === "Retry this warning.",
          ),
        ).toHaveLength(1);
        expect(
          delivered.filter(
            (notification) =>
              notification.type === "warning" && notification.message === rateMessage,
          ),
        ).toHaveLength(1);
        expect((yield* service.status(run.id)).state).toBe("waiting_for_parent");
      }).pipe(Effect.scoped, Effect.provide(layer));
    },
  );

  it.effect("restarts actionable delivery after a stale queue drains to idle", () => {
    const fake = fakeChildLayer();
    const attempts: SubagentNotification[] = [];
    const layer = serviceLayer({
      notify: (notification) => {
        if (notification.type === "completed") return undefined;
        attempts.push(notification);
        return notification.type === "question"
          ? { deliveredActionKeys: [] }
          : {
              deliveredActionKeys: [
                `${notification.id}:warning:${notification.slotKey ?? "default"}:${notification.generation}`,
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
      yield* yieldUntil(() => attempts.some((value) => value.type === "question"));
      yield* service.reply(run.id, "Resolved before retry.");
      yield* TestClock.adjust("200 millis");

      fake.controls[0]?.offerIpc({
        channel: "pi-subagents",
        type: "contact_parent",
        requestId: "new-warning",
        kind: "warning",
        message: "Delivery after idle.",
      });
      yield* yieldUntil(() =>
        attempts.some(
          (value) => value.type === "warning" && value.message === "Delivery after idle.",
        ),
      );
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
