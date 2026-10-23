import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { hasObjectRuntimeType, indexOfFrom, runtimeTypeName } from "pi-cosmic-core";
import { connect } from "node:net";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as EffectRpcClient from "effect/rpc/RpcClient";
import type * as RpcClientError from "effect/rpc/RpcClientError";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as EffectSocket from "effect/socket/Socket";
import { deferredPromise, temporaryDirectory } from "pi-cosmic-core/testing";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vitest";
import { step } from "./support/effect-test.ts";
import {
  nodeFsPromises,
  nodePath,
  nodeSpawn as spawn,
  type NodeChildProcessWithoutNullStreams as ChildProcessWithoutNullStreams,
} from "./support/node-builtins.ts";
import {
  SupervisorChannel,
  type SupervisorChannelHandle,
  type SupervisorChannelLayerOptions,
  type SupervisorConnectionMetadata,
} from "../src/boundary/supervisor-channel.ts";
import { SupervisorChannelError } from "../src/boundary/supervisor-channel-errors.ts";
import type { BackendAgentMessaging } from "../src/backend/model.ts";
import { agentMessageRefusal } from "../src/run/errors.ts";
import { view } from "./fixtures/run-view.ts";
import {
  SupervisorAuthTokenSchema,
  SupervisorRunIdSchema,
  SupervisorChannelIdSchema,
  type SupervisorChannelConfig,
  SupervisorChannelConfigSchema,
  SupervisorRpcGroup,
} from "../src/supervisor/protocol.ts";
import { anything, stringContaining } from "./support/matchers.ts";
import * as Str from "effect/String";
import * as Arr from "effect/Array";

type JsonRpcValue = Schema.Json;
interface JsonRpcObject {
  readonly [key: string]: JsonRpcValue;
}

const decodeJsonLine = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json));
const decodeConnectionConfig = Schema.decodeUnknownSync(
  Schema.fromJsonString(SupervisorChannelConfigSchema),
);

const { mkdir, readFile, readdir, stat, symlink, writeFile } = nodeFsPromises;

const liveTest = (
  name: string,
  body: () => Generator<Effect.Effect<unknown, never, Scope.Scope>, void, never>,
  timeout?: number,
): void => it.live(name, () => Effect.gen(body), timeout);

/** A hang guard: each awaited step settles well within it or fails the test. */
const bounded = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, never, R> =>
  effect.pipe(Effect.timeout("5 seconds"), Effect.orDie);

/** The expected failure; an unexpected success fails the test. */
const failureOf = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<E, never, R> =>
  Effect.flip(effect).pipe(Effect.orDie);

const isMissing = (path: string) =>
  step(() =>
    stat(path).then(
      () => false,
      (cause: unknown) => Predicate.hasProperty(cause, "code") && cause.code === "ENOENT",
    ),
  );

interface OpenTestChannel {
  readonly handle: SupervisorChannelHandle;
  readonly scope: Scope.Closeable;
  readonly agentDirectory: string;
  readonly projectDirectory: string;
}

/**
 * A private agent home and a channel scope the test may close itself. The scope closes before the
 * home is removed, and a failed release fails the test.
 */
const stageAgentHome = (prefix: string) =>
  Effect.gen(function* () {
    const root = yield* temporaryDirectory(prefix);
    const agentDirectory = nodePath.join(root, "agent-home");
    yield* step(() => mkdir(agentDirectory, { mode: 0o700 }));
    const scope = yield* Scope.make();
    yield* Effect.addFinalizer(() =>
      Scope.close(scope, Exit.void).pipe(
        Effect.exit,
        Effect.map((closed) => expect(Exit.isSuccess(closed)).toBe(true)),
      ),
    );
    return { root, agentDirectory, scope };
  });

const openIn = (
  scope: Scope.Scope,
  options: SupervisorChannelLayerOptions,
  runId: string,
  agents?: BackendAgentMessaging,
) =>
  SupervisorChannel.use((channels) => channels.open({ runId, agents })).pipe(
    Effect.provide(SupervisorChannel.layer(options)),
    Scope.provide(scope),
  );

const openChannel = (
  runId = "agent-supervisor-test",
  options: Omit<SupervisorChannelLayerOptions, "agentDirectory"> = {},
  agents?: BackendAgentMessaging,
): Effect.Effect<OpenTestChannel, never, Scope.Scope> =>
  Effect.gen(function* () {
    const { root, agentDirectory, scope } = yield* stageAgentHome("pi-subagents-supervisor-");
    const projectDirectory = nodePath.join(root, "project");
    yield* step(() => mkdir(projectDirectory, { mode: 0o700 }));
    yield* step(() =>
      writeFile(nodePath.join(projectDirectory, "marker.txt"), "project-only\n", "utf8"),
    );
    const handle = yield* openIn(scope, { agentDirectory, ...options }, runId, agents).pipe(
      Effect.orDie,
    );
    return { handle, scope, agentDirectory, projectDirectory };
  });

