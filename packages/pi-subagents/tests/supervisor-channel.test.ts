import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { hasObjectRuntimeType, runtimeTypeName } from "pi-cosmic-core";
import { connect } from "node:net";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
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
import { afterEach, describe, expect, it } from "@effect/vitest";
import { step } from "./support/effect-test.ts";
import {
  nodeFsPromises,
  nodePath,
  nodeSpawn as spawn,
  type NodeChildProcessWithoutNullStreams as ChildProcessWithoutNullStreams,
} from "./support/node-builtins.ts";
import {
  makeSupervisorChannel,
  type SupervisorChannelHandle,
  type SupervisorChannelLayerOptions,
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

type JsonRpcValue = Schema.Json;
interface JsonRpcObject {
  readonly [key: string]: JsonRpcValue;
}

const decodeJsonLine = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json));
const decodeConnectionConfig = Schema.decodeUnknownSync(
  Schema.fromJsonString(SupervisorChannelConfigSchema),
);

const { mkdir, readFile, readdir, stat, symlink, writeFile } = nodeFsPromises;

const children: ChildProcessWithoutNullStreams[] = [];
const scopes: Scope.Closeable[] = [];
const directories: Scope.Closeable[] = [];

const liveTest = (
  name: string,
  body: () => Generator<Effect.Effect<unknown, never, Scope.Scope>, void, never>,
  timeout?: number,
): void => it.live(name, () => Effect.gen(body), timeout);

const wait = (millis: number): Promise<void> =>
  Effect.runPromise(Effect.sleep(Duration.millis(millis)));

const withTimeout = <A>(promise: Promise<A>, millis = 5_000): Promise<A> => {
  const timeout: Promise<never> = Effect.runPromise(
    Effect.sleep(Duration.millis(millis)).pipe(
      Effect.andThen(Effect.die(new Error("test operation timed out"))),
    ),
  );
  return Promise.race([promise, timeout]);
};

const closeAll = (owned: Scope.Closeable[]) =>
  Promise.all(owned.splice(0).map((scope) => Effect.runPromiseExit(Scope.close(scope, Exit.void))));

afterEach(() =>
  closeAll(scopes).then((closed) => {
    for (const child of children.splice(0)) {
      child.stdin.destroy();
      child.kill("SIGKILL");
    }
    return closeAll(directories).then(() => expect(closed.every(Exit.isSuccess)).toBe(true));
  }),
);

interface OpenTestChannel {
  readonly handle: SupervisorChannelHandle;
  readonly scope: Scope.Closeable;
  readonly agentDirectory: string;
  readonly projectDirectory: string;
}

const stageAgentHome = (prefix: string) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const directory = yield* Scope.make();
      directories.push(directory);
      const root = yield* Scope.provide(directory)(temporaryDirectory(prefix));
      const agentDirectory = nodePath.join(root, "agent-home");
      yield* step(() => mkdir(agentDirectory, { mode: 0o700 }));
      const scope = yield* Scope.make();
      scopes.push(scope);
      return { root, agentDirectory, scope };
    }),
  );

const openIn = (
  scope: Scope.Closeable,
  options: SupervisorChannelLayerOptions,
  runId: string,
  agents?: BackendAgentMessaging,
) =>
  makeSupervisorChannel(options)
    .open({ runId, agents })
    .pipe(Effect.provideService(Scope.Scope, scope));

const openChannel = (
  runId = "agent-supervisor-test",
  options: Omit<SupervisorChannelLayerOptions, "agentDirectory"> = {},
  agents?: BackendAgentMessaging,
): Promise<OpenTestChannel> =>
  stageAgentHome("pi-subagents-supervisor-").then(({ root, agentDirectory, scope }) => {
    const projectDirectory = nodePath.join(root, "project");
    return mkdir(projectDirectory, { mode: 0o700 })
      .then(() =>
        writeFile(nodePath.join(projectDirectory, "marker.txt"), "project-only\n", "utf8"),
      )
      .then(() => Effect.runPromise(openIn(scope, { agentDirectory, ...options }, runId, agents)))
      .then((handle) => ({ handle, scope, agentDirectory, projectDirectory }));
  });

