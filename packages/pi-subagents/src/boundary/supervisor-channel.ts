// Private loopback supervisor RPC transport and agent-directory state live at this boundary.
import * as NodeSocketServer from "@effect/platform-node/NodeSocketServer";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { nodeFsPromises as fs, nodePath } from "./node-builtins.ts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Latch from "effect/Latch";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";
import { MAX_BACKEND_REPORT_EVIDENCE_CHARS, type BackendReport } from "../backend/model.ts";
import {
  isSupervisorRunId,
  MAX_SUPERVISOR_CHANNEL_LINE_BYTES,
  MAX_SUPERVISOR_CONFIG_BYTES,
  SUPERVISOR_CHANNEL_VERSION,
  SupervisorAuthTokenSchema,
  SupervisorChannelConfigSchema,
  SupervisorChannelIdSchema,
  type SupervisorAuthToken,
  type SupervisorChannelId,
  type SupervisorChannelConfig,
  type SupervisorDeliveryId,
  type SupervisorEvent,
  type SupervisorRunId,
  SupervisorOpenSessionRpc,
  SupervisorRpcFailure,
  SupervisorRpcGroup,
  validSupervisorReply,
} from "../supervisor/protocol.ts";
import {
  isSupervisorMcpMessage,
  isSupervisorMcpReport,
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
import {
  makeSupervisorRpcServerProtocol,
  SupervisorRpcConnection,
  type SupervisorRpcConnectionContract,
} from "./supervisor-rpc-protocol.ts";

const { join } = nodePath;

const LOOPBACK_HOST = "127.0.0.1" as const;
const CHANNEL_ROOT = "supervisor-channels-v2";
const CONNECTION_CONFIG_FILE = "connection.json";
const EVENT_CAPACITY = 64;
const CONTACT_EVENT_CAPACITY = EVENT_CAPACITY - 1;
const MAX_CONNECTIONS = 4;
const MAX_ACTIVE_RPC_REQUESTS = 32;
const MAX_TRACKED_ASSIGNMENTS = 256;
const MAX_REPORT_DELIVERIES = 128;
const AUTH_TIMEOUT_MILLIS = 5_000;
const REPLY_TIMEOUT = "10 seconds";

export class SupervisorChannelError extends Schema.TaggedError<SupervisorChannelError>()(
  "SupervisorChannelError",
  {
    operation: Schema.String,
    code: Schema.String,
    message: Schema.String,
  },
) {}

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
  readonly serverName: typeof SUPERVISOR_MCP_REGISTRATION;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly enabledTools: ReadonlyArray<string>;
  readonly tomlFragment: string;
}

export interface SupervisorConnectionMetadata {
  readonly runId: string;
  readonly host: typeof LOOPBACK_HOST;
  readonly port: number;
  readonly stateDirectory: string;
  readonly connectionConfigPath: string;
  readonly helperPath: string;
  readonly claudeMcp: ClaudeSupervisorMcpMetadata;
  readonly codexMcp: CodexSupervisorMcpMetadata;
}

export interface SupervisorChannelHandle {
  readonly runId: string;
  readonly metadata: SupervisorConnectionMetadata;
  readonly events: Queue.Dequeue<SupervisorEvent, Cause.Done>;
  readonly awaitReady: Effect.Effect<void, SupervisorChannelError>;
  readonly setAssignmentEpoch: (epoch: number) => Effect.Effect<void, SupervisorChannelError>;
  readonly hasAcceptedReport: (epoch: number) => Effect.Effect<boolean, SupervisorChannelError>;
  readonly acceptedReportForEpoch: (
    epoch: number,
  ) => Effect.Effect<BackendReport | undefined, SupervisorChannelError>;
  readonly reply: (
    requestId: string,
    message: string,
  ) => Effect.Effect<void, SupervisorChannelError>;
  readonly cancelPending: (reason?: string) => void;
  readonly close: Effect.Effect<void, SupervisorChannelError>;
}

export interface SupervisorChannelContract {
  readonly open: (
    request: SupervisorChannelOpenRequest,
  ) => Effect.Effect<SupervisorChannelHandle, SupervisorChannelError, Scope.Scope>;
}