class RpcClient {
  readonly messages: JsonRpcValue[] = [];
  readonly #pending = new Map<string, (value: JsonRpcValue) => void>();
  readonly #waiters = new Set<{
    readonly predicate: (value: JsonRpcValue) => boolean;
    readonly resolve: (value: JsonRpcValue) => void;
  }>();
  #buffer = "";
  readonly child: ChildProcessWithoutNullStreams;

  constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    child.stdout.on("data", (chunk: Buffer) => {
      this.#buffer += chunk.toString("utf8");
      let newline = indexOfFrom(this.#buffer, "\n", 0);
      while (newline >= 0) {
        const line = Fn.pipe(this.#buffer, Str.slice(0, newline));
        this.#buffer = Fn.pipe(this.#buffer, Str.slice(newline + 1));
        const value = decodeJsonLine(line);
        this.messages.push(value);
        if (
          Predicate.isObject(value) &&
          (Predicate.isString(value.id) || Predicate.isNumber(value.id))
        ) {
          const key = `${runtimeTypeName(value.id)}:${String(value.id)}`;
          const resolve = this.#pending.get(key);
          if (resolve) {
            this.#pending.delete(key);
            resolve(value);
          }
        }
        for (const waiter of this.#waiters) {
          if (!waiter.predicate(value)) continue;
          this.#waiters.delete(waiter);
          waiter.resolve(value);
        }
        newline = indexOfFrom(this.#buffer, "\n", 0);
      }
    });
  }

  send(value: JsonRpcValue): void {
    this.child.stdin.write(`${JSON.stringify(value)}\n`);
  }

  cancel(requestId: string): void {
    this.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId } });
  }

  ping(id: string) {
    return this.request({ jsonrpc: "2.0", id, method: "ping", params: {} });
  }

  /** Sends the request when run and waits for its response. */
  request(value: JsonRpcObject & { readonly id: string | number }) {
    const key = `${runtimeTypeName(value.id)}:${String(value.id)}`;
    return bounded(
      Effect.callback<JsonRpcValue>((resume) => {
        this.#pending.set(key, (response) => resume(Effect.succeed(response)));
        this.send(value);
        return Effect.sync(() => this.#pending.delete(key));
      }),
    );
  }

  next(predicate: (value: JsonRpcValue) => boolean) {
    return bounded(
      Effect.callback<JsonRpcValue>((resume) => {
        const existing = Option.getOrUndefined(Arr.findFirst(this.messages, predicate));
        if (existing) {
          resume(Effect.succeed(existing));
          return Effect.void;
        }
        const waiter = {
          predicate,
          resolve: (value: JsonRpcValue) => resume(Effect.succeed(value)),
        };
        this.#waiters.add(waiter);
        return Effect.sync(() => this.#waiters.delete(waiter));
      }),
    );
  }
}

/** A helper process the test scope kills unless it already exited. */
const spawnHelper = (handle: SupervisorChannelHandle) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const child = spawn(
        process.execPath,
        [handle.metadata.helperPath, "--config", handle.metadata.connectionConfigPath],
        { env: {}, stdio: ["pipe", "pipe", "pipe"] },
      );
      return { child, rpc: new RpcClient(child) };
    }),
    ({ child }) =>
      Effect.sync(() => {
        child.stdin.destroy();
        child.kill("SIGKILL");
      }),
  );

const initialize = (rpc: RpcClient) =>
  Effect.gen(function* () {
    const initialized = yield* rpc.request({
      jsonrpc: "2.0",
      id: "initialize",
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      },
    });
    expect(initialized).toMatchObject({
      id: "initialize",
      result: { protocolVersion: "2025-06-18" },
    });
    rpc.send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  });

const readyHelper = (handle: SupervisorChannelHandle) =>
  Effect.gen(function* () {
    const helper = yield* spawnHelper(handle);
    yield* initialize(helper.rpc);
    yield* Effect.orDie(handle.awaitReady);
    yield* Effect.orDie(handle.setAssignmentEpoch(1));
    return helper;
  });

const connectionRefused = ({ host, port }: { readonly host: string; readonly port: number }) =>
  bounded(
    Effect.callback<boolean>((resume) => {
      const socket = connect({ host, port });
      socket.once("connect", () => {
        socket.destroy();
        resume(Effect.succeed(false));
      });
      socket.once("error", () => resume(Effect.succeed(true)));
      return Effect.sync(() => socket.destroy());
    }),
  );

const awaitPeerClosed = (handle: SupervisorChannelHandle, frame?: string) =>
  bounded(
    Effect.callback<boolean>((resume) => {
      const socket = connect({ host: handle.metadata.host, port: handle.metadata.port });
      const closed = () => resume(Effect.sync(() => socket.destroyed));
      socket.once("close", closed);
      socket.once("error", closed);
      if (frame !== undefined) socket.write(frame);
      return Effect.sync(() => socket.destroy());
    }),
  );

const toolCall = (rpc: RpcClient, id: string | number, name: string, args: JsonRpcObject) =>
  rpc.request({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
  });

const isNullIdError = (code: number) => (value: JsonRpcValue) =>
  Predicate.isObject(value) &&
  value.id === null &&
  Predicate.isObject(value.error) &&
  value.error.code === code;

const takeEvent = (handle: SupervisorChannelHandle) => bounded(Queue.take(handle.events));

const waitForExit = (child: ChildProcessWithoutNullStreams) =>
  bounded(
    Effect.callback<{ code: number | null; signal: NodeJS.Signals | null }>((resume) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resume(Effect.succeed({ code: child.exitCode, signal: child.signalCode }));
        return Effect.void;
      }
      const exited = (code: number | null, signal: NodeJS.Signals | null) =>
        resume(Effect.succeed({ code, signal }));
      child.once("exit", exited);
      return Effect.sync(() => child.off("exit", exited));
    }),
  );

type DirectSupervisorClient = EffectRpcClient.FromGroup<
  typeof SupervisorRpcGroup,
  RpcClientError.RpcClientError
>;

interface DirectRpcChannel {
  readonly client: DirectSupervisorClient;
  readonly auth: SupervisorChannelConfig;
  readonly close: Effect.Effect<void>;
}

/** A raw RPC connection that closes when `close` runs or, at the latest, with the test. */
const connectDirectRpc = (
  handle: SupervisorChannelHandle,
  auth: SupervisorChannelConfig,
): Effect.Effect<DirectRpcChannel, never, Scope.Scope> =>
  Effect.gen(function* () {
    const scope = yield* Scope.fork(yield* Effect.scope);
    const socket = yield* NodeSocket.makeNet({
      host: handle.metadata.host,
      port: handle.metadata.port,
    }).pipe(Scope.provide(scope));
    const serialization = RpcSerialization.makeNdjson({
      maxBufferSize: 512 * 1024,
    });
    const protocol = yield* EffectRpcClient.makeProtocolSocket().pipe(
      Effect.provideService(RpcSerialization.RpcSerialization, serialization),
      Effect.provideService(EffectSocket.Socket, socket),
      Scope.provide(scope),
    );
    const client = yield* EffectRpcClient.make(SupervisorRpcGroup).pipe(
      Effect.provideService(EffectRpcClient.Protocol, protocol),
      Scope.provide(scope),
    );
    return { client, auth, close: Scope.close(scope, Exit.void) };
  }).pipe(Effect.orDie);

const connectionConfig = (handle: SupervisorChannelHandle) =>
  step(() => readFile(handle.metadata.connectionConfigPath, "utf8").then(decodeConnectionConfig));

type AgentCall =
  | { readonly kind: "list"; readonly ids?: ReadonlyArray<string> | undefined }
  | { readonly kind: "send"; readonly to: string; readonly message: string }
  | { readonly kind: "read"; readonly ids: ReadonlyArray<string> };

