import * as NodeSocketServer from "@effect/platform-node/NodeSocketServer";
import {
  boundedNdjsonRpcSerialization,
  createPrivateFile,
  ensurePrivateDirectory,
  makeTokenVerifier,
  nodeFsPromises as fs,
  nodePath,
  PrivateFileError,
  synchronousRandomHex,
} from "pi-cosmic-core";
import { fileURLToPath } from "node:url";
import type * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as RpcServer from "effect/rpc/RpcServer";
import * as Predicate from "effect/Predicate";
import type { BackendAgentMessaging } from "../backend/model.ts";
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
  SupervisorRpcGroup,
} from "../supervisor/protocol.ts";
import {
  SUPERVISOR_MCP_REGISTRATION,
  SUPERVISOR_MCP_TOOL_NAMES,
} from "../supervisor/mcp-contract.ts";
import { nodeErrorCode, safeAgentDirectory, tomlString } from "./harness-shared.ts";
import {
  recordPrivateStateOwner,
  removePrivateStateOwner,
  SUBAGENT_STATE_ROOT,
  SUPERVISOR_CHANNEL_ROOT,
} from "./private-state.ts";
import { supervisorRpcServerProtocol } from "./supervisor-rpc-protocol.ts";
import { channelError, type SupervisorChannelError } from "./supervisor-channel-errors.ts";
import {
  supervisorChannelSession,
  type SupervisorChannelControls,
} from "./supervisor-channel-session.ts";

const LOOPBACK_HOST = "127.0.0.1" as const;
const CONNECTION_CONFIG_FILE = "connection.json";
const EVENT_CAPACITY = 64;
const MAX_ACTIVE_RPC_REQUESTS = 32;
const AUTH_TIMEOUT_MILLIS = 5_000;

interface ClaudeSupervisorMcpMetadata {
  readonly mcpServers: {
    readonly [SUPERVISOR_MCP_REGISTRATION]: {
      readonly type: "stdio";
      readonly command: string;
      readonly args: ReadonlyArray<string>;
      readonly env: Readonly<Record<string, never>>;
    };
  };
}

interface CodexSupervisorMcpMetadata {
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
}

export interface SupervisorChannelContract {
  readonly open: (
    request: SupervisorChannelOpenRequest,
  ) => Effect.Effect<SupervisorChannelHandle, SupervisorChannelError, Scope.Scope>;
}

interface SupervisorChannelOpenRequest {
  readonly runId: string;
  /** The run's own `agent_*` operations; without them the agent tools are unavailable. */
  readonly agents?: BackendAgentMessaging | undefined;
}

export interface SupervisorChannelLayerOptions {
  readonly agentDirectory: string;
  readonly beforeAcquireComplete?:
    | ((metadata: SupervisorConnectionMetadata) => Promise<void>)
    | undefined;
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
  ownedState: PreparedStateDirectory | undefined;
  internalScope: Scope.Closeable | undefined;
  close: Effect.Effect<void, SupervisorChannelError> | undefined;
}

class SupervisorPrivateStateError extends Schema.TaggedError<
  SupervisorPrivateStateError,
  { readonly brand: unique symbol }
>()("SupervisorPrivateStateError", {
  operation: Schema.String,
  code: Schema.String,
}) {}

const privateStateError = (operation: string, cause: unknown) =>
  new SupervisorPrivateStateError({
    operation,
    code: nodeErrorCode(cause) ?? "UNKNOWN",
  });

const privateStateOperation = <Value>(
  operation: string,
  evaluate: (signal: AbortSignal) => PromiseLike<Value>,
): Effect.Effect<Value, SupervisorPrivateStateError> =>
  Effect.tryPromise({
    try: evaluate,
    catch: (error) => privateStateError(operation, error),
  });