export interface SupervisorChannelOpenRequest {
  readonly runId: string;
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

interface AssignmentUpdate {
  readonly updateId: SupervisorChannelId;
  readonly assignmentEpoch: number;
}

interface RpcPeer {
  readonly clientId: number;
  readonly guard: SupervisorRpcConnectionContract;
  readonly assignments: Queue.Queue<AssignmentUpdate, Cause.Done>;
  watching: boolean;
}

interface PendingQuestion {
  readonly requestId: SupervisorChannelId;
  readonly epoch: number;
  readonly peerId: number;
  readonly response: Deferred.Deferred<
    { readonly questionId: SupervisorChannelId; readonly message: string },
    SupervisorRpcFailure
  >;
  readonly acknowledgement: Deferred.Deferred<void, SupervisorChannelError>;
  replyStarted: boolean;
}

interface AcceptedReport {
  readonly epoch: number;
  readonly sequence: number;
  readonly text: string;
  readonly report: BackendReport;
}

interface PendingEpochAcknowledgement {
  readonly epoch: number;
  readonly peerId: number;
  readonly firstAcknowledgement: Deferred.Deferred<void, SupervisorChannelError>;
}

interface NodeChannelState {
  readonly runId: SupervisorRunId;
  readonly scope: Scope.Closeable;
  readonly peers: Map<number, RpcPeer>;
  readonly events: Queue.Queue<SupervisorEvent, Cause.Done>;
  readonly metadata: SupervisorConnectionMetadata;
  readonly stateDirectory: string;
  readonly connectionConfigPath: string;
  readonly token: Redacted.Redacted<SupervisorAuthToken>;
  readonly assignmentEpochs: Set<number>;
  readonly questionEpochs: Set<number>;
  readonly reports: Map<SupervisorDeliveryId, AcceptedReport>;
  readonly epochAcknowledgements: Map<SupervisorChannelId, PendingEpochAcknowledgement>;
  readonly readiness: Latch.Latch;
  pendingAssignmentEpoch: number | undefined;
  currentAssignmentEpoch: number;
  nextReportSequence: number;
  pendingQuestion: PendingQuestion | undefined;
  cleanupStarted: boolean;
  readonly cleanupDone: Deferred.Deferred<void, SupervisorChannelError>;
  closed: boolean;
}

const channelError = (operation: string, code: string, message: string) =>
  new SupervisorChannelError({ operation, code, message });
const configWriteError = () =>
  channelError(
    "write channel config",
    "config_write_failed",
    "Unable to publish private supervisor configuration.",
  );

const rpcFailure = (code: string, message: string) => new SupervisorRpcFailure({ code, message });

const authenticatedToken = <ValueInput>(
  expected: Redacted.Redacted<SupervisorAuthToken>,
  value: ValueInput,
): boolean => {
  const expectedBytes = Buffer.from(Redacted.value(expected), "utf8");
  const supplied = Predicate.isString(value) ? Buffer.from(value, "utf8") : Buffer.alloc(0);
  if (supplied.length !== expectedBytes.length) {
    timingSafeEqual(expectedBytes, expectedBytes);
    return false;
  }
  return timingSafeEqual(expectedBytes, supplied);
};

const makeMetadata = (
  runId: SupervisorRunId,
  port: number,
  stateDirectory: string,
  connectionConfigPath: string,
): SupervisorConnectionMetadata => {
  const helperPath = fileURLToPath(new URL("./supervisor-mcp-helper.mjs", import.meta.url));
  const command = process.execPath;
  const args = [helperPath, "--config", connectionConfigPath] as const;
  const enabledTools = SUPERVISOR_MCP_TOOL_NAMES;
  return {
    runId,
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
      serverName: SUPERVISOR_MCP_REGISTRATION,
      command,
      args,
      enabledTools,
      tomlFragment: [
        `[mcp_servers.${SUPERVISOR_MCP_REGISTRATION}]`,
        `command = ${tomlString(command)}`,
        `args = [${args.map(tomlString).join(", ")}]`,
        "required = true",
        `enabled_tools = [${enabledTools.map(tomlString).join(", ")}]`,
        'default_tools_approval_mode = "approve"',
      ].join("\n"),
    },
  };
};

