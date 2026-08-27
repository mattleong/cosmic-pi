// Node/MCP Promise behavior is characterized at this boundary.
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { hasObjectRuntimeType, runtimeTypeName } from "pi-cosmic-core";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import {
  RpcClient as EffectRpcClient,
  RpcClientError,
  RpcSerialization,
} from "effect/unstable/rpc";
import { Socket as EffectSocket } from "effect/unstable/socket";
import { afterEach, describe, expect } from "vitest";
import { effectTest, step } from "./support/effect-test.ts";
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
import { SUPERVISOR_MCP_PROXY_TOOL_NAME } from "../src/supervisor/mcp-contract.ts";
import {
  MAX_SUPERVISOR_CHANNEL_LINE_BYTES,
  SupervisorAuthTokenSchema,
  SupervisorChannelIdSchema,
  type SupervisorChannelConfig,
  SupervisorDeliveryIdSchema,
  SupervisorRpcGroup,
} from "../src/supervisor/protocol.ts";

type JsonRpcValue = string | number | boolean | null | JsonRpcValue[] | JsonRpcObject;
interface JsonRpcObject {
  readonly [key: string]: JsonRpcValue;
}

const { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } = nodeFsPromises;
const { join } = nodePath;

const temporaryDirectories: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];

// Real-time coordination with live child processes deliberately runs on the live default clock.
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

/** One Deferred-backed latch usable from promise-shaped fixture callbacks. */
const promiseGate = () => {
  const cell = Deferred.makeUnsafe<void>();
  return {
    promise: Effect.runPromise(Deferred.await(cell)),
    open: () => {
      Deferred.doneUnsafe(cell, Effect.void);
    },
  };
};

afterEach(() => {
  for (const child of children.splice(0)) {
    child.stdin.destroy();
    child.kill("SIGKILL");
  }
  return Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  ).then(() => undefined);
});

interface OpenTestChannel {
  readonly handle: SupervisorChannelHandle;
  readonly scope: Scope.Closeable;
  readonly agentDirectory: string;
  readonly projectDirectory: string;
}

const openChannel = (
  runId = "agent-supervisor-test",
  options: Omit<SupervisorChannelLayerOptions, "agentDirectory"> = {},
  allowPiProxy = false,
): Promise<OpenTestChannel> =>
  mkdtemp(join(tmpdir(), "pi-subagents-supervisor-")).then((root) => {
    temporaryDirectories.push(root);
    const agentDirectory = join(root, "agent-home");
    const projectDirectory = join(root, "project");
    return Promise.all([
      mkdir(agentDirectory, { mode: 0o700 }),
      mkdir(projectDirectory, { mode: 0o700 }),
    ])
      .then(() => writeFile(join(projectDirectory, "marker.txt"), "project-only\n", "utf8"))
      .then(() => Effect.runPromise(Scope.make()))
      .then((scope) =>
        Effect.runPromise(
          makeSupervisorChannel({ agentDirectory, ...options })
            .open({ runId, allowPiProxy })
            .pipe(Effect.provideService(Scope.Scope, scope)),
        ).then((handle) => ({ handle, scope, agentDirectory, projectDirectory })),
      );
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
        // SAFETY: The test controls the serialized fixture and asserts the exact decoded contract below.
        const value = JSON.parse(line) as JsonRpcValue;
        this.messages.push(value);
        if (value && hasObjectRuntimeType(value) && "id" in value) {
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

  send<ValueInput>(value: ValueInput): void {
    this.child.stdin.write(`${JSON.stringify(value)}\n`);
  }

  request<Request extends JsonRpcObject & { readonly id: string | number }>(value: Request) {
    const key = `${runtimeTypeName(value.id)}:${String(value.id)}`;
    const cell = Deferred.makeUnsafe<JsonRpcValue>();
    this.#pending.set(key, (incoming) => {
      Deferred.doneUnsafe(cell, Effect.succeed(incoming));
    });
    this.send(value);
    return withTimeout(Effect.runPromise(Deferred.await(cell)));
  }

  next(predicate: (value: JsonRpcValue) => boolean) {
    const existing = this.messages.find(predicate);
    if (existing) return Promise.resolve(existing);
    const cell = Deferred.makeUnsafe<JsonRpcValue>();
    this.#waiters.push({
      predicate,
      resolve: (incoming) => {
        Deferred.doneUnsafe(cell, Effect.succeed(incoming));
      },
    });
    return withTimeout(Effect.runPromise(Deferred.await(cell)));
  }
}

const helperExecutable = fileURLToPath(
  new URL("../src/boundary/supervisor-mcp-helper.mjs", import.meta.url),
);

const spawnHelper = (handle: SupervisorChannelHandle) => {
  const child = spawn(
    process.execPath,
    [handle.metadata.helperPath, "--config", handle.metadata.connectionConfigPath],
    { env: {}, stdio: ["pipe", "pipe", "pipe"] },
  );
  children.push(child);
  return { child, rpc: new RpcClient(child) };
};

const initialize = (rpc: RpcClient, clientName = "test") =>
  rpc
    .request({
      jsonrpc: "2.0",
      id: "initialize",
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: clientName, version: "1" },
      },
    })
    .then((initialized) => {
      expect(initialized).toMatchObject({
        id: "initialize",
        result: { protocolVersion: "2025-06-18" },
      });
      rpc.send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
    });