const RATE_LIMITED_AGENT = "agent-r1-9";
const SAVED_REPORT_AGENT = "agent-r1-8";
const SAVED_REPORT_PATH = "/agent/subagents/reports/session-1/agent-r1-8-1-file.md";
const ASKING_AGENT = "agent-r1-7";
// A whole retained question, then warnings long enough to push the card past its bound.
const ASKING_QUESTION = `${Fn.pipe("Which schema? ", Str.repeat(1_160))}QUESTION-END`;
const askingRun = (selfId: string) =>
  view({
    id: ASKING_AGENT,
    name: "peer",
    state: "waiting_for_parent",
    parentRunId: selfId,
    question: { requestId: "q-1", message: ASKING_QUESTION },
    childWarning: `${Fn.pipe("child ", Str.repeat(2_700))}CHILD-END`,
    systemWarning: `${Fn.pipe("system ", Str.repeat(1_160))}SYSTEM-END`,
  });

// Stands in for the root's operations, already bound to the channel's run as the caller.
const recordingAgents = (selfId: string) => {
  const calls: AgentCall[] = [];
  const agents: BackendAgentMessaging = {
    caller: { kind: "run", runId: selfId },
    cwd: "/project",
    list: (ids) =>
      Effect.sync(() => {
        calls.push({ kind: "list", ids });
        return {
          agents: [
            { id: "main", name: "main", kind: "main", state: "busy", self: false },
            {
              id: selfId,
              name: "api-scout",
              kind: "run",
              state: "running",
              parentId: "main",
              runtime: "claude",
              profile: "scout",
              self: true,
            },
          ],
          missingIds:
            ids === undefined ? [] : Arr.filter(ids, (id) => id !== "main" && id !== selfId),
        };
      }),
    send: (to, message) =>
      to === RATE_LIMITED_AGENT
        ? Effect.fail(
            agentMessageRefusal(
              "agent_unavailable",
              "Agent agent-2 is starting; try again once it is running.",
            ),
          )
        : Effect.sync(() => {
            calls.push({ kind: "send", to, message });
            return {
              messageId: "message-r1-1",
              to,
              name: "peer",
              disposition: "guided",
              confirmed: true,
            };
          }),
    read: (ids) =>
      Effect.sync(() => {
        calls.push({ kind: "read", ids });
        return {
          agents: Arr.map(ids, (id) =>
            id === ASKING_AGENT
              ? {
                  kind: "run" as const,
                  id,
                  name: "peer",
                  state: "waiting_for_parent" as const,
                  textStatus: "none" as const,
                  truncated: false,
                  reportGeneration: 0,
                  run: askingRun(selfId),
                }
              : {
                  kind: "run" as const,
                  id,
                  name: "peer",
                  state: "completed" as const,
                  ...(id === SAVED_REPORT_AGENT
                    ? {
                        textStatus: "none" as const,
                        reportFile: {
                          path: SAVED_REPORT_PATH,
                          chars: 90,
                          lines: 3,
                          complete: true,
                        },
                      }
                    : { textStatus: "text" as const, text: `Findings from ${id}.` }),
                  truncated: false,
                  source: "report" as const,
                  reportGeneration: 1,
                  run: view({
                    id,
                    name: "peer",
                    state: "completed",
                    parentRunId: selfId,
                    childWarning: `Warning from ${id}.`,
                    pid: 4242,
                  }),
                },
          ),
          missingIds: [],
        };
      }),
  };
  return { calls, agents };
};

const toolText = (value: JsonRpcValue) =>
  Predicate.isObject(value) &&
  Predicate.isObject(value.result) &&
  Arr.isArray(value.result.content) &&
  Predicate.isObject(value.result.content[0]) &&
  Predicate.isString(value.result.content[0].text)
    ? { text: value.result.content[0].text, isError: value.result.isError === true }
    : undefined;