const privateStateStep = <Value>(
  operation: string,
  effect: Effect.Effect<Value, PrivateFileError>,
): Effect.Effect<Value, SupervisorPrivateStateError> =>
  effect.pipe(
    Effect.mapError((error) => new SupervisorPrivateStateError({ operation, code: error.reason })),
  );

const prepareStateDirectory = Effect.fn("SupervisorChannel.prepareStateDirectory")(function* (
  agentDirectory: string,
  runId: string,
  onCreated: (prepared: PreparedStateDirectory) => void,
): Effect.fn.Return<PreparedStateDirectory, SupervisorPrivateStateError> {
  const canonicalAgentDirectory = yield* privateStateStep(
    "resolve-agent-directory",
    safeAgentDirectory(agentDirectory),
  );
  const packageRoot = nodePath.join(canonicalAgentDirectory, SUBAGENT_STATE_ROOT);
  const channelRoot = nodePath.join(packageRoot, SUPERVISOR_CHANNEL_ROOT);
  yield* privateStateStep("prepare-package-root", ensurePrivateDirectory(packageRoot));
  yield* privateStateStep("prepare-channel-root", ensurePrivateDirectory(channelRoot));
  const stateDirectory = nodePath.join(channelRoot, `${runId}-${synchronousRandomHex(12)}`);
  const prepared = {
    stateDirectory,
    connectionConfigPath: nodePath.join(stateDirectory, CONNECTION_CONFIG_FILE),
  } satisfies PreparedStateDirectory;
  // The mkdir stays interruptible, so a stalled filesystem can't hold cancellation. A directory
  // created after its caller left reaches no cleanup, so the late settlement removes it here.
  yield* privateStateOperation("prepare-state-directory", (signal) =>
    fs
      .mkdir(stateDirectory, { mode: 0o700 })
      .then(() =>
        signal.aborted ? fs.rmdir(stateDirectory).catch(() => undefined) : onCreated(prepared),
      ),
  );
  const stateStat = yield* privateStateOperation("prepare-state-directory", () =>
    fs.lstat(stateDirectory),
  );
  if (!stateStat.isDirectory() || stateStat.isSymbolicLink())
    return yield* new SupervisorPrivateStateError({
      operation: "prepare-state-directory",
      code: "UNSAFE_ENTRY",
    });
  yield* privateStateStep("prepare-state-directory", recordPrivateStateOwner(stateDirectory));
  return prepared;
});

const writePrivateConfig = (
  path: string,
  value: SupervisorChannelConfig,
): Effect.Effect<void, PrivateFileError> => {
  const source = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(source, "utf8") > MAX_SUPERVISOR_CONFIG_BYTES)
    return Effect.fail(new PrivateFileError({ reason: "unsafe" }));
  return createPrivateFile(path, source);
};

const removePrivateState = Effect.fn("SupervisorChannel.removePrivateState")(function* ({
  stateDirectory,
  connectionConfigPath,
}: PreparedStateDirectory): Effect.fn.Return<void, SupervisorPrivateStateError> {
  const configStat = yield* privateStateOperation("stat-channel-config", () =>
    fs.lstat(connectionConfigPath),
  ).pipe(
    Effect.asSome,
    Effect.catchIf(
      (error) => error.code === "ENOENT",
      () => Effect.succeedNone,
    ),
  );
  if (Option.isSome(configStat)) {
    if (!configStat.value.isFile() || configStat.value.isSymbolicLink())
      return yield* new SupervisorPrivateStateError({
        operation: "validate-channel-config",
        code: "UNSAFE_ENTRY",
      });
    yield* privateStateOperation("remove-channel-config", () => fs.unlink(connectionConfigPath));
  }
  yield* privateStateStep("remove-channel-owner", removePrivateStateOwner(stateDirectory));
  const entries = yield* privateStateOperation("read-channel-state", () =>
    fs.readdir(stateDirectory),
  );
  if (entries.length !== 0)
    return yield* new SupervisorPrivateStateError({
      operation: "validate-channel-state",
      code: "UNEXPECTED_ENTRIES",
    });
  yield* privateStateOperation("remove-channel-state", () => fs.rmdir(stateDirectory));
  return undefined;
});