interface PreparedStateDirectory {
  readonly stateDirectory: string;
  readonly connectionConfigPath: string;
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

const hasReadyPeer = (state: NodeChannelState): boolean =>
  [...state.peers.values()].some((peer) => peer.watching);

const synchronizeReadiness = (state: NodeChannelState): void => {
  if (hasReadyPeer(state)) Latch.openUnsafe(state.readiness);
  else Latch.closeUnsafe(state.readiness);
};

const failPendingQuestion = (
  state: NodeChannelState,
  code: string,
  message: string,
  publishCancellation: boolean,
): void => {
  const pending = state.pendingQuestion;
  if (!pending) return;
  if (
    publishCancellation &&
    !Queue.offerUnsafe(state.events, {
      type: "supervisor_question_cancelled",
      assignmentEpoch: pending.epoch,
      requestId: pending.requestId,
    })
  )
    return;
  state.pendingQuestion = undefined;
  Deferred.doneUnsafe(pending.response, Effect.fail(rpcFailure(code, message)));
  Deferred.doneUnsafe(pending.acknowledgement, Effect.fail(channelError("reply", code, message)));
};

const cancelPendingQuestion = (state: NodeChannelState, code: string, message: string): boolean => {
  if (!state.pendingQuestion) return false;
  failPendingQuestion(state, code, message, true);
  return state.pendingQuestion === undefined;
};

const removePeer = (state: NodeChannelState, clientId: number): void => {
  const peer = state.peers.get(clientId);
  if (!peer) return;
  state.peers.delete(clientId);
  synchronizeReadiness(state);
  Queue.endUnsafe(peer.assignments);
  const affected = new Set<Deferred.Deferred<void, SupervisorChannelError>>();
  for (const [id, acknowledgement] of state.epochAcknowledgements) {
    if (acknowledgement.peerId !== clientId) continue;
    state.epochAcknowledgements.delete(id);
    affected.add(acknowledgement.firstAcknowledgement);
  }
  for (const firstAcknowledgement of affected) {
    const hasLive = [...state.epochAcknowledgements.values()].some(
      (entry) => entry.firstAcknowledgement === firstAcknowledgement,
    );
    if (!hasLive)
      Deferred.doneUnsafe(
        firstAcknowledgement,
        Effect.fail(
          channelError(
            "set assignment epoch",
            "assignment_epoch_outcome_uncertain",
            "Every assignment epoch acknowledgement transport closed.",
          ),
        ),
      );
  }
  if (state.pendingQuestion?.peerId === clientId)
    cancelPendingQuestion(
      state,
      "question_transport_closed",
      "The supervisor question transport closed before settlement was confirmed.",
    );
};

const authorize = (
  state: NodeChannelState,
  guard: SupervisorRpcConnectionContract,
  clientId: number,
  payload: { readonly version: number; readonly runId: string; readonly token: string },
): Effect.Effect<void, SupervisorRpcFailure> =>
  Effect.suspend(() => {
    if (
      state.closed ||
      payload.version !== SUPERVISOR_CHANNEL_VERSION ||
      payload.runId !== state.runId ||
      !authenticatedToken(state.token, payload.token) ||
      guard.clientId !== clientId
    ) {
      guard.close();
      return Effect.fail(rpcFailure("authentication_failed", "Supervisor authentication failed."));
    }
    if (!guard.accepted) {
      guard.accepted = true;
      Deferred.doneUnsafe(guard.authenticated, Effect.void);
    }
    return Effect.void;
  });

const currentConnectionGuard = Effect.serviceOption(SupervisorRpcConnection).pipe(
  Effect.flatMap((guard) =>
    Option.isSome(guard)
      ? Effect.succeed(guard.value)
      : Effect.fail(
          rpcFailure("connection_context_missing", "Supervisor connection context is missing."),
        ),
  ),
);

const requirePeer = (
  state: NodeChannelState,
  clientId: number,
): Effect.Effect<RpcPeer, SupervisorRpcFailure> => {
  const peer = state.peers.get(clientId);
  return peer
    ? Effect.succeed(peer)
    : Effect.fail(rpcFailure("session_not_open", "The supervisor RPC session is not open."));
};

const requireAssignedEpoch = (
  state: NodeChannelState,
  epoch: number,
): Effect.Effect<void, SupervisorRpcFailure> =>
  state.assignmentEpochs.has(epoch)
    ? Effect.void
    : Effect.fail(
        rpcFailure(
          "unknown_assignment_epoch",
          "Supervisor event did not name an assignment epoch issued by this channel.",
        ),
      );

const offerContact = (
  state: NodeChannelState,
  requestId: SupervisorChannelId,
  epoch: number,
  kind: "progress" | "warning",
  message: string,
): Effect.Effect<string, SupervisorRpcFailure> =>
  Effect.suspend(() => {
    if (!isSupervisorMcpMessage(message))
      return Effect.fail(rpcFailure("invalid_message", "Supervisor message is invalid."));
    const offered =
      Queue.sizeUnsafe(state.events) < CONTACT_EVENT_CAPACITY &&
      Queue.offerUnsafe(state.events, {
        type: "supervisor_contact",
        assignmentEpoch: epoch,
        requestId,
        kind,
        message,
      });
    return offered
      ? Effect.succeed(
          kind === "progress"
            ? "Progress delivered to the parent projection."
            : "Warning recorded in parent-visible run status.",
        )
      : Effect.fail(rpcFailure("event_queue_full", "Supervisor event queue is full."));
  });

const makeRpcHandlers = (state: NodeChannelState) =>
  SupervisorRpcGroup.toHandlers(
    SupervisorRpcGroup.of({
      SupervisorOpenSession: (payload, options) =>
        Effect.gen(function* () {
          const guard = yield* currentConnectionGuard;
          yield* authorize(state, guard, options.client.id, payload);
          if (!state.peers.has(options.client.id)) {
            const assignments = yield* Queue.bounded<AssignmentUpdate, Cause.Done>(4);
            state.peers.set(options.client.id, {
              clientId: options.client.id,
              guard,
              assignments,
              watching: false,
            });
          }
          return { assignmentEpoch: state.currentAssignmentEpoch };
        }),

      SupervisorWatchAssignments: (payload, options) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const guard = yield* currentConnectionGuard;
            yield* authorize(state, guard, options.client.id, payload);
            const peer = yield* requirePeer(state, options.client.id);
            if (peer.watching)
              return yield* rpcFailure(
                "assignment_watch_active",
                "This supervisor session already has an assignment stream.",
              );
            peer.watching = true;
            synchronizeReadiness(state);
            return Stream.fromQueue(peer.assignments).pipe(
              Stream.ensuring(
                Effect.sync(() => {
                  peer.watching = false;
                  synchronizeReadiness(state);
                }),
              ),
            );
          }),
        ),