class RpcClient {
  readonly messages: JsonRpcValue[] = [];
  readonly #pending = new Map<string, (value: JsonRpcValue) => void>();
  readonly #waiters: Array<{
    readonly predicate: (value: JsonRpcValue) => boolean;
    readonly resolve: (value: JsonRpcValue) => void;
  }> = [];
  #buffer = "";
  readonly child: ChildProcessWithoutNullStreams;

  constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    child.stdout.on("data", (chunk: Buffer) => {
      this.#buffer += chunk.toString("utf8");
      let newline = this.#buffer.indexOf("\n");
      while (newline >= 0) {
        const line = this.#buffer.slice(0, newline);
        this.#buffer = this.#buffer.slice(newline + 1);
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
        for (let index = this.#waiters.length - 1; index >= 0; index -= 1) {
          const waiter = this.#waiters[index];
          if (!waiter?.predicate(value)) continue;
          this.#waiters.splice(index, 1);
          waiter.resolve(value);
        }
        newline = this.#buffer.indexOf("\n");
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

  request(value: JsonRpcObject & { readonly id: string | number }) {
    const key = `${runtimeTypeName(value.id)}:${String(value.id)}`;
    const cell = deferredPromise<JsonRpcValue>();
    this.#pending.set(key, cell.resolve);
    this.send(value);
    return withTimeout(cell.promise);
  }

  next(predicate: (value: JsonRpcValue) => boolean) {
    const existing = this.messages.find(predicate);
    if (existing) return Promise.resolve(existing);
    const cell = deferredPromise<JsonRpcValue>();
    this.#waiters.push({ predicate, resolve: cell.resolve });
    return withTimeout(cell.promise);
  }
}

const spawnHelper = (handle: SupervisorChannelHandle) => {
  const child = spawn(
    process.execPath,
    [handle.metadata.helperPath, "--config", handle.metadata.connectionConfigPath],
    { env: {}, stdio: ["pipe", "pipe", "pipe"] },
  );
  children.push(child);
  return { child, rpc: new RpcClient(child) };
};

const initialize = (rpc: RpcClient) =>
  rpc
    .request({
      jsonrpc: "2.0",
      id: "initialize",
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      },
    })
    .then((initialized) => {
      expect(initialized).toMatchObject({
        id: "initialize",
        result: { protocolVersion: "2025-06-18" },
      });
      rpc.send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
      return undefined;
    });

const readyHelper = (handle: SupervisorChannelHandle) =>
  Effect.gen(function* () {
    const helper = spawnHelper(handle);
    yield* step(() => initialize(helper.rpc));
    yield* Effect.orDie(handle.awaitReady);
    yield* Effect.orDie(handle.setAssignmentEpoch(1));
    return helper;
  });

const connectionRefused = ({ host, port }: { readonly host: string; readonly port: number }) => {
  const refused = deferredPromise<boolean>();
  const socket = connect({ host, port });
  socket.once("connect", () => {
    socket.destroy();
    refused.resolve(false);
  });
  socket.once("error", () => refused.resolve(true));
  return withTimeout(refused.promise);
};

const awaitPeerClosed = (handle: SupervisorChannelHandle, frame?: string) => {
  const socket = connect({ host: handle.metadata.host, port: handle.metadata.port });
  const closed = deferredPromise();
  socket.once("close", () => closed.resolve());
  socket.once("error", () => closed.resolve());
  if (frame !== undefined) socket.write(frame);
  return withTimeout(closed.promise).then(() => socket.destroyed);
};

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

const takeEvent = (handle: SupervisorChannelHandle) =>
  withTimeout(Effect.runPromise(Queue.take(handle.events)));

const waitForExit = (child: ChildProcessWithoutNullStreams) => {
  const exited = deferredPromise<{ code: number | null; signal: NodeJS.Signals | null }>();
  child.once("exit", (code, signal) => exited.resolve({ code, signal }));
  return withTimeout(exited.promise);
};

type DirectSupervisorClient = EffectRpcClient.FromGroup<
  typeof SupervisorRpcGroup,
  RpcClientError.RpcClientError
>;

interface DirectRpcChannel {
  readonly scope: Scope.Closeable;
  readonly client: DirectSupervisorClient;
  readonly auth: SupervisorChannelConfig;
  readonly close: () => Promise<void>;
}

const connectDirectRpc = (
  handle: SupervisorChannelHandle,
  auth: SupervisorChannelConfig,
): Promise<DirectRpcChannel> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const scope = yield* Scope.make();
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
      return { scope, client };
    }),
  ).then(({ scope, client }) => ({
    scope,
    client,
    auth,
    close: () => Effect.runPromise(Scope.close(scope, Exit.void)),
  }));

const connectionConfig = (handle: SupervisorChannelHandle): Promise<SupervisorChannelConfig> =>
  readFile(handle.metadata.connectionConfigPath, "utf8").then(decodeConnectionConfig);