describe("private supervisor channel", () => {
  liveTest(
    "rejects invalid run identities, relative state roots, and symlink state roots",
    function* () {
      const { root, agentDirectory, scope } = yield* stageAgentHome(
        "pi-subagents-supervisor-paths-",
      );

      expect(yield* failureOf(openIn(scope, { agentDirectory }, "../invalid"))).toMatchObject({
        code: "invalid_run_id",
      });
      expect(
        yield* failureOf(
          openIn(scope, { agentDirectory: "relative-agent-home" }, "agent-path-test"),
        ),
      ).toMatchObject({ code: "channel_open_failed" });

      const linkedAgentDirectory = nodePath.join(root, "linked-agent-home");
      yield* step(() => symlink(agentDirectory, linkedAgentDirectory, "dir"));
      expect(
        yield* failureOf(
          openIn(scope, { agentDirectory: linkedAgentDirectory }, "agent-path-test"),
        ),
      ).toMatchObject({ code: "channel_open_failed" });
      expect(yield* step(() => readdir(agentDirectory))).toEqual([]);
    },
  );

  liveTest("cleans staged acquisition immediately when open is interrupted", function* () {
    const { agentDirectory, scope } = yield* stageAgentHome("pi-subagents-supervisor-late-open-");
    const acquisitionEntered = yield* Deferred.make<SupervisorConnectionMetadata>();
    const acquisitionGate = deferredPromise();
    const options: SupervisorChannelLayerOptions = {
      agentDirectory,
      beforeAcquireComplete: (acquired) => {
        Deferred.doneUnsafe(acquisitionEntered, Effect.succeed(acquired));
        return acquisitionGate.promise;
      },
    };
    const opening = yield* openIn(scope, options, "agent-supervisor-late-open").pipe(
      Effect.forkChild,
    );

    const acquired = yield* bounded(Deferred.await(acquisitionEntered));
    yield* bounded(Fiber.interrupt(opening));
    expect(Exit.hasInterrupts(yield* Fiber.await(opening))).toBe(true);
    expect(yield* isMissing(acquired.connectionConfigPath)).toBe(true);

    acquisitionGate.resolve();
    expect(yield* connectionRefused(acquired)).toBe(true);
  });

  liveTest(
    "stops waiting for a stalled state-directory creation and removes the directory it makes late",
    function* () {
      const runId = "agent-supervisor-late-mkdir";
      const { agentDirectory, scope } = yield* stageAgentHome("pi-subagents-supervisor-mkdir-");
      const isStateDirectory = (path: string) =>
        Fn.pipe(nodePath.basename(path), Str.startsWith(`${runId}-`));
      const mkdirEntered = yield* Deferred.make<string>();
      const mkdirGate = deferredPromise();
      const lateRemoval = yield* Deferred.make<void>();
      let lateDirectoryCreated = false;
      const createDirectory = nodeFsPromises.mkdir;
      const removeDirectory = nodeFsPromises.rmdir;
      const gatedMkdir = vi.spyOn(nodeFsPromises, "mkdir").mockImplementation((path, options) => {
        if (!Predicate.isString(path) || !isStateDirectory(path))
          return createDirectory(path, options);
        Deferred.doneUnsafe(mkdirEntered, Effect.succeed(path));
        return mkdirGate.promise.then(() =>
          createDirectory(path, options).then((created) => {
            lateDirectoryCreated = true;
            return created;
          }),
        );
      });
      const observedRmdir = vi.spyOn(nodeFsPromises, "rmdir").mockImplementation((path, options) =>
        removeDirectory(path, options).finally(() => {
          if (Predicate.isString(path) && isStateDirectory(path))
            Deferred.doneUnsafe(lateRemoval, Effect.void);
        }),
      );
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          gatedMkdir.mockRestore();
          observedRmdir.mockRestore();
        }),
      );
      const opening = yield* openIn(scope, { agentDirectory }, runId).pipe(Effect.forkChild);

      const stateDirectory = yield* bounded(Deferred.await(mkdirEntered));
      // The creation is still gated, so only an interruptible wait lets this return.
      yield* bounded(Fiber.interrupt(opening));
      expect(Exit.hasInterrupts(yield* Fiber.await(opening))).toBe(true);

      mkdirGate.resolve();
      yield* bounded(Deferred.await(lateRemoval));
      expect(lateDirectoryCreated).toBe(true);
      expect(yield* isMissing(stateDirectory)).toBe(true);
    },
  );

  liveTest(
    "waits for private config publication to settle before interrupted cleanup",
    function* () {
      const { agentDirectory, scope } = yield* stageAgentHome(
        "pi-subagents-supervisor-config-commit-",
      );
      const commitEntered = yield* Deferred.make<SupervisorConnectionMetadata>();
      const commitGate = deferredPromise();
      const options: SupervisorChannelLayerOptions = {
        agentDirectory,
        beforeConfigCommit: (acquired) => {
          Deferred.doneUnsafe(commitEntered, Effect.succeed(acquired));
          return commitGate.promise;
        },
      };
      const opening = yield* openIn(scope, options, "agent-supervisor-config-commit").pipe(
        Effect.forkChild,
      );

      const acquired = yield* bounded(Deferred.await(commitEntered));
      const interrupting = yield* Fiber.interrupt(opening).pipe(Effect.forkChild);
      // Showing that something does not happen needs a bound, since no in-process signal reports
      // that cleanup I/O did not start. The held gate keeps a correct interrupt pending, so this
      // window can't fail it; it bounds only how long an interruptible commit has to settle.
      const early = yield* Fiber.await(interrupting).pipe(Effect.timeoutOption("50 millis"));
      expect(Option.isNone(early)).toBe(true);
      commitGate.resolve();
      yield* bounded(Fiber.join(interrupting));
      expect(Exit.hasInterrupts(yield* Fiber.await(opening))).toBe(true);
      expect(yield* isMissing(acquired.stateDirectory)).toBe(true);
    },
  );

  liveTest("settles owned work and removes every resource on scope release", function* () {
    const { handle, scope } = yield* openChannel("agent-supervisor-scope-close");
    const config = yield* connectionConfig(handle);
    const direct = yield* connectDirectRpc(handle, config);
    yield* Effect.orDie(direct.client.SupervisorOpenSession(config));
    const epochSeen = yield* Deferred.make<void>();
    const watching = yield* Stream.runForEach(
      direct.client.SupervisorWatchAssignments(config),
      (update) =>
        update.kind === "assignment" && update.assignmentEpoch === 1
          ? direct.client.SupervisorAcknowledgeAssignment({
              ...config,
              updateId: update.updateId,
              assignmentEpoch: update.assignmentEpoch,
            })
          : Deferred.succeed(epochSeen, undefined),
    ).pipe(Effect.exit, Effect.forkChild);
    yield* Effect.orDie(handle.awaitReady);
    yield* Effect.orDie(handle.setAssignmentEpoch(1));
    const question = yield* direct.client
      .SupervisorQuestion({
        ...config,
        assignmentEpoch: 1,
        requestId: SupervisorChannelIdSchema.make("question-before-shared-close"),
        message: "Will shutdown settle this question?",
      })
      .pipe(Effect.exit, Effect.forkChild);
    expect(yield* takeEvent(handle)).toMatchObject({
      type: "supervisor_contact",
      kind: "question",
    });
    const advancing = yield* handle
      .setAssignmentEpoch(2)
      .pipe(Effect.flip, Effect.orDie, Effect.forkChild);
    yield* bounded(Deferred.await(epochSeen));

    yield* Scope.close(scope, Exit.void);
    const error = yield* bounded(Fiber.join(advancing));
    expect(error).toBeInstanceOf(SupervisorChannelError);
    expect(error.code).toBe("channel_closed");
    expect(Exit.isFailure(yield* bounded(Fiber.join(question)))).toBe(true);
    yield* bounded(Fiber.join(watching));
    expect(yield* failureOf(handle.awaitReady)).toMatchObject({ code: "channel_closed" });
    expect(yield* isMissing(handle.metadata.stateDirectory)).toBe(true);
    expect(yield* connectionRefused(handle.metadata)).toBe(true);
    yield* direct.close;
  });

  liveTest("keeps one session per client across concurrent and repeated opens", function* () {
    const { handle } = yield* openChannel("agent-supervisor-open-race");
    const config = yield* connectionConfig(handle);
    const direct = yield* connectDirectRpc(handle, config);
    yield* Effect.orDie(
      Effect.all(
        Array.from({ length: 8 }, () => direct.client.SupervisorOpenSession(config)),
        { concurrency: "unbounded" },
      ),
    );
    const watching = yield* Stream.runForEach(
      direct.client.SupervisorWatchAssignments(config),
      (update) =>
        direct.client.SupervisorAcknowledgeAssignment({
          ...config,
          updateId: update.updateId,
          assignmentEpoch: update.assignmentEpoch,
        }),
    ).pipe(Effect.exit, Effect.forkChild);
    yield* Effect.orDie(handle.awaitReady);
    // A later open must not replace the queue the watch stream reads.
    yield* Effect.orDie(direct.client.SupervisorOpenSession(config));
    yield* Effect.orDie(handle.setAssignmentEpoch(1).pipe(Effect.timeout("5 seconds")));
    yield* direct.close;
    yield* bounded(Fiber.join(watching));
  });

  for (const [name, runId, options, frame] of [
    [
      "closes an unauthenticated peer at the scoped authentication deadline",
      "agent-supervisor-auth-deadline",
      { authTimeoutMillis: 10 },
      undefined,
    ],
    [
      "closes malformed private RPC frames before authentication",
      "agent-supervisor-malformed-rpc",
      {},
      "{not-effect-rpc}\n",
    ],
  ] as const)
    liveTest(name, function* () {
      const { handle } = yield* openChannel(runId, options);
      expect(yield* awaitPeerClosed(handle, frame)).toBe(true);
    });

  liveTest(
    "refuses parent contact and the report from a native sub-agent thread but accepts the main agent's",
    function* () {
      const { handle } = yield* openChannel("agent-native-thread");
      const { rpc } = yield* readyHelper(handle);
      handle.setMainAgentThread("main-thread");
      const fromThread = (id: string, name: string, args: JsonRpcObject, threadId: string) =>
        rpc.request({
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: { name, arguments: args, _meta: { threadId, progressToken: 1 } },
        });
      const report = { delivery_id: "delivery-native", report: "Sub-agent findings." };

      for (const [id, name, args] of [
        ["sub-report", "agent_submit_report", report],
        ["sub-question", "agent_contact_parent", { kind: "question", message: "Which file?" }],
        ["sub-progress", "agent_contact_parent", { kind: "progress", message: "Halfway." }],
        ["sub-warning", "agent_contact_parent", { kind: "warning", message: "Risky." }],
      ] as const) {
        const refused = yield* fromThread(id, name, args, "sub-agent-thread");
        expect(refused).toMatchObject({
          result: { isError: true, content: [{ text: stringContaining("parent") }] },
        });
      }
      expect(Queue.sizeUnsafe(handle.events)).toBe(0);

      yield* fromThread(
        "main-progress",
        "agent_contact_parent",
        { kind: "progress", message: "Halfway." },
        "main-thread",
      );
      expect(yield* takeEvent(handle)).toMatchObject({
        kind: "progress",
        message: "Halfway.",
      });

      const accepted = yield* fromThread(
        "main-report",
        "agent_submit_report",
        report,
        "main-thread",
      );
      expect(accepted).toMatchObject({
        result: { content: [{ text: stringContaining("accepted") }] },
      });
      expect(yield* takeEvent(handle)).toMatchObject({
        type: "report",
        text: "Sub-agent findings.",
      });
    },
  );

  liveTest(
    "spawns the helper and keeps blocked questions concurrent, correlated, cancellable, and epoch-safe",
    function* () {
      const opened = yield* openChannel();
      const { handle, scope, projectDirectory } = opened;

      const config = yield* connectionConfig(handle);
      expect(config).toMatchObject({
        version: 3,
        runId: "agent-supervisor-test",
        host: "127.0.0.1",
        port: handle.metadata.port,
      });
      expect(config.token).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.stringify(handle.metadata)).not.toContain(config.token);
      expect(handle.metadata.claudeMcp.mcpServers.pi_subagents_supervisor).toMatchObject({
        type: "stdio",
        command: process.execPath,
        env: {},
      });
      expect(handle.metadata.codexMcp.tomlFragment).toContain(
        "[mcp_servers.pi_subagents_supervisor]",
      );
      expect(handle.metadata.codexMcp.tomlFragment).not.toContain("env =");

      const stateMode = (yield* step(() => stat(handle.metadata.stateDirectory))).mode & 0o777;
      const configMode =
        (yield* step(() => stat(handle.metadata.connectionConfigPath))).mode & 0o777;
      expect(stateMode).toBe(0o700);
      expect(configMode).toBe(0o600);
      expect(yield* step(() => readdir(projectDirectory))).toEqual(["marker.txt"]);

      const { child, rpc } = yield* readyHelper(handle);
      const listed = yield* rpc.request({
        jsonrpc: "2.0",
        id: "list",
        method: "tools/list",
        params: {},
      });
      expect(listed).toMatchObject({
        result: {
          tools: [
            {
              name: "agent_contact_parent",
              inputSchema: {
                properties: { kind: {}, message: {} },
                required: ["kind", "message"],
                additionalProperties: false,
              },
            },
            {
              name: "agent_submit_report",
              inputSchema: {
                properties: { delivery_id: {}, report: {} },
                required: ["delivery_id", "report"],
                additionalProperties: false,
              },
            },
            { name: "agent_list", inputSchema: { properties: { agentIds: {} } } },
            {
              name: "agent_send",
              inputSchema: { properties: { to: {}, message: {} }, required: ["to", "message"] },
            },
            {
              name: "agent_read",
              inputSchema: { properties: { agentIds: {}, verbose: {} }, required: ["agentIds"] },
            },
          ],
        },
      });

      expect(
        yield* toolCall(rpc, "camel-case-report", "agent_submit_report", {
          deliveryId: "delivery-main",
          report: "Bounded final report.",
        }),
      ).toMatchObject({ result: { isError: true } });

      const questionResponse = yield* toolCall(rpc, "question-1", "agent_contact_parent", {
        kind: "question",
        message: "Which implementation should I use?",
      }).pipe(Effect.forkChild);
      const question = yield* takeEvent(handle);
      expect(question).toMatchObject({
        type: "supervisor_contact",
        kind: "question",
        assignmentEpoch: 1,
        message: "Which implementation should I use?",
      });
      if (question.type !== "supervisor_contact") throw new Error("expected question");
      rpc.cancel("an-unrelated-request");

      const [ping, progress, report] = yield* Effect.all(
        [
          rpc.ping("ping-while-blocked"),
          toolCall(rpc, "progress-while-blocked", "agent_contact_parent", {
            kind: "progress",
            message: "Continuing independent work.",
          }),
          toolCall(rpc, "report-while-blocked", "agent_submit_report", {
            delivery_id: "delivery-main",
            report: "Bounded final report.",
          }),
        ],
        { concurrency: "unbounded" },
      );
      expect(ping).toMatchObject({ id: "ping-while-blocked", result: {} });
      expect(progress).not.toMatchObject({ error: anything() });
      expect(report).toMatchObject({
        result: { content: [{ text: stringContaining("sequence 1") }] },
      });
      expect(yield* Effect.orDie(handle.hasAcceptedReport(1))).toBe(true);
      expect(yield* Effect.orDie(handle.acceptedReportForEpoch(1))).toMatchObject({
        runId: "agent-supervisor-test",
        assignmentEpoch: 1,
        deliveryId: "delivery-main",
        text: "Bounded final report.",
      });
      expect(yield* handle.hasAcceptedReport(2).pipe(Effect.orElseSucceed(() => false))).toBe(
        false,
      );
      const concurrentEvents = [
        yield* takeEvent(handle),
        yield* takeEvent(handle),
        yield* takeEvent(handle),
      ];
      expect(concurrentEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "supervisor_contact",
            kind: "progress",
            assignmentEpoch: 1,
          }),
          expect.objectContaining({
            type: "report",
            assignmentEpoch: 1,
            sequence: 1,
            deliveryId: "delivery-main",
            text: "Bounded final report.",
          }),
          expect.objectContaining({
            type: "parent_question_cancelled",
            assignmentEpoch: 1,
            requestId: question.requestId,
          }),
        ]),
      );

      expect(yield* Fiber.join(questionResponse)).toMatchObject({ error: { code: -32800 } });
      expect(
        yield* failureOf(handle.reply(question.requestId, "Use the service seam.")),
      ).toMatchObject({ code: "question_ownership_mismatch" });

      // An assignment may ask again once its earlier question settled, one at a time.
      const secondQuestion = yield* toolCall(rpc, "question-second", "agent_contact_parent", {
        kind: "question",
        message: "A second question?",
      }).pipe(Effect.forkChild);
      const second = yield* takeEvent(handle);
      if (second.type !== "supervisor_contact") throw new Error("expected question");
      expect(second).toMatchObject({ kind: "question", assignmentEpoch: 1 });
      const concurrent = yield* toolCall(rpc, "question-concurrent", "agent_contact_parent", {
        kind: "question",
        message: "A question while another waits?",
      });
      expect(concurrent).toMatchObject({ error: { code: -32000 } });
      yield* Effect.orDie(handle.reply(second.requestId, "Use the second answer."));
      expect(yield* Fiber.join(secondQuestion)).toMatchObject({
        result: { content: [{ text: "Parent reply: Use the second answer." }] },
      });

      const retry = yield* toolCall(rpc, "report-retry", "agent_submit_report", {
        delivery_id: "delivery-main",
        report: "Bounded final report.",
      });
      expect(retry).toMatchObject({
        result: { content: [{ text: stringContaining("retry accepted; sequence 1") }] },
      });
      const noDuplicateEvent = yield* Queue.poll(handle.events);
      expect(Option.isNone(noDuplicateEvent)).toBe(true);
      const conflict = yield* toolCall(rpc, "report-conflict", "agent_submit_report", {
        delivery_id: "delivery-main",
        report: "Conflicting report.",
      });
      expect(conflict).toMatchObject({ error: { code: -32000 } });

      const laterReport = yield* toolCall(rpc, "report-later", "agent_submit_report", {
        delivery_id: "delivery-later",
        report: "Later evidence for the same assignment.",
      });
      expect(laterReport).toMatchObject({
        result: { content: [{ text: stringContaining("sequence 2") }] },
      });
      expect(yield* takeEvent(handle)).toMatchObject({
        type: "report",
        sequence: 2,
        deliveryId: "delivery-later",
      });
      expect(yield* Effect.orDie(handle.acceptedReportForEpoch(1))).toMatchObject({
        sequence: 1,
        deliveryId: "delivery-main",
      });

      yield* Effect.orDie(handle.setAssignmentEpoch(2));
      const crossEpochRetry = yield* toolCall(rpc, "report-cross-epoch", "agent_submit_report", {
        delivery_id: "delivery-main",
        report: "Bounded final report.",
      });
      expect(crossEpochRetry).toMatchObject({ error: { code: -32000 } });
      const cancelledQuestion = yield* toolCall(rpc, "question-cancelled", "agent_contact_parent", {
        kind: "question",
        message: "Wait for a reply that will be cancelled.",
      }).pipe(Effect.forkChild);
      const cancellationEvent = yield* takeEvent(handle);
      expect(cancellationEvent).toMatchObject({
        type: "supervisor_contact",
        kind: "question",
        assignmentEpoch: 2,
      });
      rpc.cancel("question-cancelled");
      expect(yield* Fiber.join(cancelledQuestion)).toMatchObject({ error: { code: -32800 } });
      expect(yield* takeEvent(handle)).toMatchObject({
        type: "parent_question_cancelled",
        assignmentEpoch: 2,
        requestId:
          cancellationEvent.type === "supervisor_contact" ? cancellationEvent.requestId : "",
      });
      yield* Effect.orDie(handle.setAssignmentEpoch(3));
      if (cancellationEvent.type !== "supervisor_contact") throw new Error("expected question");
      // The cancellation event follows the question's release, so the reply finds no owner.
      expect(
        yield* failureOf(handle.reply(cancellationEvent.requestId, "Too late.")),
      ).toMatchObject({ code: "question_ownership_mismatch" });
      expect(yield* rpc.ping("ping-after-cancel")).toMatchObject({ result: {} });

      const direct = yield* connectDirectRpc(handle, config);
      yield* Effect.orDie(direct.client.SupervisorOpenSession(config));
      yield* Effect.orDie(
        direct.client.SupervisorProgress({
          ...config,
          requestId: SupervisorChannelIdSchema.make("late-progress"),
          assignmentEpoch: 1,
          message: "Late event from assignment one.",
        }),
      );
      expect(yield* takeEvent(handle)).toMatchObject({
        type: "supervisor_contact",
        requestId: "late-progress",
        assignmentEpoch: 1,
        message: "Late event from assignment one.",
      });
      yield* direct.close;

      const forged = yield* connectDirectRpc(handle, {
        ...config,
        token: SupervisorAuthTokenSchema.make(Fn.pipe("0", Str.repeat(64))),
      });
      const refusedOpen = yield* forged.client
        .SupervisorOpenSession(forged.auth)
        .pipe(Effect.exit, Effect.timeout("5 seconds"), Effect.orDie);
      expect(Exit.isFailure(refusedOpen)).toBe(true);
      yield* forged.close;
      expect(Option.isNone(yield* Queue.poll(handle.events))).toBe(true);

      const manyResponses = yield* Effect.all(
        Array.from({ length: 12 }, (_, index) =>
          toolCall(rpc, `concurrent-${index}`, "agent_contact_parent", {
            kind: "progress",
            message: `Concurrent progress ${index}`,
          }),
        ),
        { concurrency: "unbounded" },
      );
      expect(
        Arr.every(manyResponses, (value) => Boolean(value) && hasObjectRuntimeType(value)),
      ).toBe(true);
      for (let index = 0; index < 12; index += 1) yield* takeEvent(handle);

      yield* Scope.close(scope, Exit.void);
      expect(yield* waitForExit(child)).toMatchObject({ signal: null });
      expect(yield* step(() => readdir(projectDirectory))).toEqual(["marker.txt"]);
      expect(yield* isMissing(handle.metadata.stateDirectory)).toBe(true);
    },
    20_000,
  );

  liveTest(
    "requires a current live helper for each readiness generation and epoch",
    function* () {
      const { handle } = yield* openChannel("agent-supervisor-readiness");
      expect(yield* failureOf(handle.setAssignmentEpoch(1))).toMatchObject({
        code: "supervisor_helper_unavailable",
      });

      const first = yield* readyHelper(handle);
      // The channel cancels a question pending on a helper once it drops that helper.
      yield* toolCall(first.rpc, "question-before-exit", "agent_contact_parent", {
        kind: "question",
        message: "Still connected?",
      }).pipe(Effect.exit, Effect.forkChild);
      expect(yield* takeEvent(handle)).toMatchObject({ kind: "question" });
      first.child.kill("SIGTERM");
      yield* waitForExit(first.child);
      expect(yield* takeEvent(handle)).toMatchObject({ type: "parent_question_cancelled" });
      expect(yield* failureOf(handle.setAssignmentEpoch(2))).toMatchObject({
        code: "supervisor_helper_unavailable",
      });

      const replacement = yield* spawnHelper(handle);
      yield* initialize(replacement.rpc);
      yield* Effect.orDie(handle.awaitReady);
      yield* Effect.orDie(handle.setAssignmentEpoch(2));
    },
    20_000,
  );

  liveTest(
    "writes exactly one response when cancellation arrives after a backpressured reply",
    function* () {
      const { handle } = yield* openChannel("agent-supervisor-one-response");
      const { child, rpc } = yield* readyHelper(handle);

      const response = yield* toolCall(rpc, "question-after-reply", "agent_contact_parent", {
        kind: "question",
        message: "Choose after stdout is backpressured.",
      }).pipe(Effect.forkChild);
      const question = yield* takeEvent(handle);
      if (question.type !== "supervisor_contact") throw new Error("expected question");

      child.stdout.pause();
      for (let index = 0; index < 48; index += 1)
        rpc.send({
          jsonrpc: "2.0",
          id: `backpressure-${index}`,
          method: "tools/list",
          params: {},
        });
      yield* Effect.orDie(handle.reply(question.requestId, "Use the stable path."));
      // The reply settles once the helper acknowledges it, which happens inside the helper's
      // commit of that reply, so a cancellation from here on can't replace it.
      rpc.cancel("question-after-reply");
      child.stdout.resume();

      expect(yield* Fiber.join(response)).toMatchObject({
        id: "question-after-reply",
        result: { content: [{ text: "Parent reply: Use the stable path." }] },
      });
      // The helper reads the ping after the cancellation, so its response follows anything the
      // cancellation could have written.
      expect(yield* rpc.ping("ping-after-reply-race")).toMatchObject({ result: {} });
      expect(
        Arr.filter(
          rpc.messages,
          (message) =>
            message !== null &&
            hasObjectRuntimeType(message) &&
            "id" in message &&
            message.id === "question-after-reply",
        ),
      ).toHaveLength(1);
    },
    20_000,
  );

  liveTest(
    "queues a correlated cancellation when a helper disconnects with a pending question",
    function* () {
      const { handle } = yield* openChannel("agent-supervisor-disconnect");
      const { child, rpc } = yield* readyHelper(handle);

      yield* toolCall(rpc, "question-before-disconnect", "agent_contact_parent", {
        kind: "question",
        message: "Should I continue?",
      }).pipe(Effect.exit, Effect.forkChild);
      const questionEvent = yield* takeEvent(handle);
      expect(questionEvent).toMatchObject({
        type: "supervisor_contact",
        kind: "question",
        assignmentEpoch: 1,
      });
      if (questionEvent.type !== "supervisor_contact") throw new Error("expected question");

      child.kill("SIGKILL");
      yield* waitForExit(child);
      expect(yield* takeEvent(handle)).toMatchObject({
        type: "parent_question_cancelled",
        assignmentEpoch: 1,
        requestId: questionEvent.requestId,
      });
      expect(yield* failureOf(handle.reply(questionEvent.requestId, "Continue."))).toMatchObject({
        code: "question_ownership_mismatch",
      });
    },
  );

  liveTest(
    "rejects excess, malformed, and oversized MCP input and closes boundedly",
    function* () {
      const opened = yield* openChannel("agent-supervisor-malformed");
      const { handle, scope } = opened;
      expect(handle.metadata.host).toBe("127.0.0.1");

      const { child, rpc } = yield* readyHelper(handle);
      const excessTopLevel = yield* rpc.request({
        jsonrpc: "2.0",
        id: "excess-top",
        method: "ping",
        params: {},
        unexpected: true,
      });
      expect(excessTopLevel).toMatchObject({ error: { code: -32600 } });
      const excessTool = yield* toolCall(rpc, "excess-tool", "agent_contact_parent", {
        kind: "progress",
        message: "valid",
        unexpected: true,
      });
      expect(excessTool).toMatchObject({ result: { isError: true } });
      const oversizedString = yield* toolCall(rpc, "oversized-tool", "agent_contact_parent", {
        kind: "progress",
        message: Fn.pipe("x", Str.repeat(64 * 1024 + 1)),
      });
      expect(oversizedString).toMatchObject({
        result: {
          isError: true,
          content: [{ type: "text", text: stringContaining("65,536") }],
        },
      });

      child.stdin.write("{not-json}\n");
      expect(yield* rpc.next(isNullIdError(-32700))).toMatchObject({
        error: { code: -32700 },
      });

      yield* Scope.close(scope, Exit.void);
      expect(yield* isMissing(handle.metadata.connectionConfigPath)).toBe(true);
    },
    20_000,
  );

  liveTest(
    "serves agent tools for the channel's own run and ignores forged run identities",
    function* () {
      const runId = "agent-supervisor-agents";
      const fixture = recordingAgents(runId);
      const { handle } = yield* openChannel(runId, {}, fixture.agents);
      const { rpc } = yield* readyHelper(handle);

      const listed = toolText(yield* toolCall(rpc, "list", "agent_list", {}));
      expect(listed?.isError).toBe(false);
      expect(listed?.text).toContain(`${runId} "api-scout"`);
      expect(listed?.text).toMatch(/scout; runtime claude; child of main; you/u);

      const read = toolText(
        yield* toolCall(rpc, "read", "agent_read", { agentIds: ["agent-r1-2", "main"] }),
      );
      expect(read?.text).toContain("Findings from agent-r1-2.");
      expect(read?.text).toContain("from its report");
      // A saved report reaches the reader as its file.
      const saved = toolText(
        yield* toolCall(rpc, "read-saved", "agent_read", { agentIds: [SAVED_REPORT_AGENT] }),
      );
      expect(saved?.text).toContain(SAVED_REPORT_PATH);
      // Each run's status card comes with its message; verbose adds process details.
      expect(read?.text).toContain("Warning from agent-r1-2.");
      expect(read?.text).not.toContain("pid 4242");
      const verbose = toolText(
        yield* toolCall(rpc, "read-verbose", "agent_read", {
          agentIds: ["agent-r1-2"],
          verbose: true,
        }),
      );
      expect(verbose?.text).toContain("pid 4242");
      // A card too long for the channel keeps its whole question and says it was cut.
      const asking = toolText(
        yield* toolCall(rpc, "read-asking", "agent_read", { agentIds: [ASKING_AGENT] }),
      );
      expect(asking?.text).toContain(ASKING_QUESTION);
      expect(asking?.text).not.toContain("SYSTEM-END");
      expect(asking?.text).toContain("truncated");

      const sent = toolText(
        yield* toolCall(rpc, "send", "agent_send", { to: "agent-r1-2", message: "Compare notes." }),
      );
      expect(sent).toMatchObject({ isError: false, text: stringContaining("guided") });
      const refused = toolText(
        yield* toolCall(rpc, "send-limited", "agent_send", {
          to: RATE_LIMITED_AGENT,
          message: "Hi.",
        }),
      );
      expect(refused).toMatchObject({
        isError: true,
        text: stringContaining("agent_unavailable"),
      });
      expect(fixture.calls).toEqual([
        { kind: "list", ids: undefined },
        { kind: "read", ids: ["agent-r1-2", "main"] },
        { kind: "read", ids: [SAVED_REPORT_AGENT] },
        { kind: "read", ids: ["agent-r1-2"] },
        { kind: "read", ids: [ASKING_AGENT] },
        { kind: "send", to: "agent-r1-2", message: "Compare notes." },
      ]);

      const config = yield* connectionConfig(handle);
      const direct = yield* connectDirectRpc(handle, config);
      yield* Effect.orDie(direct.client.SupervisorOpenSession(config));
      const forged = yield* direct.client
        .SupervisorAgentSend({
          ...config,
          runId: SupervisorRunIdSchema.make("agent-forged-sender"),
          assignmentEpoch: 1,
          to: "agent-r1-2",
          message: "Pretend to be another run.",
        })
        .pipe(Effect.exit, Effect.timeout("5 seconds"), Effect.orDie);
      // The channel refuses the identity and closes the peer, so the reply may never arrive.
      expect(Exit.isFailure(forged)).toBe(true);
      yield* direct.close;
      expect(fixture.calls).toHaveLength(6);
    },
    20_000,
  );

  liveTest(
    "refuses agent_send from a native sub-agent thread but lets it list and read",
    function* () {
      const runId = "agent-supervisor-native-agents";
      const fixture = recordingAgents(runId);
      const { handle } = yield* openChannel(runId, {}, fixture.agents);
      const { rpc } = yield* readyHelper(handle);
      handle.setMainAgentThread("main-thread");
      const fromThread = (id: string, name: string, args: JsonRpcObject, threadId: string) =>
        rpc
          .request({
            jsonrpc: "2.0",
            id,
            method: "tools/call",
            params: { name, arguments: args, _meta: { threadId } },
          })
          .pipe(Effect.map(toolText));
      const message = { to: "main", message: "Sub-agent findings." };

      expect(yield* fromThread("sub-send", "agent_send", message, "sub-thread")).toMatchObject({
        isError: true,
        text: stringContaining("main agent"),
      });
      expect(yield* fromThread("sub-list", "agent_list", {}, "sub-thread")).toMatchObject({
        isError: false,
      });
      expect(
        yield* fromThread("sub-read", "agent_read", { agentIds: ["main"] }, "sub-thread"),
      ).toMatchObject({ isError: false });
      expect(Arr.map(fixture.calls, (call) => call.kind)).toEqual(["list", "read"]);

      expect(yield* fromThread("main-send", "agent_send", message, "main-thread")).toMatchObject({
        isError: false,
      });
      expect(fixture.calls.at(-1)).toEqual({ kind: "send", ...message });
    },
    20_000,
  );

  liveTest("rejects oversized agent tool arguments before they reach the root", function* () {
    const runId = "agent-supervisor-agent-bounds";
    const fixture = recordingAgents(runId);
    const { handle } = yield* openChannel(runId, {}, fixture.agents);
    const { rpc } = yield* readyHelper(handle);
    const tooMany = Array.from({ length: 13 }, (_, index) => `agent-r1-${index + 1}`);

    for (const [id, name, args, problem] of [
      ["long", "agent_send", { to: "main", message: Fn.pipe("x", Str.repeat(131_073)) }, "131,072"],
      ["blank", "agent_send", { to: "main", message: "  " }, "message"],
      ["bad-to", "agent_send", { to: "../main", message: "Hi." }, "agent ID"],
      ["many-read", "agent_read", { agentIds: tooMany }, "the limit is 12"],
      ["many-list", "agent_list", { agentIds: tooMany }, "the limit is 12"],
      ["empty-read", "agent_read", { agentIds: [] }, "at least one"],
      ["extra", "agent_list", { agentIds: [], all: true }, "Unexpected argument all"],
    ] as const)
      expect(toolText(yield* toolCall(rpc, id, name, args))).toMatchObject({
        isError: true,
        text: stringContaining(problem),
      });

    const config = yield* connectionConfig(handle);
    const direct = yield* connectDirectRpc(handle, config);
    yield* Effect.orDie(direct.client.SupervisorOpenSession(config));
    const oversized = yield* direct.client
      .SupervisorAgentRead({ ...config, assignmentEpoch: 1, ids: tooMany })
      .pipe(Effect.exit, Effect.timeout("5 seconds"), Effect.orDie);
    expect(Exit.isFailure(oversized)).toBe(true);
    yield* direct.close;
    expect(fixture.calls).toEqual([]);
  });
});