      SupervisorAcknowledgeAssignment: (payload, options) =>
        Effect.gen(function* () {
          const guard = yield* currentConnectionGuard;
          yield* authorize(state, guard, options.client.id, payload);
          yield* requirePeer(state, options.client.id);
          const acknowledgement = state.epochAcknowledgements.get(payload.updateId);
          if (
            !acknowledgement ||
            acknowledgement.peerId !== options.client.id ||
            acknowledgement.epoch !== payload.assignmentEpoch
          )
            return yield* rpcFailure(
              "assignment_epoch_ack_mismatch",
              "Assignment epoch acknowledgement did not match an issued update.",
            );
          state.epochAcknowledgements.delete(payload.updateId);
          if (state.pendingAssignmentEpoch === acknowledgement.epoch) {
            if (state.pendingQuestion && state.pendingQuestion.epoch < acknowledgement.epoch)
              cancelPendingQuestion(
                state,
                "question_assignment_advanced",
                "The pending supervisor question belonged to a prior assignment.",
              );
            state.currentAssignmentEpoch = acknowledgement.epoch;
            state.assignmentEpochs.add(acknowledgement.epoch);
          }
          Deferred.doneUnsafe(acknowledgement.firstAcknowledgement, Effect.void);
        }),

      SupervisorProgress: (payload, options) =>
        Effect.gen(function* () {
          const guard = yield* currentConnectionGuard;
          yield* authorize(state, guard, options.client.id, payload);
          yield* requirePeer(state, options.client.id);
          yield* requireAssignedEpoch(state, payload.assignmentEpoch);
          return yield* offerContact(
            state,
            payload.requestId,
            payload.assignmentEpoch,
            "progress",
            payload.message,
          );
        }),

      SupervisorWarning: (payload, options) =>
        Effect.gen(function* () {
          const guard = yield* currentConnectionGuard;
          yield* authorize(state, guard, options.client.id, payload);
          yield* requirePeer(state, options.client.id);
          yield* requireAssignedEpoch(state, payload.assignmentEpoch);
          return yield* offerContact(
            state,
            payload.requestId,
            payload.assignmentEpoch,
            "warning",
            payload.message,
          );
        }),

