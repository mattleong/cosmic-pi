// Private loopback supervisor RPC transport and agent-directory state live at this boundary.
import * as NodeSocketServer from "@effect/platform-node/NodeSocketServer";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { nodeFsPromises as fs, nodePath } from "./node-builtins.ts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";
import {
  isSupervisorRunId,
  MAX_SUPERVISOR_CHANNEL_LINE_BYTES,
  MAX_SUPERVISOR_CONFIG_BYTES,
  SUPERVISOR_CHANNEL_VERSION,
  SupervisorAuthTokenSchema,
  SupervisorChannelConfigSchema,
  type SupervisorChannelConfig,
  type SupervisorEvent,
  type SupervisorRunId,
  SupervisorOpenSessionRpc,
  SupervisorRpcGroup,
} from "../supervisor/protocol.ts";
import {
  SUPERVISOR_MCP_REGISTRATION,
  SUPERVISOR_MCP_TOOL_NAMES,
} from "../supervisor/mcp-contract.ts";
import {
  ensurePrivateDirectory,
  nodeErrorCode,
  safeAgentDirectory,
  tomlString,
  writeExclusive,
} from "./harness-shared.ts";
import { makeSupervisorRpcServerProtocol } from "./supervisor-rpc-protocol.ts";
import {
  channelError,
  makeSupervisorChannelSession,
  SupervisorChannelError,
  type SupervisorChannelControls,
} from "./supervisor-channel-session.ts";

export { SupervisorChannelError } from "./supervisor-channel-session.ts";

const { join } = nodePath;

const LOOPBACK_HOST = "127.0.0.1" as const;
const CHANNEL_ROOT = "supervisor-channels-v3";
const CONNECTION_CONFIG_FILE = "connection.json";
const EVENT_CAPACITY = 64;
const MAX_CONNECTIONS = 4;
const MAX_ACTIVE_RPC_REQUESTS = 32;
const AUTH_TIMEOUT_MILLIS = 5_000;

export interface ClaudeSupervisorMcpMetadata {
  readonly mcpServers: {
    readonly [SUPERVISOR_MCP_REGISTRATION]: {
      readonly type: "stdio";
      readonly command: string;
      readonly args: ReadonlyArray<string>;
      readonly env: Readonly<Record<string, never>>;
    };
  };
}

export interface CodexSupervisorMcpMetadata {
  readonly tomlFragment: string;
}

export interface SupervisorConnectionMetadata {
  readonly host: typeof LOOPBACK_HOST;
  readonly port: number;
  readonly stateDirectory: string;
  readonly connectionConfigPath: string;
  readonly helperPath: string;
  readonly claudeMcp: ClaudeSupervisorMcpMetadata;
  readonly codexMcp: CodexSupervisorMcpMetadata;
}

export interface SupervisorChannelHandle extends SupervisorChannelControls {
  readonly metadata: SupervisorConnectionMetadata;
  readonly events: Queue.Dequeue<SupervisorEvent, Cause.Done>;
  readonly close: Effect.Effect<void, SupervisorChannelError>;
}

export interface SupervisorChannelContract {
  readonly open: (
    request: SupervisorChannelOpenRequest,
  ) => Effect.Effect<SupervisorChannelHandle, SupervisorChannelError, Scope.Scope>;
}

export interface SupervisorChannelOpenRequest {
  readonly runId: string;
  readonly allowPiProxy?: boolean | undefined;
}

export interface SupervisorChannelLayerOptions {
  readonly agentDirectory: string;
  readonly beforeAcquireComplete?:
    | ((metadata: SupervisorConnectionMetadata) => Promise<void>)
    | undefined;
  /** Test seam for proving the private config commit masks interruption until settlement. */
  readonly beforeConfigCommit?:
    | ((metadata: SupervisorConnectionMetadata) => Promise<void>)
    | undefined;
  readonly authTimeoutMillis?: number | undefined;
}

const configWriteError = () =>
  channelError(
    "write channel config",
    "config_write_failed",
    "Unable to publish private supervisor configuration.",
  );