type AgentCall =
  | { readonly kind: "list"; readonly ids?: ReadonlyArray<string> | undefined }
  | { readonly kind: "send"; readonly to: string; readonly message: string }
  | { readonly kind: "read"; readonly ids: ReadonlyArray<string> };

const RATE_LIMITED_AGENT = "agent-r1-9";

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
          missingIds: ids?.filter((id) => id !== "main" && id !== selfId) ?? [],
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
            return { messageId: "message-r1-1", to, name: "peer", disposition: "guided" };
          }),
    read: (ids) =>
      Effect.sync(() => {
        calls.push({ kind: "read", ids });
        return {
          agents: ids.map((id) => ({
            kind: "run" as const,
            id,
            name: "peer",
            state: "completed" as const,
            textStatus: "text" as const,
            text: `Findings from ${id}.`,
            truncated: false,
            source: "report" as const,
            reportGeneration: 1,
            run: view({
              id,
              name: "peer",
              state: "completed",
              parentRunId: selfId,
              warning: `Warning from ${id}.`,
              pid: 4242,
            }),
          })),
          missingIds: [],
        };
      }),
  };
  return { calls, agents };
};

const toolText = (value: JsonRpcValue) =>
  Predicate.isObject(value) &&
  Predicate.isObject(value.result) &&
  Array.isArray(value.result.content) &&
  Predicate.isObject(value.result.content[0]) &&
  Predicate.isString(value.result.content[0].text)
    ? { text: value.result.content[0].text, isError: value.result.isError === true }
    : undefined;