      SupervisorQuestion: (payload, options) =>
        Effect.gen(function* () {
          const guard = yield* currentConnectionGuard;
          yield* authorize(state, guard, options.client.id, payload);
          yield* requirePeer(state, options.client.id);
          yield* requireAssignedEpoch(state, payload.assignmentEpoch);
          if (!isSupervisorMcpMessage(payload.message))
            return yield* rpcFailure("invalid_question", "Supervisor question is invalid.");
          if (state.pendingQuestion)
            return yield* rpcFailure(
              "question_pending",
              "A blocking supervisor question is already pending.",
            );
          if (state.questionEpochs.has(payload.assignmentEpoch))
            return yield* rpcFailure(
              "question_already_used",
              "This assignment already used its blocking supervisor question.",
            );
          const response = Deferred.makeUnsafe<
            { readonly questionId: SupervisorChannelId; readonly message: string },
            SupervisorRpcFailure
          >();
          const acknowledgement = Deferred.makeUnsafe<void, SupervisorChannelError>();
          const pending: PendingQuestion = {
            requestId: payload.requestId,
            epoch: payload.assignmentEpoch,
            peerId: options.client.id,
            response,
            acknowledgement,
            replyStarted: false,
          };
          state.pendingQuestion = pending;
          const offered =
            Queue.sizeUnsafe(state.events) < CONTACT_EVENT_CAPACITY &&
            Queue.offerUnsafe(state.events, {
              type: "supervisor_contact",
              assignmentEpoch: payload.assignmentEpoch,
              requestId: payload.requestId,
              kind: "question",
              message: payload.message,
            });
          if (!offered) {
            state.pendingQuestion = undefined;
            return yield* rpcFailure("event_queue_full", "Supervisor event queue is full.");
          }
          state.questionEpochs.add(payload.assignmentEpoch);
          return yield* Deferred.await(response).pipe(
            Effect.onExit((exit) =>
              Effect.sync(() => {
                if (
                  Exit.isFailure(exit) &&
                  state.pendingQuestion === pending &&
                  !pending.replyStarted
                )
                  cancelPendingQuestion(
                    state,
                    "question_cancelled",
                    "The supervisor question call was cancelled.",
                  );
              }),
            ),
          );
        }),

      SupervisorAcknowledgeQuestionReply: (payload, options) =>
        Effect.gen(function* () {
          const guard = yield* currentConnectionGuard;
          yield* authorize(state, guard, options.client.id, payload);
          const pending = state.pendingQuestion;
          if (
            !pending ||
            pending.peerId !== options.client.id ||
            pending.requestId !== payload.questionId ||
            pending.epoch !== payload.assignmentEpoch ||
            !pending.replyStarted
          )
            return yield* rpcFailure(
              "reply_ack_mismatch",
              "Question reply acknowledgement did not match the pending reply.",
            );
          state.pendingQuestion = undefined;
          Deferred.doneUnsafe(pending.acknowledgement, Effect.void);
        }),

      SupervisorReport: (payload, options) =>
        Effect.gen(function* () {
          const guard = yield* currentConnectionGuard;
          yield* authorize(state, guard, options.client.id, payload);
          yield* requirePeer(state, options.client.id);
          yield* requireAssignedEpoch(state, payload.assignmentEpoch);
          if (!isSupervisorMcpReport(payload.text))
            return yield* rpcFailure("invalid_report", "Supervisor report is invalid.");
          const previous = state.reports.get(payload.deliveryId);
          if (previous) {
            if (previous.epoch !== payload.assignmentEpoch || previous.text !== payload.text)
              return yield* rpcFailure(
                "delivery_identity_conflict",
                "The report delivery identity was already used for different evidence.",
              );
            return {
              duplicate: true,
              sequence: previous.sequence,
              assignmentEpoch: previous.epoch,
            };
          }
          if (state.reports.size >= MAX_REPORT_DELIVERIES)
            return yield* rpcFailure(
              "report_identity_capacity",
              "The report delivery identity map is full.",
            );
          const sequence = state.nextReportSequence;
          const report: BackendReport & { readonly type: "report" } = {
            type: "report",
            runId: state.metadata.runId,
            assignmentEpoch: payload.assignmentEpoch,
            sequence,
            deliveryId: payload.deliveryId,
            text: payload.text,
            evidence: `supervisor-effect-rpc-v${SUPERVISOR_CHANNEL_VERSION}`.slice(
              0,
              MAX_BACKEND_REPORT_EVIDENCE_CHARS,
            ),
          };
          const cancelsQuestion =
            state.pendingQuestion !== undefined &&
            state.pendingQuestion.epoch <= payload.assignmentEpoch;
          const requiredSlots = state.pendingQuestion === undefined ? 1 : 2;
          if (
            Queue.sizeUnsafe(state.events) > EVENT_CAPACITY - requiredSlots ||
            !Queue.offerUnsafe(state.events, report)
          )
            return yield* rpcFailure("event_queue_full", "Supervisor event queue is full.");
          if (cancelsQuestion)
            cancelPendingQuestion(
              state,
              "question_cancelled_by_report",
              "The pending question was cancelled because its assignment report was accepted.",
            );
          state.reports.set(payload.deliveryId, {
            epoch: payload.assignmentEpoch,
            sequence,
            text: payload.text,
            report,
          });
          state.nextReportSequence += 1;
          return { duplicate: false, sequence, assignmentEpoch: payload.assignmentEpoch };
        }),
    }),
  );