const makeMetadata = (
  port: number,
  stateDirectory: string,
  connectionConfigPath: string,
): SupervisorConnectionMetadata => {
  const helperPath = fileURLToPath(new URL("./supervisor-mcp-helper.mjs", import.meta.url));
  const command = process.execPath;
  const args = [helperPath, "--config", connectionConfigPath] as const;
  return {
    host: LOOPBACK_HOST,
    port,
    stateDirectory,
    connectionConfigPath,
    helperPath,
    claudeMcp: {
      mcpServers: {
        [SUPERVISOR_MCP_REGISTRATION]: {
          type: "stdio",
          command,
          args,
          env: {},
        },
      },
    },
    codexMcp: {
      tomlFragment: [
        `[mcp_servers.${SUPERVISOR_MCP_REGISTRATION}]`,
        `command = ${tomlString(command)}`,
        `args = [${args.map(tomlString).join(", ")}]`,
        "required = true",
        `enabled_tools = [${SUPERVISOR_MCP_TOOL_NAMES.map(tomlString).join(", ")}]`,
        'default_tools_approval_mode = "approve"',
      ].join("\n"),
    },
  };
};

interface PreparedStateDirectory {
  readonly stateDirectory: string;
  readonly connectionConfigPath: string;
}

interface StagedNodeChannelAcquisition {
  prepared: PreparedStateDirectory | undefined;
  ownsStateDirectory: boolean;
  internalScope: Scope.Closeable | undefined;
  handle: SupervisorChannelHandle | undefined;
}

class SupervisorPrivateStateError extends Schema.TaggedError<SupervisorPrivateStateError>()(
  "SupervisorPrivateStateError",
  {
    operation: Schema.String,
    code: Schema.String,
  },
) {}

const privateStateError = <ErrorInput>(operation: string, error: ErrorInput) =>
  new SupervisorPrivateStateError({
    operation,
    code: nodeErrorCode(error) ?? "UNKNOWN",
  });

const privateStateOperation = <Value>(
  operation: string,
  evaluate: () => PromiseLike<Value>,
): Effect.Effect<Value, SupervisorPrivateStateError> =>
  Effect.tryPromise({
    try: evaluate,
    catch: (error) => privateStateError(operation, error),
  });

const prepareStateDirectory = (
  agentDirectory: string,
  runId: string,
  onPrepared: (prepared: PreparedStateDirectory) => void,
  onCreated: () => void,
): Effect.Effect<PreparedStateDirectory, SupervisorPrivateStateError> =>
  Effect.gen(function* () {
    const canonicalAgentDirectory = yield* privateStateOperation("resolve-agent-directory", () =>
      safeAgentDirectory(agentDirectory),
    );
    const packageRoot = join(canonicalAgentDirectory, "subagents");
    const channelRoot = join(packageRoot, CHANNEL_ROOT);
    yield* privateStateOperation("prepare-package-root", () => ensurePrivateDirectory(packageRoot));
    yield* privateStateOperation("prepare-channel-root", () => ensurePrivateDirectory(channelRoot));
    const stateDirectory = join(channelRoot, `${runId}-${randomBytes(12).toString("hex")}`);
    const prepared = {
      stateDirectory,
      connectionConfigPath: join(stateDirectory, CONNECTION_CONFIG_FILE),
    } satisfies PreparedStateDirectory;
    onPrepared(prepared);
    let directoryCreated = false;
    const removeLateDirectory = () =>
      directoryCreated ? fs.rmdir(stateDirectory).catch(() => undefined) : Promise.resolve();
    return yield* Effect.tryPromise({
      try: (signal) =>
        fs.mkdir(stateDirectory, { mode: 0o700 }).then(() => {
          directoryCreated = true;
          onCreated();
          if (signal.aborted)
            return removeLateDirectory().then(() => {
              throw new Error("state-directory-acquisition-interrupted");
            });
          return fs.lstat(stateDirectory).then((stateStat) => {
            if (signal.aborted || !stateStat.isDirectory() || stateStat.isSymbolicLink())
              throw new Error("unsafe-run-dir");
            return prepared;
          });
        }),
      catch: (error) => privateStateError("prepare-state-directory", error),
    }).pipe(Effect.onError(() => Effect.promise(removeLateDirectory)));
  });