const toolCall = (rpc: RpcClient, id: string | number, name: string, args: JsonRpcObject) =>
  rpc.request({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
  });

const takeEvent = (handle: SupervisorChannelHandle) =>
  withTimeout(Effect.runPromise(Queue.take(handle.events)));

const waitForExit = (child: ChildProcessWithoutNullStreams) => {
  const exited = Deferred.makeUnsafe<{ code: number | null; signal: NodeJS.Signals | null }>();
  child.once("exit", (code, signal) =>
    Deferred.doneUnsafe(exited, Effect.succeed({ code, signal })),
  );
  return withTimeout(Effect.runPromise(Deferred.await(exited)));
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

const nextAssignment = (channel: DirectRpcChannel) =>
  Effect.runPromise(Stream.runHead(channel.client.SupervisorWatchAssignments(channel.auth))).then(
    (update) => Option.getOrThrow(update),
  );

// SAFETY: The test controls the serialized fixture and asserts the exact decoded contract below.
const connectionConfig = (handle: SupervisorChannelHandle): Promise<SupervisorChannelConfig> =>
  readFile(handle.metadata.connectionConfigPath, "utf8").then(
    (source) => JSON.parse(source) as SupervisorChannelConfig,
  );

describe("private supervisor channel", () => {
  effectTest("reports bounded startup failure and exits with code 2", function* () {
    const child = spawn(process.execPath, [helperExecutable], {
      env: {},
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.push(child);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    expect(yield* step(() => waitForExit(child))).toEqual({ code: 2, signal: null });
    expect(stdout).toBe("");
    expect(stderr).toBe("Private supervisor helper configuration argument is invalid.\n");
  });

  effectTest("publishes bounded-input rejection before the helper shuts down", function* () {
    const opened = yield* step(() => openChannel("agent-supervisor-input-overflow"));
    const { child, rpc } = spawnHelper(opened.handle);
    yield* step(() => initialize(rpc));
    const rejected = rpc.next(
      (value) =>
        value !== null &&
        hasObjectRuntimeType(value) &&
        !Array.isArray(value) &&
        value.id === null &&
        value.error !== null &&
        hasObjectRuntimeType(value.error) &&
        !Array.isArray(value.error) &&
        value.error.code === -32600,
    );
    child.stdin.write(`${"x".repeat(MAX_SUPERVISOR_CHANNEL_LINE_BYTES + 1)}\n`);

    expect(yield* step(() => rejected)).toMatchObject({
      id: null,
      error: { code: -32600 },
    });
    expect((yield* step(() => waitForExit(child))).signal).toBeNull();
    yield* step(() => Effect.runPromise(Scope.close(opened.scope, Exit.void)));
  });

  effectTest(
    "rejects invalid run identities, relative state roots, and symlink state roots",
    function* () {
      const root = yield* step(() => mkdtemp(join(tmpdir(), "pi-subagents-supervisor-paths-")));
      temporaryDirectories.push(root);
      const agentDirectory = join(root, "agent-home");
      yield* step(() => mkdir(agentDirectory, { mode: 0o700 }));
      const scope = yield* step(() => Effect.runPromise(Scope.make()));

      yield* step(() =>
        expect(
          Effect.runPromise(
            makeSupervisorChannel({ agentDirectory })
              .open({ runId: "../invalid" })
              .pipe(Effect.provideService(Scope.Scope, scope)),
          ),
        ).rejects.toMatchObject({ code: "invalid_run_id" }),
      );
      yield* step(() =>
        expect(
          Effect.runPromise(
            makeSupervisorChannel({ agentDirectory: "relative-agent-home" })
              .open({ runId: "agent-path-test" })
              .pipe(Effect.provideService(Scope.Scope, scope)),
          ),
        ).rejects.toMatchObject({ code: "channel_open_failed" }),
      );

      if (process.platform !== "win32") {
        const linkedAgentDirectory = join(root, "linked-agent-home");
        yield* step(() => symlink(agentDirectory, linkedAgentDirectory, "dir"));
        yield* step(() =>
          expect(
            Effect.runPromise(
              makeSupervisorChannel({ agentDirectory: linkedAgentDirectory })
                .open({ runId: "agent-path-test" })
                .pipe(Effect.provideService(Scope.Scope, scope)),
            ),
          ).rejects.toMatchObject({ code: "channel_open_failed" }),
        );
      }
      expect(yield* step(() => readdir(agentDirectory))).toEqual([]);
      yield* step(() => Effect.runPromise(Scope.close(scope, Exit.void)));
    },
  );

  effectTest("cleans staged acquisition immediately when open is interrupted", function* () {
    const root = yield* step(() => mkdtemp(join(tmpdir(), "pi-subagents-supervisor-late-open-")));
    temporaryDirectories.push(root);
    const agentDirectory = join(root, "agent-home");
    yield* step(() => mkdir(agentDirectory, { mode: 0o700 }));
    const scope = yield* step(() => Effect.runPromise(Scope.make()));
    const acquisitionEntered = promiseGate();
    const acquisitionGate = promiseGate();
    let metadata: SupervisorChannelHandle["metadata"] | undefined;
    const channel = makeSupervisorChannel({
      agentDirectory,
      beforeAcquireComplete: (acquired) => {
        metadata = acquired;
        acquisitionEntered.open();
        return acquisitionGate.promise;
      },
    });
    const abort = new AbortController();
    const opening = Effect.runPromise(
      channel
        .open({ runId: "agent-supervisor-late-open" })
        .pipe(Effect.provideService(Scope.Scope, scope)),
      { signal: abort.signal },
    );

    yield* step(() => withTimeout(acquisitionEntered.promise));
    abort.abort();
    yield* step(() => expect(withTimeout(opening)).rejects.toBeDefined());
    const acquired = metadata;
    if (!acquired) throw new Error("late acquisition metadata was not captured");
    const cleaned = yield* step(() =>
      stat(acquired.connectionConfigPath).then(
        () => false,
        (error: NodeJS.ErrnoException) => error.code === "ENOENT",
      ),
    );
    expect(cleaned).toBe(true);

    acquisitionGate.open();
    const refusedCell = Deferred.makeUnsafe<boolean>();
    const socket = connect({ host: acquired.host, port: acquired.port });
    socket.once("connect", () => {
      socket.destroy();
      Deferred.doneUnsafe(refusedCell, Effect.succeed(false));
    });
    socket.once("error", () => Deferred.doneUnsafe(refusedCell, Effect.succeed(true)));
    const refused = yield* step(() => Effect.runPromise(Deferred.await(refusedCell)));
    expect(refused).toBe(true);
    yield* step(() => Effect.runPromise(Scope.close(scope, Exit.void)));
  });

  effectTest(
    "waits for private config publication to settle before interrupted cleanup",
    function* () {
      const root = yield* step(() =>
        mkdtemp(join(tmpdir(), "pi-subagents-supervisor-config-commit-")),
      );
      temporaryDirectories.push(root);
      const agentDirectory = join(root, "agent-home");
      yield* step(() => mkdir(agentDirectory, { mode: 0o700 }));
      const scope = yield* step(() => Effect.runPromise(Scope.make()));
      const commitEntered = promiseGate();
      const commitGate = promiseGate();
      let metadata: SupervisorChannelHandle["metadata"] | undefined;
      const channel = makeSupervisorChannel({
        agentDirectory,
        beforeConfigCommit: (acquired) => {
          metadata = acquired;
          commitEntered.open();
          return commitGate.promise;
        },
      });
      const abort = new AbortController();
      let settled = false;
      const opening = Effect.runPromise(
        channel
          .open({ runId: "agent-supervisor-config-commit" })
          .pipe(Effect.provideService(Scope.Scope, scope)),
        { signal: abort.signal },
      ).finally(() => {
        settled = true;
      });

      yield* step(() => withTimeout(commitEntered.promise));
      abort.abort();
      yield* step(() => wait(20));
      expect(settled).toBe(false);
      commitGate.open();
      yield* step(() => expect(withTimeout(opening)).rejects.toBeDefined());
      const acquired = metadata;
      if (!acquired) throw new Error("config commit metadata was not captured");
      yield* step(() =>
        expect(stat(acquired.stateDirectory)).rejects.toMatchObject({ code: "ENOENT" }),
      );
      yield* step(() => Effect.runPromise(Scope.close(scope, Exit.void)));
    },
  );

  effectTest("maps rejected config publication and removes every acquired stage", function* () {
    const root = yield* step(() =>
      mkdtemp(join(tmpdir(), "pi-subagents-supervisor-config-rejection-")),
    );
    temporaryDirectories.push(root);
    const agentDirectory = join(root, "agent-home");
    yield* step(() => mkdir(agentDirectory, { mode: 0o700 }));
    const scope = yield* step(() => Effect.runPromise(Scope.make()));
    let metadata: SupervisorChannelHandle["metadata"] | undefined;
    const channel = makeSupervisorChannel({
      agentDirectory,
      beforeConfigCommit: (acquired) => {
        metadata = acquired;
        return Promise.reject(new Error("hostile config publication rejection"));
      },
    });

    yield* step(() =>
      expect(
        Effect.runPromise(
          channel
            .open({ runId: "agent-supervisor-config-rejection" })
            .pipe(Effect.provideService(Scope.Scope, scope)),
        ),
      ).rejects.toMatchObject({
        operation: "write channel config",
        code: "config_write_failed",
      }),
    );
    const acquired = metadata;
    if (!acquired) throw new Error("rejected config metadata was not captured");
    yield* step(() =>
      expect(stat(acquired.stateDirectory)).rejects.toMatchObject({ code: "ENOENT" }),
    );
    const refusedCell = Deferred.makeUnsafe<boolean>();
    const socket = connect({ host: acquired.host, port: acquired.port });
    socket.once("connect", () => {
      socket.destroy();
      Deferred.doneUnsafe(refusedCell, Effect.succeed(false));
    });
    socket.once("error", () => Deferred.doneUnsafe(refusedCell, Effect.succeed(true)));
    expect(yield* step(() => Effect.runPromise(Deferred.await(refusedCell)))).toBe(true);
    yield* step(() => Effect.runPromise(Scope.close(scope, Exit.void)));
  });

  effectTest("closes an unauthenticated peer at the scoped authentication deadline", function* () {
    const opened = yield* step(() =>
      openChannel("agent-supervisor-auth-deadline", {
        authTimeoutMillis: 10,
      }),
    );
    const socket = connect({
      host: opened.handle.metadata.host,
      port: opened.handle.metadata.port,
    });
    const closedCell = Deferred.makeUnsafe<void>();
    socket.once("close", () => Deferred.doneUnsafe(closedCell, Effect.void));
    socket.once("error", () => Deferred.doneUnsafe(closedCell, Effect.void));
    yield* step(() => withTimeout(Effect.runPromise(Deferred.await(closedCell))));

    expect(socket.destroyed).toBe(true);
    yield* step(() => Effect.runPromise(Scope.close(opened.scope, Exit.void)));
  });

  effectTest("closes malformed private RPC frames before authentication", function* () {
    const opened = yield* step(() => openChannel("agent-supervisor-malformed-rpc"));
    const socket = connect({
      host: opened.handle.metadata.host,
      port: opened.handle.metadata.port,
    });
    const closedCell = Deferred.makeUnsafe<void>();
    socket.once("close", () => Deferred.doneUnsafe(closedCell, Effect.void));
    socket.once("error", () => Deferred.doneUnsafe(closedCell, Effect.void));
    socket.write("{not-effect-rpc}\n");
    yield* step(() => withTimeout(Effect.runPromise(Deferred.await(closedCell))));
    expect(socket.destroyed).toBe(true);
    yield* step(() => Effect.runPromise(Scope.close(opened.scope, Exit.void)));
  });

  effectTest("exposes the authenticated coordinator proxy only to delegated Pi", function* () {
    const opened = yield* step(() => openChannel("agent-pi-proxy", {}, true));
    const { child, rpc } = spawnHelper(opened.handle);
    yield* step(() => initialize(rpc, "pi-subagents-pi-bridge"));
    yield* step(() => Effect.runPromise(opened.handle.awaitReady));
    yield* step(() => Effect.runPromise(opened.handle.setAssignmentEpoch(1)));

    const listed = yield* step(() =>
      rpc.request({ jsonrpc: "2.0", id: "list-proxy", method: "tools/list", params: {} }),
    );
    expect(listed).toMatchObject({
      result: {
        tools: expect.arrayContaining([
          expect.objectContaining({ name: SUPERVISOR_MCP_PROXY_TOOL_NAME }),
        ]),
      },
    });

    const pending = toolCall(rpc, "proxy-call", SUPERVISOR_MCP_PROXY_TOOL_NAME, {
      tool: "subagent_list",
      arguments_json: "{}",
    });
    const event = yield* step(() => takeEvent(opened.handle));
    expect(event).toMatchObject({
      type: "proxy_request",
      tool: "subagent_list",
      argumentsJson: "{}",
    });
    if (event.type !== "proxy_request") throw new Error("expected proxy request");
    yield* step(() =>
      Effect.runPromise(
        event.respond(
          true,
          JSON.stringify({ content: [{ type: "text", text: "No child runs." }], details: {} }),
        ),
      ),
    );
    expect(yield* step(() => pending)).toMatchObject({
      result: { content: [{ text: expect.stringContaining("No child runs") }] },
    });

    const notification = rpc.next(
      (value) =>
        hasObjectRuntimeType(value) &&
        value !== null &&
        !Array.isArray(value) &&
        value.method === "notifications/pi_subagents",
    );
    const delivered = Effect.runPromise(
      opened.handle.deliverNotification("A descendant finished."),
    );
    expect(yield* step(() => notification)).toMatchObject({
      params: { message: "A descendant finished." },
    });
    yield* step(() => delivered);

    child.kill("SIGTERM");
    yield* step(() => waitForExit(child));
    yield* step(() => Effect.runPromise(Scope.close(opened.scope, Exit.void)));
  });

  effectTest(
    "spawns the helper and keeps blocked questions concurrent, correlated, cancellable, and epoch-safe",
    function* () {
      const opened = yield* step(() => openChannel());
      const { handle, scope, projectDirectory } = opened;

      const config = yield* step(() => connectionConfig(handle));
      expect(config).toMatchObject({
        version: 3,
        runId: handle.runId,
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

      const { child, rpc } = spawnHelper(handle);
      yield* step(() => initialize(rpc));
      yield* step(() => Effect.runPromise(handle.awaitReady));
      yield* step(() => Effect.runPromise(handle.setAssignmentEpoch(1)));
      const listed = yield* step(() =>
        rpc.request({
          jsonrpc: "2.0",
          id: "list",
          method: "tools/list",
          params: {},
        }),
      );
      expect(listed).toMatchObject({
        result: {
          tools: [
            {
              name: "supervisor_progress",
              inputSchema: { properties: { message: { pattern: ".*\\S.*" } } },
            },
            {
              name: "supervisor_warning",
              inputSchema: { properties: { message: { pattern: ".*\\S.*" } } },
            },
            {
              name: "supervisor_question",
              inputSchema: { properties: { message: { pattern: ".*\\S.*" } } },
            },
            {
              name: "supervisor_submit_report",
              inputSchema: {
                required: ["delivery_id", "report"],
                properties: {
                  delivery_id: { pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$" },
                  report: { pattern: ".*\\S.*" },
                },
              },
            },
          ],
        },
      });

      expect(
        yield* step(() =>
          toolCall(rpc, "camel-case-report", "supervisor_submit_report", {
            deliveryId: "delivery-main",
            report: "Bounded final report.",
          }),
        ),
      ).toMatchObject({ result: { isError: true } });

      const questionResponse = toolCall(rpc, "question-1", "supervisor_question", {
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
      rpc.send({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: "an-unrelated-request" },
      });

      const [ping, progress, report] = yield* step(() =>
        Promise.all([
          rpc.request({ jsonrpc: "2.0", id: "ping-while-blocked", method: "ping", params: {} }),
          toolCall(rpc, "progress-while-blocked", "supervisor_progress", {
            message: "Continuing independent work.",
          }),
          toolCall(rpc, "report-while-blocked", "supervisor_submit_report", {
            delivery_id: "delivery-main",
            report: "Bounded final report.",
          }),
        ]),
      );
      expect(ping).toMatchObject({ id: "ping-while-blocked", result: {} });
      expect(progress).not.toMatchObject({ error: expect.anything() });
      expect(report).toMatchObject({
        result: { content: [{ text: expect.stringContaining("sequence 1") }] },
      });
      // Report acceptance is causally visible before the adapter drains either queued event, even
      // when progress/backpressure is ahead of the report.
      expect(yield* step(() => Effect.runPromise(handle.hasAcceptedReport(1)))).toBe(true);
      expect(yield* step(() => Effect.runPromise(handle.acceptedReportForEpoch(1)))).toMatchObject({
        runId: handle.runId,
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
            type: "supervisor_question_cancelled",
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

      const secondQuestion = yield* step(() =>
        toolCall(rpc, "question-duplicate", "supervisor_question", {
          message: "A second question?",
        }),
      );
      expect(secondQuestion).toMatchObject({ error: { code: -32000 } });

      const retry = yield* step(() =>
        toolCall(rpc, "report-retry", "supervisor_submit_report", {
          delivery_id: "delivery-main",
          report: "Bounded final report.",
        }),
      );
      expect(retry).toMatchObject({
        result: { content: [{ text: expect.stringContaining("retry accepted; sequence 1") }] },
      });
      const noDuplicateEvent = yield* step(() => Effect.runPromise(Queue.poll(handle.events)));
      expect(Option.isNone(noDuplicateEvent)).toBe(true);
      const conflict = yield* step(() =>
        toolCall(rpc, "report-conflict", "supervisor_submit_report", {
          delivery_id: "delivery-main",
          report: "Conflicting report.",
        }),
      );
      expect(conflict).toMatchObject({ error: { code: -32000 } });

      const laterReport = yield* step(() =>
        toolCall(rpc, "report-later", "supervisor_submit_report", {
          delivery_id: "delivery-later",
          report: "Later evidence for the same assignment.",
        }),
      );
      expect(laterReport).toMatchObject({
        result: { content: [{ text: expect.stringContaining("sequence 2") }] },
      });
      expect(yield* step(() => takeEvent(handle))).toMatchObject({
        type: "report",
        sequence: 2,
        deliveryId: "delivery-later",
      });
      expect(yield* step(() => Effect.runPromise(handle.acceptedReportForEpoch(1)))).toMatchObject({
        sequence: 1,
        deliveryId: "delivery-main",
      });

      yield* step(() => Effect.runPromise(handle.setAssignmentEpoch(2)));
      const crossEpochRetry = yield* step(() =>
        toolCall(rpc, "report-cross-epoch", "supervisor_submit_report", {
          delivery_id: "delivery-main",
          report: "Bounded final report.",
        }),
      );
      expect(crossEpochRetry).toMatchObject({ error: { code: -32000 } });
      const cancelledQuestion = toolCall(rpc, "question-cancelled", "supervisor_question", {
        message: "Wait for a reply that will be cancelled.",
      });
      const cancellationEvent = yield* step(() => takeEvent(handle));
      expect(cancellationEvent).toMatchObject({
        type: "supervisor_contact",
        kind: "question",
        assignmentEpoch: 2,
      });
      rpc.send({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: "question-cancelled" },
      });
      expect(yield* step(() => cancelledQuestion)).toMatchObject({ error: { code: -32800 } });
      expect(yield* step(() => takeEvent(handle))).toMatchObject({
        type: "supervisor_question_cancelled",
        assignmentEpoch: 2,
        requestId:
          cancellationEvent.type === "supervisor_contact" ? cancellationEvent.requestId : "",
      });
      yield* step(() => Effect.runPromise(handle.setAssignmentEpoch(3)));
      if (cancellationEvent.type !== "supervisor_contact") throw new Error("expected question");
      yield* step(() => wait(20));
      yield* step(() =>
        expect(
          Effect.runPromise(handle.reply(cancellationEvent.requestId, "Too late.")),
        ).rejects.toMatchObject({ code: "question_ownership_mismatch" }),
      );
      expect(
        yield* step(() =>
          rpc.request({ jsonrpc: "2.0", id: "ping-after-cancel", method: "ping", params: {} }),
        ),
      ).toMatchObject({ result: {} });

      const direct = yield* step(() => connectDirectRpc(handle, config));
      yield* step(() => Effect.runPromise(direct.client.SupervisorOpenSession(config)));
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
      expect(Option.isNone(yield* step(() => Effect.runPromise(Queue.poll(handle.events))))).toBe(
        true,
      );

      const many = Array.from({ length: 12 }, (_, index) =>
        toolCall(rpc, `concurrent-${index}`, "supervisor_progress", {
          message: `Concurrent progress ${index}`,
        }),
      );
      const manyResponses = yield* step(() => Promise.all(many));
      expect(manyResponses).toHaveLength(12);
      expect(manyResponses.every((value) => value && hasObjectRuntimeType(value))).toBe(true);
      for (let index = 0; index < 12; index += 1) yield* step(() => takeEvent(handle));
      // Every stdout line observed by the parser was independently valid JSON under concurrency.
      expect(rpc.messages.length).toBeGreaterThanOrEqual(20);

      const childExit = waitForExit(child);
      yield* step(() => Effect.runPromise(handle.close));
      expect(yield* step(() => childExit)).toMatchObject({ signal: null });
      expect(yield* step(() => readdir(projectDirectory))).toEqual(["marker.txt"]);
      yield* step(() =>
        expect(stat(handle.metadata.stateDirectory)).rejects.toMatchObject({ code: "ENOENT" }),
      );
      yield* step(() => Effect.runPromise(Scope.close(scope, Exit.void)));
    },
    20_000,
  );

  effectTest("waits for a delayed live-peer epoch acknowledgement before advancing", function* () {
    const opened = yield* step(() => openChannel("agent-supervisor-delayed-ack"));
    const { handle, scope } = opened;
    const config = yield* step(() => connectionConfig(handle));
    const direct = yield* step(() => connectDirectRpc(handle, config));
    yield* step(() => Effect.runPromise(direct.client.SupervisorOpenSession(config)));
    const updatePromise = nextAssignment(direct);
    yield* step(() => Effect.runPromise(handle.awaitReady));
    let settled = false;
    const setting = Effect.runPromise(handle.setAssignmentEpoch(1)).finally(() => {
      settled = true;
    });
    const update = yield* step(() => updatePromise);
    if (update.kind !== "assignment") throw new Error("expected assignment update");
    yield* step(() => wait(50));
    expect(settled).toBe(false);
    yield* step(() =>
      Effect.runPromise(
        direct.client.SupervisorAcknowledgeAssignment({
          ...config,
          updateId: update.updateId,
          assignmentEpoch: update.assignmentEpoch,
        }),
      ),
    );
    yield* step(() => setting);
    yield* step(() => direct.close());
    yield* step(() => Effect.runPromise(handle.close));
    yield* step(() => Effect.runPromise(Scope.close(scope, Exit.void)));
  });

  effectTest(
    "does not let an authenticated non-watching peer block healthy assignment delivery",
    function* () {
      const { handle, scope } = yield* step(() => openChannel("agent-supervisor-stalled-peer"));
      const config = yield* step(() => connectionConfig(handle));
      const idle = yield* step(() => connectDirectRpc(handle, config));
      yield* step(() => Effect.runPromise(idle.client.SupervisorOpenSession(config)));
      expect(
        Option.isNone(
          yield* step(() =>
            Effect.runPromise(handle.awaitReady.pipe(Effect.timeoutOption("20 millis"))),
          ),
        ),
      ).toBe(true);

      const healthy = spawnHelper(handle);
      yield* step(() => initialize(healthy.rpc));
      yield* step(() => Effect.runPromise(handle.awaitReady));
      for (let epoch = 1; epoch <= 6; epoch += 1)
        yield* step(() => Effect.runPromise(handle.setAssignmentEpoch(epoch)));
      expect(
        yield* step(() =>
          healthy.rpc.request({ jsonrpc: "2.0", id: "healthy-ping", method: "ping", params: {} }),
        ),
      ).toMatchObject({ result: {} });

      yield* step(() => idle.close());
      yield* step(() => Effect.runPromise(handle.close));
      yield* step(() => Effect.runPromise(Scope.close(scope, Exit.void)));
    },
  );

  effectTest(
    "keeps every healthy helper alive after the first assignment acknowledgement",
    function* () {
      const { handle, scope } = yield* step(() => openChannel("agent-supervisor-multiple-helpers"));
      const first = spawnHelper(handle);
      const second = spawnHelper(handle);
      yield* step(() => Promise.all([initialize(first.rpc), initialize(second.rpc)]));
      yield* step(() => Effect.runPromise(handle.awaitReady));
      yield* step(() => Effect.runPromise(handle.setAssignmentEpoch(1)));
      yield* step(() => wait(50));
      const pings = yield* step(() =>
        Promise.all([
          first.rpc.request({ jsonrpc: "2.0", id: "first-ping", method: "ping", params: {} }),
          second.rpc.request({ jsonrpc: "2.0", id: "second-ping", method: "ping", params: {} }),
        ]),
      );
      expect(pings).toEqual([
        expect.objectContaining({ result: {} }),
        expect.objectContaining({ result: {} }),
      ]);

      yield* step(() => Effect.runPromise(handle.close));
      yield* step(() => Effect.runPromise(Scope.close(scope, Exit.void)));
    },
  );

  effectTest(
    "fails epoch advancement immediately when every acknowledging helper disconnects",
    function* () {
      const { handle, scope } = yield* step(() => openChannel("agent-supervisor-epoch-disconnect"));
      const config = yield* step(() => connectionConfig(handle));
      const direct = yield* step(() => connectDirectRpc(handle, config));
      yield* step(() => Effect.runPromise(direct.client.SupervisorOpenSession(config)));
      const updatePromise = nextAssignment(direct);
      yield* step(() => Effect.runPromise(handle.awaitReady));
      const setting = Effect.runPromise(handle.setAssignmentEpoch(1));
      yield* step(() => updatePromise);
      yield* step(() => direct.close());
      yield* step(() =>
        expect(withTimeout(setting, 500)).rejects.toMatchObject({
          code: "assignment_epoch_outcome_uncertain",
        }),
      );

      yield* step(() => Effect.runPromise(handle.close));
      yield* step(() => Effect.runPromise(Scope.close(scope, Exit.void)));
    },
  );

  effectTest(
    "requires a current live helper for each readiness generation and epoch",
    function* () {
      const opened = yield* step(() => openChannel("agent-supervisor-readiness"));
      const { handle, scope } = opened;
      yield* step(() =>
        expect(Effect.runPromise(handle.setAssignmentEpoch(1))).rejects.toMatchObject({
          code: "supervisor_helper_unavailable",
        }),
      );

      const first = spawnHelper(handle);
      yield* step(() => initialize(first.rpc));
      yield* step(() => Effect.runPromise(handle.awaitReady));
      yield* step(() => Effect.runPromise(handle.setAssignmentEpoch(1)));
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
      yield* step(() => Effect.runPromise(handle.awaitReady));
      yield* step(() => Effect.runPromise(handle.setAssignmentEpoch(2)));
      yield* step(() => Effect.runPromise(handle.close));
      yield* step(() => Effect.runPromise(Scope.close(scope, Exit.void)));
    },
    20_000,
  );

  effectTest(
    "writes exactly one response when cancellation arrives after a backpressured reply",
    function* () {
      const { handle, scope } = yield* step(() => openChannel("agent-supervisor-one-response"));
      const { child, rpc } = spawnHelper(handle);
      yield* step(() => initialize(rpc));
      yield* step(() => Effect.runPromise(handle.awaitReady));
      yield* step(() => Effect.runPromise(handle.setAssignmentEpoch(1)));

      const response = toolCall(rpc, "question-after-reply", "supervisor_question", {
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
      rpc.send({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: "question-after-reply" },
      });
      child.stdout.resume();

      expect(yield* step(() => response)).toMatchObject({
        id: "question-after-reply",
        result: { content: [{ text: "Parent reply: Use the stable path." }] },
      });
      expect(
        yield* step(() =>
          rpc.request({ jsonrpc: "2.0", id: "ping-after-reply-race", method: "ping", params: {} }),
        ),
      ).toMatchObject({ result: {} });
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

      yield* step(() => Effect.runPromise(handle.close));
      yield* step(() => Effect.runPromise(Scope.close(scope, Exit.void)));
    },
    20_000,
  );

  effectTest(
    "queues a correlated cancellation when a helper disconnects with a pending question",
    function* () {
      const { handle, scope } = yield* step(() => openChannel("agent-supervisor-disconnect"));
      const { child, rpc } = spawnHelper(handle);
      yield* step(() => initialize(rpc));
      yield* step(() => Effect.runPromise(handle.awaitReady));
      yield* step(() => Effect.runPromise(handle.setAssignmentEpoch(1)));

      const pending = toolCall(rpc, "question-before-disconnect", "supervisor_question", {
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
        type: "supervisor_question_cancelled",
        assignmentEpoch: 1,
        requestId: questionEvent.requestId,
      });
      yield* step(() =>
        expect(
          Effect.runPromise(handle.reply(questionEvent.requestId, "Continue.")),
        ).rejects.toMatchObject({ code: "question_ownership_mismatch" }),
      );

      yield* step(() => Effect.runPromise(handle.close));
      yield* step(() => Effect.runPromise(Scope.close(scope, Exit.void)));
    },
  );

  effectTest(
    "queues a correlated cancellation when the owning adapter cancels a question",
    function* () {
      const { handle, scope } = yield* step(() => openChannel("agent-supervisor-close-question"));
      const { rpc } = spawnHelper(handle);
      yield* step(() => initialize(rpc));
      yield* step(() => Effect.runPromise(handle.awaitReady));
      yield* step(() => Effect.runPromise(handle.setAssignmentEpoch(1)));

      const pending = toolCall(rpc, "question-before-close", "supervisor_question", {
        message: "Will the channel close?",
      });
      const questionEvent = yield* step(() => takeEvent(handle));
      if (questionEvent.type !== "supervisor_contact") throw new Error("expected question");
      handle.cancelPending("Adapter is closing the assignment.");
      expect(yield* step(() => pending)).toMatchObject({ error: expect.anything() });
      expect(yield* step(() => takeEvent(handle))).toMatchObject({
        type: "supervisor_question_cancelled",
        assignmentEpoch: 1,
        requestId: questionEvent.requestId,
      });
      yield* step(() => Effect.runPromise(handle.close));
      yield* step(() => Effect.runPromise(Scope.close(scope, Exit.void)));
    },
  );

  effectTest(
    "reserves cancellation capacity for an accepted question under event saturation",
    function* () {
      const { handle, scope } = yield* step(() => openChannel("agent-supervisor-saturated"));
      const config = yield* step(() => connectionConfig(handle));
      const { rpc } = spawnHelper(handle);
      yield* step(() => initialize(rpc));
      yield* step(() => Effect.runPromise(handle.awaitReady));
      yield* step(() => Effect.runPromise(handle.setAssignmentEpoch(1)));
      yield* step(() => Effect.runPromise(handle.setAssignmentEpoch(2)));

      const direct = yield* step(() => connectDirectRpc(handle, config));
      yield* step(() => Effect.runPromise(direct.client.SupervisorOpenSession(config)));
      for (let index = 0; index < 62; index += 1)
        yield* step(() =>
          Effect.runPromise(
            direct.client.SupervisorProgress({
              ...config,
              requestId: SupervisorChannelIdSchema.make(`saturation-progress-${index}`),
              assignmentEpoch: 2,
              message: `Progress ${index}`,
            }),
          ),
        );

      const pending = toolCall(rpc, "saturated-question", "supervisor_question", {
        message: "Question at the reserved boundary?",
      });
      yield* step(() => wait(10));
      yield* step(() =>
        expect(
          Effect.runPromise(
            direct.client.SupervisorReport({
              ...config,
              requestId: SupervisorChannelIdSchema.make("older-report-at-saturation"),
              assignmentEpoch: 1,
              deliveryId: SupervisorDeliveryIdSchema.make("older-report-at-saturation"),
              text: "Older assignment report.",
            }),
          ),
        ).rejects.toMatchObject({ code: "event_queue_full" }),
      );
      rpc.send({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: "saturated-question" },
      });
      expect(yield* step(() => pending)).toMatchObject({ error: { code: -32800 } });

      const events: Array<Awaited<ReturnType<typeof takeEvent>>> = [];
      for (let index = 0; index < 64; index += 1) events.push(yield* step(() => takeEvent(handle)));
      const saturatedQuestion = events.at(-2);
      expect(saturatedQuestion).toMatchObject({
        type: "supervisor_contact",
        kind: "question",
      });
      if (
        !saturatedQuestion ||
        !hasObjectRuntimeType(saturatedQuestion) ||
        !("requestId" in saturatedQuestion)
      )
        throw new Error("missing saturated question correlation");
      expect(events.at(-1)).toMatchObject({
        type: "supervisor_question_cancelled",
        assignmentEpoch: 2,
        requestId: saturatedQuestion.requestId,
      });

      yield* step(() => direct.close());
      yield* step(() => Effect.runPromise(handle.close));
      yield* step(() => Effect.runPromise(Scope.close(scope, Exit.void)));
    },
    20_000,
  );

  effectTest(
    "rejects bad auth, excess/malformed/oversized MCP input, and closes boundedly",
    function* () {
      const opened = yield* step(() => openChannel("agent-supervisor-malformed"));
      const { handle, scope } = opened;
      const config = yield* step(() => connectionConfig(handle));

      const bad = yield* step(() =>
        connectDirectRpc(handle, {
          ...config,
          token: SupervisorAuthTokenSchema.make("0".repeat(64)),
        }),
      );
      yield* step(() =>
        expect(Effect.runPromise(bad.client.SupervisorOpenSession(bad.auth))).rejects.toBeDefined(),
      );
      yield* step(() => bad.close());
      expect(yield* step(() => Effect.runPromise(Queue.poll(handle.events)))).toEqual(
        Option.none(),
      );
      expect(handle.metadata.host).toBe("127.0.0.1");
      expect(config.host).toBe("127.0.0.1");

      const { child, rpc } = spawnHelper(handle);
      yield* step(() => initialize(rpc));
      yield* step(() => Effect.runPromise(handle.awaitReady));
      yield* step(() => Effect.runPromise(handle.setAssignmentEpoch(1)));
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
        toolCall(rpc, "excess-tool", "supervisor_progress", {
          message: "valid",
          unexpected: true,
        }),
      );
      expect(excessTool).toMatchObject({ result: { isError: true } });
      const oversizedString = yield* step(() =>
        toolCall(rpc, "oversized-tool", "supervisor_progress", {
          message: "x".repeat(16 * 1024 + 1),
        }),
      );
      expect(oversizedString).toMatchObject({ result: { isError: true } });

      child.stdin.write("{not-json}\n");
      expect(
        yield* step(() =>
          rpc.next(
            (value) =>
              !!value &&
              hasObjectRuntimeType(value) &&
              "id" in value &&
              value.id === null &&
              "error" in value,
          ),
        ),
      ).toMatchObject({ error: { code: -32700 } });

      const oversizedExit = waitForExit(child);
      child.stdin.write(`${"x".repeat(MAX_SUPERVISOR_CHANNEL_LINE_BYTES + 1)}\n`);
      expect(yield* step(() => oversizedExit)).toBeDefined();
      yield* step(() => wait(10));
      yield* step(() => Effect.runPromise(handle.close));
      yield* step(() =>
        expect(stat(handle.metadata.connectionConfigPath)).rejects.toMatchObject({
          code: "ENOENT",
        }),
      );
      yield* step(() => Effect.runPromise(Scope.close(scope, Exit.void)));
    },
    20_000,
  );
});