const cryptoUnavailable = () =>
  channelError(
    "authenticate",
    "crypto_unavailable",
    "Supervisor authentication could not be prepared.",
  );

const acquireNodeChannelEffect = (
  options: SupervisorChannelLayerOptions,
  runId: SupervisorRunId,
  events: Queue.Queue<SupervisorEvent, Cause.Done>,
  agents: BackendAgentMessaging | undefined,
): Effect.Effect<
  {
    readonly handle: SupervisorChannelHandle;
    readonly close: Effect.Effect<void, SupervisorChannelError>;
  },
  SupervisorChannelError
> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const acquisition: StagedNodeChannelAcquisition = {
        ownedState: undefined,
        internalScope: undefined,
        close: undefined,
      };

      const cleanupPartial = Effect.gen(function* () {
        if (acquisition.close) return yield* acquisition.close.pipe(Effect.ignoreCause);
        if (acquisition.internalScope)
          yield* Scope.close(acquisition.internalScope, Exit.void).pipe(Effect.ignoreCause);
        if (acquisition.ownedState)
          yield* removePrivateState(acquisition.ownedState).pipe(Effect.ignore);
        return undefined;
      });

      return yield* Effect.gen(function* () {
        const token = yield* Effect.try({
          try: () => Redacted.make(SupervisorAuthTokenSchema.make(synchronousRandomHex(32))),
          catch: cryptoUnavailable,
        });
        const verifyToken = yield* restore(
          makeTokenVerifier(Redacted.value(token)).pipe(Effect.mapError(cryptoUnavailable)),
        );
        const prepared = yield* restore(
          prepareStateDirectory(options.agentDirectory, runId, (created) => {
            acquisition.ownedState = created;
          }).pipe(
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
        if (!Predicate.isTagged(baseServer.address, "InetAddressV4"))
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
        const session = yield* supervisorChannelSession({
          runId,
          verifyToken,
          events,
          agents,
        });
        const close = Effect.gen(function* () {
          yield* session.shutdown;
          yield* Scope.close(internalScope, Exit.void);
          yield* removePrivateState(prepared).pipe(
            Effect.mapError(() =>
              channelError(
                "cleanup",
                "cleanup_failed",
                "Supervisor private state cleanup could not be confirmed.",
              ),
            ),
          );
        });
        acquisition.close = close;
        const handle: SupervisorChannelHandle = { metadata, events, ...session.controls };
        const serialization = boundedNdjsonRpcSerialization(MAX_SUPERVISOR_CHANNEL_LINE_BYTES);
        const protocol = yield* supervisorRpcServerProtocol({
          server: baseServer,
          authTimeoutMillis: options.authTimeoutMillis ?? AUTH_TIMEOUT_MILLIS,
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
        yield* writePrivateConfig(prepared.connectionConfigPath, config).pipe(
          Effect.mapError(configWriteError),
        );
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
        return { handle, close };
      }).pipe(Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : cleanupPartial)));
    }),
  );

const makeSupervisorChannel = (
  options: SupervisorChannelLayerOptions,
): SupervisorChannelContract => ({
  open: Effect.fn("SupervisorChannel.open")(function* (request: SupervisorChannelOpenRequest) {
    if (!isSupervisorRunId(request.runId))
      return yield* channelError(
        "open channel",
        "invalid_run_id",
        "Supervisor channel run identity is invalid.",
      );
    const runId: SupervisorRunId = request.runId;
    const events = yield* Queue.dropping<SupervisorEvent, Cause.Done>(EVENT_CAPACITY);
    const { handle } = yield* Effect.acquireRelease(
      acquireNodeChannelEffect(options, runId, events, request.agents),
      ({ close }) => close.pipe(Effect.orDie),
      { interruptible: true },
    );
    return handle;
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