const closeNodeChannelEffect = (state: NodeChannelState) =>
  Effect.uninterruptibleMask((restore) =>
    Effect.suspend(() => {
      if (state.cleanupStarted) return restore(Deferred.await(state.cleanupDone));
      state.cleanupStarted = true;
      return Effect.gen(function* () {
        state.closed = true;
        Latch.openUnsafe(state.readiness);
        failPendingQuestion(
          state,
          "channel_closed",
          "Supervisor channel closed before the pending question settled.",
          false,
        );
        for (const acknowledgement of state.epochAcknowledgements.values())
          Deferred.doneUnsafe(
            acknowledgement.firstAcknowledgement,
            Effect.fail(
              channelError(
                "set assignment epoch",
                "channel_closed",
                "Supervisor channel closed before epoch acknowledgement.",
              ),
            ),
          );
        state.epochAcknowledgements.clear();
        for (const peer of state.peers.values()) Queue.endUnsafe(peer.assignments);
        state.peers.clear();
        yield* Queue.shutdown(state.events);
        yield* Scope.close(state.scope, Exit.void);
        yield* removePrivateState(state.stateDirectory, state.connectionConfigPath).pipe(
          Effect.mapError(() =>
            channelError(
              "cleanup",
              "cleanup_failed",
              "Supervisor private state cleanup could not be confirmed.",
            ),
          ),
        );
      }).pipe(Effect.onExit((exit) => Deferred.done(state.cleanupDone, exit).pipe(Effect.asVoid)));
    }),
  );