const writePrivateConfig = (path: string, value: SupervisorChannelConfig): Promise<void> => {
  const source = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(source, "utf8") > MAX_SUPERVISOR_CONFIG_BYTES)
    return Promise.reject(new Error("config-size"));
  return writeExclusive(path, source);
};

const removePrivateState = (
  stateDirectory: string,
  connectionConfigPath: string,
): Effect.Effect<void, SupervisorPrivateStateError> =>
  Effect.gen(function* () {
    const configStat = yield* privateStateOperation("stat-channel-config", () =>
      fs.lstat(connectionConfigPath),
    ).pipe(
      Effect.map(Option.some),
      Effect.catch((error) => (error.code === "ENOENT" ? Effect.succeedNone : Effect.fail(error))),
    );
    if (Option.isSome(configStat)) {
      if (!configStat.value.isFile() || configStat.value.isSymbolicLink())
        return yield* new SupervisorPrivateStateError({
          operation: "validate-channel-config",
          code: "UNSAFE_ENTRY",
        });
      yield* privateStateOperation("remove-channel-config", () => fs.unlink(connectionConfigPath));
    }
    const entries = yield* privateStateOperation("read-channel-state", () =>
      fs.readdir(stateDirectory),
    );
    if (entries.length !== 0)
      return yield* new SupervisorPrivateStateError({
        operation: "validate-channel-state",
        code: "UNEXPECTED_ENTRIES",
      });
    yield* privateStateOperation("remove-channel-state", () => fs.rmdir(stateDirectory));
  });