describe("private supervisor channel", () => {
  liveTest(
    "rejects invalid run identities, relative state roots, and symlink state roots",
    function* () {
      const { root, agentDirectory, scope } = yield* step(() =>
        stageAgentHome("pi-subagents-supervisor-paths-"),
      );

      yield* step(() =>
        expect(
          Effect.runPromise(openIn(scope, { agentDirectory }, "../invalid")),
        ).rejects.toMatchObject({ code: "invalid_run_id" }),
      );
      yield* step(() =>
        expect(
          Effect.runPromise(
            openIn(scope, { agentDirectory: "relative-agent-home" }, "agent-path-test"),
          ),
        ).rejects.toMatchObject({ code: "channel_open_failed" }),
      );

      const linkedAgentDirectory = nodePath.join(root, "linked-agent-home");
      yield* step(() => symlink(agentDirectory, linkedAgentDirectory, "dir"));
      yield* step(() =>
        expect(
          Effect.runPromise(
            openIn(scope, { agentDirectory: linkedAgentDirectory }, "agent-path-test"),
          ),
        ).rejects.toMatchObject({ code: "channel_open_failed" }),
      );
      expect(yield* step(() => readdir(agentDirectory))).toEqual([]);
    },
  );

  liveTest("cleans staged acquisition immediately when open is interrupted", function* () {
    const { agentDirectory, scope } = yield* step(() =>
      stageAgentHome("pi-subagents-supervisor-late-open-"),
    );
    const acquisitionEntered = deferredPromise();
    const acquisitionGate = deferredPromise();
    let metadata: SupervisorChannelHandle["metadata"] | undefined;
    const options: SupervisorChannelLayerOptions = {
      agentDirectory,
      beforeAcquireComplete: (acquired) => {
        metadata = acquired;
        acquisitionEntered.resolve();
        return acquisitionGate.promise;
      },
    };
    const abort = new AbortController();
    const opening = Effect.runPromise(openIn(scope, options, "agent-supervisor-late-open"), {
      signal: abort.signal,
    });

    yield* step(() => withTimeout(acquisitionEntered.promise));
    abort.abort();
    yield* step(() => expect(withTimeout(opening)).rejects.toBeDefined());
    const acquired = metadata;
    if (!acquired) throw new Error("late acquisition metadata was not captured");
    const cleaned = yield* step(() =>
      stat(acquired.connectionConfigPath).then(
        () => false,
        (cause: unknown) => Predicate.hasProperty(cause, "code") && cause.code === "ENOENT",
      ),
    );
    expect(cleaned).toBe(true);

    acquisitionGate.resolve();
    expect(yield* step(() => connectionRefused(acquired))).toBe(true);
  });

  liveTest(
    "waits for private config publication to settle before interrupted cleanup",
    function* () {
      const { agentDirectory, scope } = yield* step(() =>
        stageAgentHome("pi-subagents-supervisor-config-commit-"),
      );
      const commitEntered = deferredPromise();
      const commitGate = deferredPromise();
      let metadata: SupervisorChannelHandle["metadata"] | undefined;
      const options: SupervisorChannelLayerOptions = {
        agentDirectory,
        beforeConfigCommit: (acquired) => {
          metadata = acquired;
          commitEntered.resolve();
          return commitGate.promise;
        },
      };
      const abort = new AbortController();
      let settled = false;
      const opening = Effect.runPromise(openIn(scope, options, "agent-supervisor-config-commit"), {
        signal: abort.signal,
      }).finally(() => {
        settled = true;
      });

      yield* step(() => withTimeout(commitEntered.promise));
      abort.abort();
      yield* step(() => wait(20));
      expect(settled).toBe(false);
      commitGate.resolve();
      yield* step(() => expect(withTimeout(opening)).rejects.toBeDefined());
      const acquired = metadata;
      if (!acquired) throw new Error("config commit metadata was not captured");
      yield* step(() =>
        expect(stat(acquired.stateDirectory)).rejects.toMatchObject({ code: "ENOENT" }),
      );
    },
  );

  liveTest("settles owned work and removes every resource on scope release", function* () {
    const { handle, scope } = yield* step(() => openChannel("agent-supervisor-scope-close"));
    const config = yield* step(() => connectionConfig(handle));
    const direct = yield* step(() => connectDirectRpc(handle, config));
    yield* Effect.orDie(direct.client.SupervisorOpenSession(config));
    const epochSeen = deferredPromise();
    const watching = Effect.runPromiseExit(
      Stream.runForEach(direct.client.SupervisorWatchAssignments(config), (update) =>
        update.kind === "assignment" && update.assignmentEpoch === 1
          ? direct.client.SupervisorAcknowledgeAssignment({
              ...config,
              updateId: update.updateId,
              assignmentEpoch: update.assignmentEpoch,
            })
          : Effect.sync(() => {
              epochSeen.resolve();
            }),
      ),
    );
    yield* Effect.orDie(handle.awaitReady);
    yield* Effect.orDie(handle.setAssignmentEpoch(1));
    const question = Effect.runPromiseExit(
      direct.client.SupervisorQuestion({
        ...config,
        assignmentEpoch: 1,
        requestId: SupervisorChannelIdSchema.make("question-before-shared-close"),
        message: "Will shutdown settle this question?",
      }),
    );
    expect(yield* step(() => takeEvent(handle))).toMatchObject({
      type: "supervisor_contact",
      kind: "question",
    });
    const advancing = Effect.runPromise(handle.setAssignmentEpoch(2).pipe(Effect.flip));
    yield* step(() => withTimeout(epochSeen.promise));

    yield* Scope.close(scope, Exit.void);
    for (const pending of [advancing]) {
      const error = yield* step(() => withTimeout(pending));
      expect(error).toBeInstanceOf(SupervisorChannelError);
      expect(error.code).toBe("channel_closed");
    }
    expect(Exit.isFailure(yield* step(() => withTimeout(question)))).toBe(true);
    yield* step(() => withTimeout(watching));
    yield* step(() =>
      expect(Effect.runPromise(handle.awaitReady)).rejects.toMatchObject({
        code: "channel_closed",
      }),
    );
    yield* step(() =>
      expect(stat(handle.metadata.stateDirectory)).rejects.toMatchObject({ code: "ENOENT" }),
    );
    expect(yield* step(() => connectionRefused(handle.metadata))).toBe(true);
    yield* step(() => direct.close());
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
      const { handle } = yield* step(() => openChannel(runId, options));
      expect(yield* step(() => awaitPeerClosed(handle, frame))).toBe(true);
    });

  liveTest(
    "refuses parent contact and the report from a native sub-agent thread but accepts the main agent's",
    function* () {
      const { handle } = yield* step(() => openChannel("agent-native-thread"));
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
        const refused = yield* step(() => fromThread(id, name, args, "sub-agent-thread"));
        expect(refused).toMatchObject({
          result: { isError: true, content: [{ text: stringContaining("parent") }] },
        });
      }
      expect(Queue.sizeUnsafe(handle.events)).toBe(0);

      yield* step(() =>
        fromThread(
          "main-progress",
          "agent_contact_parent",
          { kind: "progress", message: "Halfway." },
          "main-thread",
        ),
      );
      expect(yield* step(() => takeEvent(handle))).toMatchObject({
        kind: "progress",
        message: "Halfway.",
      });

      const accepted = yield* step(() =>
        fromThread("main-report", "agent_submit_report", report, "main-thread"),
      );
      expect(accepted).toMatchObject({
        result: { content: [{ text: stringContaining("accepted") }] },
      });
      expect(yield* step(() => takeEvent(handle))).toMatchObject({
        type: "report",
        text: "Sub-agent findings.",
      });
    },
  );

  liveTest(
    "spawns the helper and keeps blocked questions concurrent, correlated, cancellable, and epoch-safe",
    function* () {
      const opened = yield* step(() => openChannel());
      const { handle, scope, projectDirectory } = opened;

      const config = yield* step(() => connectionConfig(handle));
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
      const listed = yield* step(() =>
        rpc.request({ jsonrpc: "2.0", id: "list", method: "tools/list", params: {} }),
      );
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
        yield* step(() =>
          toolCall(rpc, "camel-case-report", "agent_submit_report", {
            deliveryId: "delivery-main",
            report: "Bounded final report.",
          }),
        ),
      ).toMatchObject({ result: { isError: true } });

      const questionResponse = toolCall(rpc, "question-1", "agent_contact_parent", {
        kind: "question",
        message: "Which implementation should I use?",
      });
      const question = yield* step(() => takeEvent(handle));
      expect(question).toMatchObject({
        type: "supervisor_contact",
        kind: "question",
        assignmentEpoch: 1,
        message: "Which implementation should I use?",
      });
      if (question.type !== "supervisor_contact") throw new Error("expected question");
      rpc.cancel("an-unrelated-request");

      const [ping, progress, report] = yield* step(() =>
        Promise.all([
          rpc.ping("ping-while-blocked"),
          toolCall(rpc, "progress-while-blocked", "agent_contact_parent", {
            kind: "progress",
            message: "Continuing independent work.",
          }),
          toolCall(rpc, "report-while-blocked", "agent_submit_report", {
            delivery_id: "delivery-main",
            report: "Bounded final report.",
          }),
        ]),
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
      expect(
        yield* step(() => Effect.runPromise(handle.hasAcceptedReport(2)).catch(() => false)),
      ).toBe(false);
      const concurrentEvents = [
        yield* step(() => takeEvent(handle)),
        yield* step(() => takeEvent(handle)),
        yield* step(() => takeEvent(handle)),
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

      expect(yield* step(() => questionResponse)).toMatchObject({ error: { code: -32800 } });
      yield* step(() =>
        expect(
          Effect.runPromise(handle.reply(question.requestId, "Use the service seam.")),
        ).rejects.toMatchObject({ code: "question_ownership_mismatch" }),
      );

      // An assignment may ask again once its earlier question settled, one at a time.
      const secondQuestion = toolCall(rpc, "question-second", "agent_contact_parent", {
        kind: "question",
        message: "A second question?",
      });
      const second = yield* step(() => takeEvent(handle));
      if (second.type !== "supervisor_contact") throw new Error("expected question");
      expect(second).toMatchObject({ kind: "question", assignmentEpoch: 1 });
      const concurrent = yield* step(() =>
        toolCall(rpc, "question-concurrent", "agent_contact_parent", {
          kind: "question",
          message: "A question while another waits?",
        }),
      );
      expect(concurrent).toMatchObject({ error: { code: -32000 } });
      yield* step(() =>
        Effect.runPromise(handle.reply(second.requestId, "Use the second answer.")),
      );
      expect(yield* step(() => secondQuestion)).toMatchObject({
        result: { content: [{ text: "Parent reply: Use the second answer." }] },
      });

      const retry = yield* step(() =>
        toolCall(rpc, "report-retry", "agent_submit_report", {
          delivery_id: "delivery-main",
          report: "Bounded final report.",
        }),
      );
      expect(retry).toMatchObject({
        result: { content: [{ text: stringContaining("retry accepted; sequence 1") }] },
      });
      const noDuplicateEvent = yield* Queue.poll(handle.events);
      expect(Option.isNone(noDuplicateEvent)).toBe(true);
      const conflict = yield* step(() =>
        toolCall(rpc, "report-conflict", "agent_submit_report", {
          delivery_id: "delivery-main",
          report: "Conflicting report.",
        }),
      );
      expect(conflict).toMatchObject({ error: { code: -32000 } });

      const laterReport = yield* step(() =>
        toolCall(rpc, "report-later", "agent_submit_report", {
          delivery_id: "delivery-later",
          report: "Later evidence for the same assignment.",
        }),
      );
      expect(laterReport).toMatchObject({
        result: { content: [{ text: stringContaining("sequence 2") }] },
      });
      expect(yield* step(() => takeEvent(handle))).toMatchObject({
        type: "report",
        sequence: 2,
        deliveryId: "delivery-later",
      });
      expect(yield* Effect.orDie(handle.acceptedReportForEpoch(1))).toMatchObject({
        sequence: 1,
        deliveryId: "delivery-main",
      });

      yield* Effect.orDie(handle.setAssignmentEpoch(2));
      const crossEpochRetry = yield* step(() =>
        toolCall(rpc, "report-cross-epoch", "agent_submit_report", {
          delivery_id: "delivery-main",
          report: "Bounded final report.",
        }),
      );
      expect(crossEpochRetry).toMatchObject({ error: { code: -32000 } });
      const cancelledQuestion = toolCall(rpc, "question-cancelled", "agent_contact_parent", {
        kind: "question",
        message: "Wait for a reply that will be cancelled.",
      });
      const cancellationEvent = yield* step(() => takeEvent(handle));
      expect(cancellationEvent).toMatchObject({
        type: "supervisor_contact",
        kind: "question",
        assignmentEpoch: 2,
      });
      rpc.cancel("question-cancelled");
      expect(yield* step(() => cancelledQuestion)).toMatchObject({ error: { code: -32800 } });
      expect(yield* step(() => takeEvent(handle))).toMatchObject({
        type: "parent_question_cancelled",
        assignmentEpoch: 2,
        requestId:
          cancellationEvent.type === "supervisor_contact" ? cancellationEvent.requestId : "",
      });
      yield* Effect.orDie(handle.setAssignmentEpoch(3));
      if (cancellationEvent.type !== "supervisor_contact") throw new Error("expected question");
      yield* step(() => wait(20));
      yield* step(() =>
        expect(
          Effect.runPromise(handle.reply(cancellationEvent.requestId, "Too late.")),
        ).rejects.toMatchObject({ code: "question_ownership_mismatch" }),
      );
      expect(yield* step(() => rpc.ping("ping-after-cancel"))).toMatchObject({ result: {} });

      const direct = yield* step(() => connectDirectRpc(handle, config));
      yield* Effect.orDie(direct.client.SupervisorOpenSession(config));
      yield* step(() =>
        Effect.runPromise(
          direct.client.SupervisorProgress({
            ...config,
            requestId: SupervisorChannelIdSchema.make("late-progress"),
            assignmentEpoch: 1,
            message: "Late event from assignment one.",
          }),
        ),
      );
      expect(yield* step(() => takeEvent(handle))).toMatchObject({
        type: "supervisor_contact",
        requestId: "late-progress",
        assignmentEpoch: 1,
        message: "Late event from assignment one.",
      });
      yield* step(() => direct.close());

      const forged = yield* step(() =>
        connectDirectRpc(handle, {
          ...config,
          token: SupervisorAuthTokenSchema.make("0".repeat(64)),
        }),
      );
      yield* step(() =>
        expect(
          Effect.runPromise(forged.client.SupervisorOpenSession(forged.auth)),
        ).rejects.toBeDefined(),
      );
      yield* step(() => forged.close());
      expect(Option.isNone(yield* Queue.poll(handle.events))).toBe(true);

      const many = Array.from({ length: 12 }, (_, index) =>
        toolCall(rpc, `concurrent-${index}`, "agent_contact_parent", {
          kind: "progress",
          message: `Concurrent progress ${index}`,
        }),
      );
      const manyResponses = yield* step(() => Promise.all(many));
      expect(manyResponses.every((value) => value && hasObjectRuntimeType(value))).toBe(true);
      for (let index = 0; index < 12; index += 1) yield* step(() => takeEvent(handle));

      const childExit = waitForExit(child);
      yield* Scope.close(scope, Exit.void);
      expect(yield* step(() => childExit)).toMatchObject({ signal: null });
      expect(yield* step(() => readdir(projectDirectory))).toEqual(["marker.txt"]);
      yield* step(() =>
        expect(stat(handle.metadata.stateDirectory)).rejects.toMatchObject({ code: "ENOENT" }),
      );
    },
    20_000,
  );

  liveTest(
    "requires a current live helper for each readiness generation and epoch",
    function* () {
      const { handle } = yield* step(() => openChannel("agent-supervisor-readiness"));
      yield* step(() =>
        expect(Effect.runPromise(handle.setAssignmentEpoch(1))).rejects.toMatchObject({
          code: "supervisor_helper_unavailable",
        }),
      );

      const first = yield* readyHelper(handle);
      const firstExit = waitForExit(first.child);
      first.child.kill("SIGTERM");
      yield* step(() => firstExit);
      yield* step(() => wait(20));
      yield* step(() =>
        expect(Effect.runPromise(handle.setAssignmentEpoch(2))).rejects.toMatchObject({
          code: "supervisor_helper_unavailable",
        }),
      );

      const replacement = spawnHelper(handle);
      yield* step(() => initialize(replacement.rpc));
      yield* Effect.orDie(handle.awaitReady);
      yield* Effect.orDie(handle.setAssignmentEpoch(2));
    },
    20_000,
  );

  liveTest(
    "writes exactly one response when cancellation arrives after a backpressured reply",
    function* () {
      const { handle } = yield* step(() => openChannel("agent-supervisor-one-response"));
      const { child, rpc } = yield* readyHelper(handle);

      const response = toolCall(rpc, "question-after-reply", "agent_contact_parent", {
        kind: "question",
        message: "Choose after stdout is backpressured.",
      });
      const question = yield* step(() => takeEvent(handle));
      if (question.type !== "supervisor_contact") throw new Error("expected question");

      child.stdout.pause();
      for (let index = 0; index < 48; index += 1)
        rpc.send({
          jsonrpc: "2.0",
          id: `backpressure-${index}`,
          method: "tools/list",
          params: {},
        });
      yield* step(() =>
        Effect.runPromise(handle.reply(question.requestId, "Use the stable path.")),
      );
      yield* step(() => wait(20));
      rpc.cancel("question-after-reply");
      child.stdout.resume();

      expect(yield* step(() => response)).toMatchObject({
        id: "question-after-reply",
        result: { content: [{ text: "Parent reply: Use the stable path." }] },
      });
      expect(yield* step(() => rpc.ping("ping-after-reply-race"))).toMatchObject({ result: {} });
      yield* step(() => wait(20));
      expect(
        rpc.messages.filter(
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
      const { handle } = yield* step(() => openChannel("agent-supervisor-disconnect"));
      const { child, rpc } = yield* readyHelper(handle);

      const pending = toolCall(rpc, "question-before-disconnect", "agent_contact_parent", {
        kind: "question",
        message: "Should I continue?",
      });
      void pending.catch(() => undefined);
      const questionEvent = yield* step(() => takeEvent(handle));
      expect(questionEvent).toMatchObject({
        type: "supervisor_contact",
        kind: "question",
        assignmentEpoch: 1,
      });
      if (questionEvent.type !== "supervisor_contact") throw new Error("expected question");

      const exited = waitForExit(child);
      child.kill("SIGKILL");
      yield* step(() => exited);
      expect(yield* step(() => takeEvent(handle))).toMatchObject({
        type: "parent_question_cancelled",
        assignmentEpoch: 1,
        requestId: questionEvent.requestId,
      });
      yield* step(() =>
        expect(
          Effect.runPromise(handle.reply(questionEvent.requestId, "Continue.")),
        ).rejects.toMatchObject({ code: "question_ownership_mismatch" }),
      );
    },
  );

  liveTest(
    "rejects excess, malformed, and oversized MCP input and closes boundedly",
    function* () {
      const opened = yield* step(() => openChannel("agent-supervisor-malformed"));
      const { handle, scope } = opened;
      expect(handle.metadata.host).toBe("127.0.0.1");

      const { child, rpc } = yield* readyHelper(handle);
      const excessTopLevel = yield* step(() =>
        rpc.request({
          jsonrpc: "2.0",
          id: "excess-top",
          method: "ping",
          params: {},
          unexpected: true,
        }),
      );
      expect(excessTopLevel).toMatchObject({ error: { code: -32600 } });
      const excessTool = yield* step(() =>
        toolCall(rpc, "excess-tool", "agent_contact_parent", {
          kind: "progress",
          message: "valid",
          unexpected: true,
        }),
      );
      expect(excessTool).toMatchObject({ result: { isError: true } });
      const oversizedString = yield* step(() =>
        toolCall(rpc, "oversized-tool", "agent_contact_parent", {
          kind: "progress",
          message: "x".repeat(16 * 1024 + 1),
        }),
      );
      expect(oversizedString).toMatchObject({
        result: {
          isError: true,
          content: [{ type: "text", text: stringContaining("16,384") }],
        },
      });

      child.stdin.write("{not-json}\n");
      expect(yield* step(() => rpc.next(isNullIdError(-32700)))).toMatchObject({
        error: { code: -32700 },
      });

      yield* Scope.close(scope, Exit.void);
      yield* step(() =>
        expect(stat(handle.metadata.connectionConfigPath)).rejects.toMatchObject({
          code: "ENOENT",
        }),
      );
    },
    20_000,
  );

  liveTest(
    "serves agent tools for the channel's own run and ignores forged run identities",
    function* () {
      const runId = "agent-supervisor-agents";
      const fixture = recordingAgents(runId);
      const { handle } = yield* step(() => openChannel(runId, {}, fixture.agents));
      const { rpc } = yield* readyHelper(handle);

      const listed = toolText(yield* step(() => toolCall(rpc, "list", "agent_list", {})));
      expect(listed?.isError).toBe(false);
      expect(listed?.text).toContain(`${runId} "api-scout"`);
      expect(listed?.text).toMatch(/scout; runtime claude; child of main; you/u);

      const read = toolText(
        yield* step(() =>
          toolCall(rpc, "read", "agent_read", { agentIds: ["agent-r1-2", "main"] }),
        ),
      );
      expect(read?.text).toContain("Findings from agent-r1-2.");
      expect(read?.text).toContain("from its report");
      // Each run's status card comes with its message; verbose adds process details.
      expect(read?.text).toContain("Warning from agent-r1-2.");
      expect(read?.text).not.toContain("pid 4242");
      const verbose = toolText(
        yield* step(() =>
          toolCall(rpc, "read-verbose", "agent_read", { agentIds: ["agent-r1-2"], verbose: true }),
        ),
      );
      expect(verbose?.text).toContain("pid 4242");

      const sent = toolText(
        yield* step(() =>
          toolCall(rpc, "send", "agent_send", { to: "agent-r1-2", message: "Compare notes." }),
        ),
      );
      expect(sent).toMatchObject({ isError: false, text: stringContaining("guided") });
      const refused = toolText(
        yield* step(() =>
          toolCall(rpc, "send-limited", "agent_send", { to: RATE_LIMITED_AGENT, message: "Hi." }),
        ),
      );
      expect(refused).toMatchObject({
        isError: true,
        text: stringContaining("agent_unavailable"),
      });
      expect(fixture.calls).toEqual([
        { kind: "list", ids: undefined },
        { kind: "read", ids: ["agent-r1-2", "main"] },
        { kind: "read", ids: ["agent-r1-2"] },
        { kind: "send", to: "agent-r1-2", message: "Compare notes." },
      ]);

      const config = yield* step(() => connectionConfig(handle));
      const direct = yield* step(() => connectDirectRpc(handle, config));
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
      yield* step(() => direct.close());
      expect(fixture.calls).toHaveLength(4);
    },
    20_000,
  );

  liveTest(
    "refuses agent_send from a native sub-agent thread but lets it list and read",
    function* () {
      const runId = "agent-supervisor-native-agents";
      const fixture = recordingAgents(runId);
      const { handle } = yield* step(() => openChannel(runId, {}, fixture.agents));
      const { rpc } = yield* readyHelper(handle);
      handle.setMainAgentThread("main-thread");
      const fromThread = (id: string, name: string, args: JsonRpcObject, threadId: string) =>
        step(() =>
          rpc.request({
            jsonrpc: "2.0",
            id,
            method: "tools/call",
            params: { name, arguments: args, _meta: { threadId } },
          }),
        ).pipe(Effect.map(toolText));
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
      expect(fixture.calls.map((call) => call.kind)).toEqual(["list", "read"]);

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
    const { handle } = yield* step(() => openChannel(runId, {}, fixture.agents));
    const { rpc } = yield* readyHelper(handle);
    const tooMany = Array.from({ length: 13 }, (_, index) => `agent-r1-${index + 1}`);

    for (const [id, name, args, problem] of [
      ["long", "agent_send", { to: "main", message: "x".repeat(16_385) }, "16,384"],
      ["blank", "agent_send", { to: "main", message: "  " }, "message"],
      ["bad-to", "agent_send", { to: "../main", message: "Hi." }, "agent ID"],
      ["many-read", "agent_read", { agentIds: tooMany }, "the limit is 12"],
      ["many-list", "agent_list", { agentIds: tooMany }, "the limit is 12"],
      ["empty-read", "agent_read", { agentIds: [] }, "at least one"],
      ["extra", "agent_list", { agentIds: [], all: true }, "Unexpected argument all"],
    ] as const)
      expect(toolText(yield* step(() => toolCall(rpc, id, name, args)))).toMatchObject({
        isError: true,
        text: stringContaining(problem),
      });

    const config = yield* step(() => connectionConfig(handle));
    const direct = yield* step(() => connectDirectRpc(handle, config));
    yield* Effect.orDie(direct.client.SupervisorOpenSession(config));
    const oversized = yield* direct.client
      .SupervisorAgentRead({ ...config, assignmentEpoch: 1, ids: tooMany })
      .pipe(Effect.exit, Effect.timeout("5 seconds"), Effect.orDie);
    expect(Exit.isFailure(oversized)).toBe(true);
    yield* step(() => direct.close());
    expect(fixture.calls).toEqual([]);
  });
});