const acquireNodeChannelEffect = (
  options: SupervisorChannelLayerOptions,
  runId: SupervisorRunId,
  events: Queue.Queue<SupervisorEvent, Cause.Done>,
): Effect.Effect<NodeChannelState, SupervisorChannelError> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      let stateDirectory: string | undefined;
      let connectionConfigPath: string | undefined;
      let internalScope: Scope.Closeable | undefined;
      let state: NodeChannelState | undefined;
      let ownsStateDirectory = false;
      const requestedAuthTimeout = options.authTimeoutMillis ?? AUTH_TIMEOUT_MILLIS;
      const authTimeoutMillis = Number.isFinite(requestedAuthTimeout)
        ? Math.max(1, Math.min(60_000, Math.floor(requestedAuthTimeout)))
        : AUTH_TIMEOUT_MILLIS;

      const cleanupPartial = Effect.gen(function* () {
        if (state)
          return yield* closeNodeChannelEffect(state).pipe(Effect.catchCause(() => Effect.void));
        if (internalScope)
          yield* Scope.close(internalScope, Exit.void).pipe(Effect.catchCause(() => Effect.void));
        if (ownsStateDirectory && stateDirectory && connectionConfigPath)
          yield* removePrivateState(stateDirectory, connectionConfigPath).pipe(Effect.ignore);
        else if (ownsStateDirectory && stateDirectory) {
          const directory = stateDirectory;
          yield* privateStateOperation("remove-partial-channel-state", () =>
            fs.rmdir(directory),
          ).pipe(Effect.ignore);
        }
      });

      return yield* Effect.gen(function* () {
        const prepared = yield* restore(
          prepareStateDirectory(
            options.agentDirectory,
            runId,
            (candidate) => {
              stateDirectory = candidate.stateDirectory;
              connectionConfigPath = candidate.connectionConfigPath;
            },
            () => {
              ownsStateDirectory = true;
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
        stateDirectory = prepared.stateDirectory;
        connectionConfigPath = prepared.connectionConfigPath;
        internalScope = yield* Scope.make();
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
          runId,
          baseServer.address.port,
          stateDirectory,
          connectionConfigPath,
        );
        const token = Redacted.make(
          SupervisorAuthTokenSchema.make(randomBytes(32).toString("hex")),
        );
        const readiness = yield* Latch.make();
        state = {
          runId,
          scope: internalScope,
          peers: new Map(),
          events,
          metadata,
          stateDirectory,
          connectionConfigPath,
          token,
          assignmentEpochs: new Set(),
          questionEpochs: new Set(),
          reports: new Map(),
          epochAcknowledgements: new Map(),
          readiness,
          pendingAssignmentEpoch: undefined,
          currentAssignmentEpoch: 0,
          nextReportSequence: 1,
          pendingQuestion: undefined,
          cleanupStarted: false,
          cleanupDone: Deferred.makeUnsafe<void, SupervisorChannelError>(),
          closed: false,
        };
        const serialization = RpcSerialization.makeNdjson({
          maxBufferSize: MAX_SUPERVISOR_CHANNEL_LINE_BYTES,
        });
        const protocol = yield* makeSupervisorRpcServerProtocol({
          server: baseServer,
          authTimeoutMillis,
          maxConnections: MAX_CONNECTIONS,
          openSessionTag: SupervisorOpenSessionRpc._tag,
          onDisconnect: (clientId) => {
            if (state) removePeer(state, clientId);
          },
        }).pipe(
          Effect.provideService(RpcSerialization.RpcSerialization, serialization),
          Scope.provide(internalScope),
        );
        const handlers = yield* makeRpcHandlers(state);
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
        if (options.beforeConfigCommit)
          yield* Effect.tryPromise({
            try: () => options.beforeConfigCommit!(metadata),
            catch: configWriteError,
          });
        yield* Effect.tryPromise({
          try: () => writePrivateConfig(connectionConfigPath!, config),
          catch: configWriteError,
        });
        // Deliver interruption only after the config writer has settled, while acquisition still
        // owns failure cleanup for the listener, token document, and private state directory.
        yield* restore(Effect.void);
        if (options.beforeAcquireComplete)
          yield* restore(
            Effect.tryPromise({
              try: () => options.beforeAcquireComplete!(metadata),
              catch: () =>
                channelError(
                  "open channel",
                  "channel_open_failed",
                  "Unable to complete supervisor channel acquisition.",
                ),
            }),
          );
        return state;
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
      const state = yield* Effect.acquireRelease(
        acquireNodeChannelEffect(options, runId, events),
        (acquired) => closeNodeChannelEffect(acquired).pipe(Effect.orDie),
        { interruptible: true },
      );
      const close = closeNodeChannelEffect(state);

      const waitUntilReady = (): Effect.Effect<void, SupervisorChannelError> =>
        Effect.suspend(() => {
          if (state.closed)
            return Effect.fail(
              channelError("await ready", "channel_closed", "Supervisor channel is closed."),
            );
          if (hasReadyPeer(state)) return Effect.void;
          return Latch.await(state.readiness).pipe(Effect.flatMap(() => waitUntilReady()));
        });
      const awaitReady: Effect.Effect<void, SupervisorChannelError> = waitUntilReady().pipe(
        Effect.timeoutOption(REPLY_TIMEOUT),
        Effect.flatMap((outcome) =>
          Option.isSome(outcome)
            ? Effect.void
            : Effect.fail(
                channelError(
                  "await ready",
                  "supervisor_helper_unavailable",
                  "No authenticated supervisor helper became ready.",
                ),
              ),
        ),
      );

      const setAssignmentEpoch: SupervisorChannelHandle["setAssignmentEpoch"] = (epoch) =>
        Effect.gen(function* () {
          if (
            state.closed ||
            !Number.isSafeInteger(epoch) ||
            epoch <= state.currentAssignmentEpoch ||
            state.assignmentEpochs.size >= MAX_TRACKED_ASSIGNMENTS ||
            state.pendingAssignmentEpoch !== undefined
          )
            return yield* channelError(
              "set assignment epoch",
              "invalid_assignment_epoch",
              "Assignment epoch cannot advance in the current channel state.",
            );
          const peers = [...state.peers.values()].filter((peer) => peer.watching);
          if (peers.length === 0)
            return yield* channelError(
              "set assignment epoch",
              "supervisor_helper_unavailable",
              "Assignment epoch cannot advance without an authenticated helper.",
            );
          const firstAcknowledgement = Deferred.makeUnsafe<void, SupervisorChannelError>();
          state.pendingAssignmentEpoch = epoch;
          return yield* Effect.gen(function* () {
            let delivered = 0;
            for (const peer of peers) {
              const updateId = SupervisorChannelIdSchema.make(
                `epoch-${randomBytes(16).toString("hex")}`,
              );
              state.epochAcknowledgements.set(updateId, {
                epoch,
                peerId: peer.clientId,
                firstAcknowledgement,
              });
              if (
                Queue.offerUnsafe(peer.assignments, {
                  updateId,
                  assignmentEpoch: epoch,
                })
              ) {
                delivered += 1;
              } else {
                state.epochAcknowledgements.delete(updateId);
                peer.guard.close();
              }
            }
            if (delivered === 0)
              return yield* channelError(
                "set assignment epoch",
                "supervisor_helper_unavailable",
                "No authenticated helper accepted the assignment update.",
              );
            const outcome = yield* Deferred.await(firstAcknowledgement).pipe(
              Effect.timeoutOption(REPLY_TIMEOUT),
            );
            if (Option.isNone(outcome))
              return yield* channelError(
                "set assignment epoch",
                "assignment_epoch_outcome_uncertain",
                "Assignment epoch acknowledgement timed out.",
              );
          }).pipe(
            Effect.onExit((exit) =>
              Effect.sync(() => {
                state.pendingAssignmentEpoch = undefined;
                if (Exit.isSuccess(exit)) return;
                for (const [id, acknowledgement] of state.epochAcknowledgements)
                  if (acknowledgement.firstAcknowledgement === firstAcknowledgement)
                    state.epochAcknowledgements.delete(id);
              }),
            ),
          );
        });

      const acceptedReportForEpoch: SupervisorChannelHandle["acceptedReportForEpoch"] = (epoch) =>
        Effect.suspend(() => {
          if (
            state.closed ||
            !Number.isSafeInteger(epoch) ||
            epoch < 1 ||
            !state.assignmentEpochs.has(epoch)
          )
            return Effect.fail(
              channelError(
                "read report evidence",
                "invalid_assignment_epoch",
                "Report evidence epoch is invalid.",
              ),
            );
          const reports = [...state.reports.values()]
            .filter((entry) => entry.epoch === epoch)
            .sort((left, right) => left.sequence - right.sequence);
          return Effect.succeed(reports[0]?.report);
        });

      const reply: SupervisorChannelHandle["reply"] = (requestId, message) =>
        Effect.gen(function* () {
          const pending = state.pendingQuestion;
          if (
            state.closed ||
            !pending ||
            pending.requestId !== requestId ||
            pending.epoch !== state.currentAssignmentEpoch ||
            pending.replyStarted
          )
            return yield* channelError(
              "reply",
              "question_ownership_mismatch",
              "No exact pending supervisor question owns this reply.",
            );
          if (!validSupervisorReply(message))
            return yield* channelError(
              "reply",
              "invalid_reply",
              "Supervisor reply must be non-empty and bounded.",
            );
          pending.replyStarted = true;
          Deferred.doneUnsafe(
            pending.response,
            Effect.succeed({ questionId: pending.requestId, message: message.trim() }),
          );
          const acknowledged = yield* Deferred.await(pending.acknowledgement).pipe(
            Effect.timeoutOption(REPLY_TIMEOUT),
          );
          if (Option.isNone(acknowledged)) {
            if (state.pendingQuestion === pending)
              failPendingQuestion(
                state,
                "reply_outcome_uncertain",
                "Parent reply acknowledgement timed out.",
                false,
              );
            return yield* channelError(
              "reply",
              "reply_outcome_uncertain",
              "Parent reply delivery could not be confirmed.",
            );
          }
        });

      const cancelPending = (reason?: string): void => {
        const trimmed = reason?.trim();
        cancelPendingQuestion(
          state,
          "question_cancelled",
          trimmed ? trimmed.slice(0, 512) : "The pending supervisor question was cancelled.",
        );
      };

      return {
        runId: state.metadata.runId,
        metadata: state.metadata,
        events: state.events,
        awaitReady,
        setAssignmentEpoch,
        acceptedReportForEpoch,
        hasAcceptedReport: (epoch) =>
          acceptedReportForEpoch(epoch).pipe(Effect.map((report) => report !== undefined)),
        reply,
        cancelPending,
        close,
      } satisfies SupervisorChannelHandle;
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