const acquireNodeChannelEffect = (
  options: SupervisorChannelLayerOptions,
  runId: SupervisorRunId,
  events: Queue.Queue<SupervisorEvent, Cause.Done>,
  allowPiProxy: boolean,
): Effect.Effect<SupervisorChannelHandle, SupervisorChannelError> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const acquisition: StagedNodeChannelAcquisition = {
        prepared: undefined,
        ownsStateDirectory: false,
        internalScope: undefined,
        handle: undefined,
      };

      const cleanupPartial = Effect.gen(function* () {
        if (acquisition.handle)
          return yield* acquisition.handle.close.pipe(Effect.catchCause(() => Effect.void));
        if (acquisition.internalScope)
          yield* Scope.close(acquisition.internalScope, Exit.void).pipe(
            Effect.catchCause(() => Effect.void),
          );
        if (acquisition.ownsStateDirectory && acquisition.prepared)
          yield* removePrivateState(
            acquisition.prepared.stateDirectory,
            acquisition.prepared.connectionConfigPath,
          ).pipe(Effect.ignore);
      });

      return yield* Effect.gen(function* () {
        const prepared = yield* restore(
          prepareStateDirectory(
            options.agentDirectory,
            runId,
            (candidate) => {
              acquisition.prepared = candidate;
            },
            () => {
              acquisition.ownsStateDirectory = true;
            },
          ).pipe(
            Effect.mapError(() =>
              channelError(
                "open channel",
                "channel_open_failed",
                "Unable to prepare private supervisor state.",
              ),
            ),
          ),
        );
        const internalScope = yield* Scope.make();
        acquisition.internalScope = internalScope;
        const baseServer = yield* restore(
          NodeSocketServer.make({ host: LOOPBACK_HOST, port: 0, exclusive: true }).pipe(
            Scope.provide(internalScope),
            Effect.mapError(() =>
              channelError("listen", "listen_failed", "The supervisor listener failed to start."),
            ),
          ),
        );
        if (baseServer.address._tag !== "TcpAddress")
          return yield* channelError(
            "listen",
            "invalid_listener_address",
            "The supervisor listener address is invalid.",
          );
        const metadata = makeMetadata(
          baseServer.address.port,
          prepared.stateDirectory,
          prepared.connectionConfigPath,
        );
        const token = Redacted.make(
          SupervisorAuthTokenSchema.make(randomBytes(32).toString("hex")),
        );
        const session = yield* makeSupervisorChannelSession({ runId, token, events, allowPiProxy });
        // Cache the whole release so interruption cannot separate session shutdown from resources.
        const close = yield* Effect.cached(
          Effect.uninterruptible(
            Effect.gen(function* () {
              yield* session.shutdown;
              yield* Scope.close(internalScope, Exit.void);
              yield* removePrivateState(
                prepared.stateDirectory,
                prepared.connectionConfigPath,
              ).pipe(
                Effect.mapError(() =>
                  channelError(
                    "cleanup",
                    "cleanup_failed",
                    "Supervisor private state cleanup could not be confirmed.",
                  ),
                ),
              );
            }),
          ),
        );
        const handle: SupervisorChannelHandle = { metadata, events, ...session.controls, close };
        acquisition.handle = handle;
        const serialization = RpcSerialization.makeNdjson({
          maxBufferSize: MAX_SUPERVISOR_CHANNEL_LINE_BYTES,
        });
        const protocol = yield* makeSupervisorRpcServerProtocol({
          server: baseServer,
          authTimeoutMillis: options.authTimeoutMillis ?? AUTH_TIMEOUT_MILLIS,
          maxConnections: MAX_CONNECTIONS,
          openSessionTag: SupervisorOpenSessionRpc._tag,
          onDisconnect: session.disconnect,
        }).pipe(
          Effect.provideService(RpcSerialization.RpcSerialization, serialization),
          Scope.provide(internalScope),
        );
        const handlers = yield* session.handlers;
        yield* RpcServer.make(SupervisorRpcGroup, {
          concurrency: MAX_ACTIVE_RPC_REQUESTS,
          disableTracing: true,
        }).pipe(
          Effect.provide(handlers),
          Effect.provideService(RpcServer.Protocol, protocol),
          Effect.forkScoped,
          Scope.provide(internalScope),
        );
        const config = SupervisorChannelConfigSchema.make({
          version: SUPERVISOR_CHANNEL_VERSION,
          runId,
          host: LOOPBACK_HOST,
          port: metadata.port,
          token: Redacted.value(token),
        });
        const beforeConfigCommit = options.beforeConfigCommit;
        if (beforeConfigCommit)
          yield* Effect.tryPromise({
            try: () => beforeConfigCommit(metadata),
            catch: configWriteError,
          });
        yield* Effect.tryPromise({
          try: () => writePrivateConfig(prepared.connectionConfigPath, config),
          catch: configWriteError,
        });
        // Deliver interruption only after the config writer has settled, while acquisition still
        // owns failure cleanup for the listener, token document, and private state directory.
        yield* restore(Effect.void);
        const beforeAcquireComplete = options.beforeAcquireComplete;
        if (beforeAcquireComplete)
          yield* restore(
            Effect.tryPromise({
              try: () => beforeAcquireComplete(metadata),
              catch: () =>
                channelError(
                  "open channel",
                  "channel_open_failed",
                  "Unable to complete supervisor channel acquisition.",
                ),
            }),
          );
        return handle;
      }).pipe(Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : cleanupPartial)));
    }),
  );

export const makeSupervisorChannel = (
  options: SupervisorChannelLayerOptions,
): SupervisorChannelContract => ({
  open: (request) =>
    Effect.gen(function* () {
      if (!isSupervisorRunId(request.runId))
        return yield* channelError(
          "open channel",
          "invalid_run_id",
          "Supervisor channel run identity is invalid.",
        );
      const runId: SupervisorRunId = request.runId;
      const events = yield* Queue.dropping<SupervisorEvent, Cause.Done>(EVENT_CAPACITY);
      return yield* Effect.acquireRelease(
        acquireNodeChannelEffect(options, runId, events, request.allowPiProxy === true),
        (acquired) => acquired.close.pipe(Effect.orDie),
        { interruptible: true },
      );
    }),
});

export class SupervisorChannel extends Context.Service<
  SupervisorChannel,
  SupervisorChannelContract
>()("pi-subagents/boundary/supervisor-channel/SupervisorChannel") {
  static readonly layer = (
    options: SupervisorChannelLayerOptions,
  ): Layer.Layer<SupervisorChannel> => Layer.succeed(this, makeSupervisorChannel(options));
}
