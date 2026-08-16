// Private loopback supervisor transport and agent-directory state are isolated at this boundary.
// @effect-diagnostics effect/nodeBuiltinImport:off
// @effect-diagnostics effect/processEnv:off
// @effect-diagnostics effect/cryptoRandomBytes:off
// @effect-diagnostics effect/asyncFunction:off
// @effect-diagnostics effect/newPromise:off
// @effect-diagnostics effect/globalTimers:off
// @effect-diagnostics effect/preferSchemaOverJson:off
import * as Predicate from "effect/Predicate";
import { hasObjectRuntimeType } from "pi-cosmic-core";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import { MAX_BACKEND_REPORT_EVIDENCE_CHARS, type BackendReport } from "../backend/model.ts";
import {
  authenticateSupervisorServerPayload,
  decodeSupervisorClientMessage,
  isSupervisorRunId,
  MAX_SUPERVISOR_CHANNEL_LINE_BYTES,
  MAX_SUPERVISOR_CONFIG_BYTES,
  SUPERVISOR_AUTH_TOKEN_CHARS,
  SUPERVISOR_CHANNEL_VERSION,
  SUPERVISOR_MCP_SERVER_NAME,
  SupervisorChannelConfigSchema,
  type SupervisorEvent,
  type SupervisorServerMessage,
  type SupervisorServerPayload,
  validSupervisorMessage,
  validSupervisorReply,
  validSupervisorReport,
} from "../supervisor/protocol.ts";
import { attachBoundedLineParser } from "./bounded-line-parser.ts";
import {
  ensurePrivateDirectory,
  nodeErrorCode,
  safeAgentDirectory,
  writeExclusive,
} from "./harness-shared.ts";

const LOOPBACK_HOST = "127.0.0.1" as const;
const CHANNEL_ROOT = "supervisor-channels-v1";
const CONNECTION_CONFIG_FILE = "connection.json";
const EVENT_CAPACITY = 64;
// One slot remains reserved for exact pending-question cancellation.
const CONTACT_EVENT_CAPACITY = EVENT_CAPACITY - 1;
const MAX_CONNECTIONS = 4;
const MAX_PENDING_WRITES = 32;
const MAX_TRACKED_ASSIGNMENTS = 256;
const MAX_REPORT_DELIVERIES = 128;
const AUTH_TIMEOUT_MILLIS = 5_000;
const REPLY_TIMEOUT = "10 seconds";

const tokenPattern = /^[a-f0-9]{64}$/;

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
    readonly [SUPERVISOR_MCP_SERVER_NAME]: {
      readonly type: "stdio";
      readonly command: string;
      readonly args: ReadonlyArray<string>;
      readonly env: Readonly<Record<string, never>>;
    };
  };
}

export interface CodexSupervisorMcpMetadata {
  readonly serverName: typeof SUPERVISOR_MCP_SERVER_NAME;
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
  /** Confirm at least one authenticated packaged helper/bridge before runtime selection is usable. */
  readonly awaitReady: Effect.Effect<void, SupervisorChannelError>;
  /** Monotonic per run. Call before the adapter issues the corresponding assignment. */
  readonly setAssignmentEpoch: (epoch: number) => Effect.Effect<void, SupervisorChannelError>;
  /**
   * Causal evidence recorded before the MCP report call is acknowledged. This does not depend on
   * the adapter draining the event queue and is safe to query at native turn completion.
   */
  readonly hasAcceptedReport: (epoch: number) => Effect.Effect<boolean, SupervisorChannelError>;
  /** Return exact accepted report evidence so adapters can preserve it across transport shutdown. */
  readonly acceptedReportForEpoch: (
    epoch: number,
  ) => Effect.Effect<BackendReport | undefined, SupervisorChannelError>;
  /** Settle only the exact pending question owned by this channel and current assignment. */
  readonly reply: (
    requestId: string,
    message: string,
  ) => Effect.Effect<void, SupervisorChannelError>;
  /** Settle pending calls without accepting additional transport input. */
  readonly cancelPending: (reason?: string) => void;
  /** Idempotently close sockets/server/queue and remove this run's private state. */
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
}

interface PendingQuestion {
  readonly requestId: string;
  readonly epoch: number;
  readonly peer: AuthenticatedPeer;
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
  readonly peer: AuthenticatedPeer;
  readonly deferred: Deferred.Deferred<void, SupervisorChannelError>;
  readonly firstAcknowledgement: Deferred.Deferred<void, SupervisorChannelError>;
}

interface AuthenticatedPeer {
  readonly socket: Socket;
  readonly send: (message: SupervisorServerMessage) => Promise<void>;
  authenticated: boolean;
  detach: () => void;
}

interface NodeChannelState {
  readonly server: Server;
  readonly peers: Set<AuthenticatedPeer>;
  readonly events: Queue.Queue<SupervisorEvent, Cause.Done>;
  readonly metadata: SupervisorConnectionMetadata;
  readonly stateDirectory: string;
  readonly connectionConfigPath: string;
  readonly token: string;
  readonly assignmentEpochs: Set<number>;
  readonly questionEpochs: Set<number>;
  readonly reports: Map<string, AcceptedReport>;
  readonly epochAcknowledgements: Map<string, PendingEpochAcknowledgement>;
  readonly readinessWaiters: Set<Deferred.Deferred<void, SupervisorChannelError>>;
  pendingAssignmentEpoch: number | undefined;
  currentAssignmentEpoch: number;
  nextReportSequence: number;
  pendingQuestion: PendingQuestion | undefined;
  closed: boolean;
  closePromise: Promise<void> | undefined;
}

const channelError = (operation: string, code: string, message: string) =>
  new SupervisorChannelError({ operation, code, message });

const isLoopbackPeer = (address: string | undefined): boolean =>
  address === LOOPBACK_HOST || address === "::ffff:127.0.0.1";

const authenticatedToken = <ValueInput>(expected: string, value: ValueInput): boolean => {
  const expectedBytes = Buffer.from(expected, "utf8");
  const supplied = Predicate.isString(value) ? Buffer.from(value, "utf8") : Buffer.alloc(0);
  if (supplied.length !== expectedBytes.length) {
    // Keep malformed-token work on the same constant-time primitive without accepting it.
    timingSafeEqual(expectedBytes, expectedBytes);
    return false;
  }
  return timingSafeEqual(expectedBytes, supplied);
};

const exactConfig = <ValueInput>(value: ValueInput) => {
  const decoded = Schema.decodeUnknownOption(SupervisorChannelConfigSchema, {
    onExcessProperty: "error",
  })(value);
  return Option.isSome(decoded) ? decoded.value : undefined;
};

const tomlString = (value: string): string => JSON.stringify(value);

const makeMetadata = (
  runId: string,
  port: number,
  stateDirectory: string,
  connectionConfigPath: string,
): SupervisorConnectionMetadata => {
  const helperPath = fileURLToPath(new URL("./supervisor-mcp-helper.mjs", import.meta.url));
  const command = process.execPath;
  const args = [helperPath, "--config", connectionConfigPath] as const;
  const enabledTools = [
    "supervisor_progress",
    "supervisor_warning",
    "supervisor_question",
    "supervisor_submit_report",
  ] as const;
  const claudeMcp: ClaudeSupervisorMcpMetadata = {
    mcpServers: {
      [SUPERVISOR_MCP_SERVER_NAME]: {
        type: "stdio",
        command,
        args,
        // No user environment, credentials, or arbitrary launch configuration is copied here.
        env: {},
      },
    },
  };
  const codexMcp: CodexSupervisorMcpMetadata = {
    serverName: SUPERVISOR_MCP_SERVER_NAME,
    command,
    args,
    enabledTools,
    tomlFragment: [
      `[mcp_servers.${SUPERVISOR_MCP_SERVER_NAME}]`,
      `command = ${tomlString(command)}`,
      `args = [${args.map(tomlString).join(", ")}]`,
      "required = true",
      `enabled_tools = [${enabledTools.map(tomlString).join(", ")}]`,
      'default_tools_approval_mode = "approve"',
    ].join("\n"),
  };
  return {
    runId,
    host: LOOPBACK_HOST,
    port,
    stateDirectory,
    connectionConfigPath,
    helperPath,
    claudeMcp,
    codexMcp,
  };
};

const prepareStateDirectory = async (
  agentDirectory: string,
  runId: string,
): Promise<{ readonly stateDirectory: string; readonly connectionConfigPath: string }> => {
  const canonicalAgentDirectory = await safeAgentDirectory(agentDirectory);
  const packageRoot = join(canonicalAgentDirectory, "subagents");
  const channelRoot = join(packageRoot, CHANNEL_ROOT);
  await ensurePrivateDirectory(packageRoot);
  await ensurePrivateDirectory(channelRoot);
  const stateDirectory = join(channelRoot, `${runId}-${randomBytes(12).toString("hex")}`);
  await fs.mkdir(stateDirectory, { mode: 0o700 });
  const stateStat = await fs.lstat(stateDirectory);
  if (!stateStat.isDirectory() || stateStat.isSymbolicLink()) throw new Error("unsafe-run-dir");
  return {
    stateDirectory,
    connectionConfigPath: join(stateDirectory, CONNECTION_CONFIG_FILE),
  };
};

const writePrivateConfig = async <ValueInput>(path: string, value: ValueInput): Promise<void> => {
  const source = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(source, "utf8") > MAX_SUPERVISOR_CONFIG_BYTES)
    throw new Error("config-size");
  await writeExclusive(path, source);
};

const removePrivateState = async (
  stateDirectory: string,
  connectionConfigPath: string,
): Promise<void> => {
  try {
    const stat = await fs.lstat(connectionConfigPath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("unsafe-config-cleanup");
    await fs.unlink(connectionConfigPath);
  } catch (error) {
    if (nodeErrorCode(error) !== "ENOENT") throw error;
  }
  const entries = await fs.readdir(stateDirectory);
  if (entries.length !== 0) throw new Error("unexpected-channel-state");
  await fs.rmdir(stateDirectory);
};

const listen = (server: Server): Promise<number> =>
  new Promise((resolveListen, rejectListen) => {
    const onError = () => {
      server.off("listening", onListening);
      rejectListen(new Error("listen-failed"));
    };
    const onListening = () => {
      server.off("error", onError);
      const address = server.address();
      if (!address || Predicate.isString(address)) {
        rejectListen(new Error("invalid-listener-address"));
        return;
      }
      resolveListen(address.port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host: LOOPBACK_HOST, port: 0, exclusive: true });
  });

const closeServer = (server: Server): Promise<void> =>
  new Promise((resolveClose, rejectClose) => {
    if (!server.listening) {
      resolveClose();
      return;
    }
    server.close((error) => (error ? rejectClose(error) : resolveClose()));
  });

const makePeerSender = (socket: Socket, onFailure: () => void) => {
  let writeTail: Promise<void> = Promise.resolve();
  let pendingWrites = 0;
  return (message: SupervisorServerMessage): Promise<void> => {
    if (socket.destroyed || pendingWrites >= MAX_PENDING_WRITES) {
      onFailure();
      return Promise.reject(new Error("socket-write-unavailable"));
    }
    const line = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(line, "utf8") > MAX_SUPERVISOR_CHANNEL_LINE_BYTES) {
      onFailure();
      return Promise.reject(new Error("socket-write-oversized"));
    }
    pendingWrites += 1;
    const write = writeTail.then(
      () =>
        new Promise<void>((resolveWrite, rejectWrite) => {
          socket.write(line, "utf8", (error) =>
            error ? rejectWrite(error) : resolveWrite(undefined),
          );
        }),
    );
    writeTail = write
      .catch(() => undefined)
      .then(() => {
        pendingWrites = Math.max(0, pendingWrites - 1);
      });
    void write.catch(() => onFailure());
    return write;
  };
};

const authenticatedServerMessage = (
  state: NodeChannelState,
  payload: SupervisorServerPayload,
): SupervisorServerMessage =>
  authenticateSupervisorServerPayload(
    {
      version: SUPERVISOR_CHANNEL_VERSION,
      runId: state.metadata.runId,
      token: state.token,
    },
    payload,
  );

const failPendingQuestion = (state: NodeChannelState, code: string, message: string): void => {
  const pending = state.pendingQuestion;
  if (!pending) return;
  state.pendingQuestion = undefined;
  void pending.peer
    .send(authenticatedServerMessage(state, { type: "cancelled", id: pending.requestId }))
    .catch(() => undefined);
  Deferred.doneUnsafe(pending.acknowledgement, Effect.fail(channelError("reply", code, message)));
};

/**
 * Cancel one accepted question only after its correlated orchestration event is durably queued.
 * Contact/report admission keeps one queue slot reserved while a question is pending.
 */
const cancelPendingQuestion = (state: NodeChannelState, code: string, message: string): boolean => {
  const pending = state.pendingQuestion;
  if (!pending) return false;
  const offered = Queue.offerUnsafe(state.events, {
    type: "supervisor_question_cancelled",
    assignmentEpoch: pending.epoch,
    requestId: pending.requestId,
  });
  if (!offered) return false;
  failPendingQuestion(state, code, message);
  return true;
};

const liveAuthenticatedPeers = (state: NodeChannelState): ReadonlyArray<AuthenticatedPeer> =>
  [...state.peers].filter((peer) => peer.authenticated && !peer.socket.destroyed);

const publishReadyGeneration = (state: NodeChannelState): void => {
  if (liveAuthenticatedPeers(state).length === 0) return;
  for (const waiter of state.readinessWaiters) Deferred.doneUnsafe(waiter, Effect.void);
  state.readinessWaiters.clear();
};

const sendAuthenticated = (
  state: NodeChannelState,
  peer: AuthenticatedPeer,
  payload: SupervisorServerPayload,
): void => {
  void peer.send(authenticatedServerMessage(state, payload)).catch(() => undefined);
};

const closePeer = (state: NodeChannelState, peer: AuthenticatedPeer): void => {
  if (!state.peers.delete(peer)) return;
  peer.detach();
  peer.socket.destroy();
  const affectedEpochUpdates = new Set<Deferred.Deferred<void, SupervisorChannelError>>();
  for (const [id, acknowledgement] of state.epochAcknowledgements) {
    if (acknowledgement.peer !== peer) continue;
    state.epochAcknowledgements.delete(id);
    affectedEpochUpdates.add(acknowledgement.firstAcknowledgement);
    Deferred.doneUnsafe(
      acknowledgement.deferred,
      Effect.fail(
        channelError(
          "set assignment epoch",
          "assignment_epoch_outcome_uncertain",
          "Assignment epoch acknowledgement transport closed.",
        ),
      ),
    );
  }
  for (const firstAcknowledgement of affectedEpochUpdates) {
    const hasLiveUpdate = [...state.epochAcknowledgements.values()].some(
      (acknowledgement) => acknowledgement.firstAcknowledgement === firstAcknowledgement,
    );
    if (!hasLiveUpdate)
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
  if (state.pendingQuestion?.peer === peer)
    cancelPendingQuestion(
      state,
      "question_transport_closed",
      "The private supervisor question transport closed before its exact reply was confirmed.",
    );
};

const offerContact = (
  state: NodeChannelState,
  peer: AuthenticatedPeer,
  message: Extract<
    ReturnType<typeof decodeSupervisorClientMessage>,
    { readonly type: "progress" | "warning" }
  >,
): void => {
  if (!validSupervisorMessage(message.message)) {
    sendAuthenticated(state, peer, {
      type: "error",
      id: message.id,
      code: "invalid_message",
      message: "Supervisor message must be non-empty and bounded.",
    });
    return;
  }
  const offered =
    Queue.sizeUnsafe(state.events) < CONTACT_EVENT_CAPACITY &&
    Queue.offerUnsafe(state.events, {
      type: "supervisor_contact",
      assignmentEpoch: message.assignmentEpoch,
      requestId: message.id,
      kind: message.type,
      message: message.message,
    });
  sendAuthenticated(
    state,
    peer,
    offered
      ? { type: "result", id: message.id, accepted: true }
      : {
          type: "error",
          id: message.id,
          code: "event_queue_full",
          message: "Supervisor event queue is full; delivery was not accepted.",
        },
  );
};

const offerQuestion = (
  state: NodeChannelState,
  peer: AuthenticatedPeer,
  message: Extract<ReturnType<typeof decodeSupervisorClientMessage>, { readonly type: "question" }>,
): void => {
  if (!validSupervisorMessage(message.message)) {
    sendAuthenticated(state, peer, {
      type: "error",
      id: message.id,
      code: "invalid_question",
      message: "Supervisor question must be non-empty and bounded.",
    });
    return;
  }
  if (state.pendingQuestion) {
    sendAuthenticated(state, peer, {
      type: "error",
      id: message.id,
      code: "question_pending",
      message: "A blocking supervisor question is already pending for this run.",
    });
    return;
  }
  if (state.questionEpochs.has(message.assignmentEpoch)) {
    sendAuthenticated(state, peer, {
      type: "error",
      id: message.id,
      code: "question_already_used",
      message: "This assignment already used its one blocking supervisor question.",
    });
    return;
  }
  const acknowledgement = Deferred.makeUnsafe<void, SupervisorChannelError>();
  state.pendingQuestion = {
    requestId: message.id,
    epoch: message.assignmentEpoch,
    peer,
    acknowledgement,
    replyStarted: false,
  };
  const offered =
    Queue.sizeUnsafe(state.events) < CONTACT_EVENT_CAPACITY &&
    Queue.offerUnsafe(state.events, {
      type: "supervisor_contact",
      assignmentEpoch: message.assignmentEpoch,
      requestId: message.id,
      kind: "question",
      message: message.message,
    });
  if (!offered) {
    state.pendingQuestion = undefined;
    sendAuthenticated(state, peer, {
      type: "error",
      id: message.id,
      code: "event_queue_full",
      message: "Supervisor event queue is full; the question was not accepted.",
    });
    return;
  }
  state.questionEpochs.add(message.assignmentEpoch);
  // A question intentionally receives no result until the exact parent reply arrives.
};

const offerReport = (
  state: NodeChannelState,
  peer: AuthenticatedPeer,
  message: Extract<ReturnType<typeof decodeSupervisorClientMessage>, { readonly type: "report" }>,
): void => {
  if (!validSupervisorReport(message.text)) {
    sendAuthenticated(state, peer, {
      type: "error",
      id: message.id,
      code: "invalid_report",
      message: "Final report text must be non-empty and bounded.",
    });
    return;
  }
  const previous = state.reports.get(message.deliveryId);
  if (previous) {
    sendAuthenticated(
      state,
      peer,
      previous.epoch === message.assignmentEpoch && previous.text === message.text
        ? {
            type: "result",
            id: message.id,
            accepted: true,
            duplicate: true,
            sequence: previous.sequence,
            assignmentEpoch: previous.epoch,
          }
        : {
            type: "error",
            id: message.id,
            code: "delivery_identity_conflict",
            message:
              "The report delivery identity was already used in another epoch or for different content.",
          },
    );
    return;
  }
  if (state.reports.size >= MAX_REPORT_DELIVERIES) {
    sendAuthenticated(state, peer, {
      type: "error",
      id: message.id,
      code: "report_identity_capacity",
      message: "The bounded report delivery-identity map is full.",
    });
    return;
  }
  const sequence = state.nextReportSequence;
  const report: BackendReport & { readonly type: "report" } = {
    type: "report",
    runId: state.metadata.runId,
    assignmentEpoch: message.assignmentEpoch,
    sequence,
    deliveryId: message.deliveryId,
    text: message.text,
    evidence: `supervisor-channel-v${SUPERVISOR_CHANNEL_VERSION}`.slice(
      0,
      MAX_BACKEND_REPORT_EVIDENCE_CHARS,
    ),
  };
  const cancelsQuestion =
    state.pendingQuestion !== undefined && state.pendingQuestion.epoch <= message.assignmentEpoch;
  const requiredSlots = state.pendingQuestion === undefined ? 1 : 2;
  if (
    Queue.sizeUnsafe(state.events) > EVENT_CAPACITY - requiredSlots ||
    !Queue.offerUnsafe(state.events, report)
  ) {
    sendAuthenticated(state, peer, {
      type: "error",
      id: message.id,
      code: "event_queue_full",
      message: "Supervisor event queue is full; report delivery was not accepted.",
    });
    return;
  }
  if (cancelsQuestion)
    cancelPendingQuestion(
      state,
      "question_cancelled_by_report",
      "The pending supervisor question was cancelled because its assignment report was accepted.",
    );
  state.reports.set(message.deliveryId, {
    epoch: message.assignmentEpoch,
    sequence,
    text: message.text,
    report,
  });
  state.nextReportSequence += 1;
  sendAuthenticated(state, peer, {
    type: "result",
    id: message.id,
    accepted: true,
    duplicate: false,
    sequence,
    assignmentEpoch: message.assignmentEpoch,
  });
};

const dispatchAuthenticated = (
  state: NodeChannelState,
  peer: AuthenticatedPeer,
  message: Exclude<
    NonNullable<ReturnType<typeof decodeSupervisorClientMessage>>,
    { readonly type: "hello" }
  >,
): void => {
  if (message.type === "cancel") {
    const pending = state.pendingQuestion;
    const ownsQuestion =
      pending !== undefined &&
      pending.requestId === message.targetRequestId &&
      pending.peer === peer;
    const cancelled =
      ownsQuestion &&
      cancelPendingQuestion(
        state,
        "question_cancelled",
        "The exact pending supervisor question was cancelled by its MCP caller.",
      );
    if (cancelled)
      sendAuthenticated(state, peer, {
        type: "cancelled",
        id: message.targetRequestId,
      });
    sendAuthenticated(state, peer, {
      type: "cancel_result",
      id: message.id,
      targetRequestId: message.targetRequestId,
      cancelled,
    });
    return;
  }
  if (message.type === "assignment_epoch_ack") {
    const acknowledgement = state.epochAcknowledgements.get(message.id);
    if (
      !acknowledgement ||
      acknowledgement.peer !== peer ||
      acknowledgement.epoch !== message.assignmentEpoch
    ) {
      sendAuthenticated(state, peer, {
        type: "error",
        id: message.id,
        code: "assignment_epoch_ack_mismatch",
        message: "Assignment epoch acknowledgement did not match an issued update.",
      });
      return;
    }
    state.epochAcknowledgements.delete(message.id);
    if (state.pendingAssignmentEpoch === acknowledgement.epoch) {
      if (state.pendingQuestion && state.pendingQuestion.epoch < acknowledgement.epoch)
        cancelPendingQuestion(
          state,
          "question_assignment_advanced",
          "The pending supervisor question belonged to a prior assignment and was cancelled.",
        );
      state.currentAssignmentEpoch = acknowledgement.epoch;
      state.assignmentEpochs.add(acknowledgement.epoch);
    }
    Deferred.doneUnsafe(acknowledgement.deferred, Effect.void);
    Deferred.doneUnsafe(acknowledgement.firstAcknowledgement, Effect.void);
    return;
  }
  if (message.type === "question_reply_ack") {
    const pending = state.pendingQuestion;
    if (
      !pending ||
      pending.requestId !== message.questionId ||
      pending.peer !== peer ||
      !pending.replyStarted
    ) {
      sendAuthenticated(state, peer, {
        type: "error",
        id: message.id,
        code: "reply_ack_mismatch",
        message: "Question reply acknowledgement did not match an owned pending reply.",
      });
      return;
    }
    state.pendingQuestion = undefined;
    Deferred.doneUnsafe(pending.acknowledgement, Effect.void);
    sendAuthenticated(state, peer, { type: "result", id: message.id, accepted: true });
    return;
  }
  if (!state.assignmentEpochs.has(message.assignmentEpoch)) {
    sendAuthenticated(state, peer, {
      type: "error",
      id: message.id,
      code: "unknown_assignment_epoch",
      message: "Supervisor event did not name an assignment epoch issued by this channel.",
    });
    return;
  }
  switch (message.type) {
    case "progress":
    case "warning":
      offerContact(state, peer, message);
      return;
    case "question":
      offerQuestion(state, peer, message);
      return;
    case "report":
      offerReport(state, peer, message);
      return;
  }
};

const acceptSocket = (state: NodeChannelState, socket: Socket): void => {
  if (
    state.closed ||
    state.peers.size >= MAX_CONNECTIONS ||
    !isLoopbackPeer(socket.remoteAddress)
  ) {
    socket.destroy();
    return;
  }
  socket.setNoDelay(true);
  let authTimer: NodeJS.Timeout | undefined = setTimeout(
    () => socket.destroy(),
    AUTH_TIMEOUT_MILLIS,
  );
  authTimer.unref();
  let peer!: AuthenticatedPeer;
  const destroy = () => closePeer(state, peer);
  const send = makePeerSender(socket, destroy);
  const detachParser = attachBoundedLineParser(socket, {
    maxLineBytes: MAX_SUPERVISOR_CHANNEL_LINE_BYTES,
    maxQueuedBytes: MAX_SUPERVISOR_CHANNEL_LINE_BYTES * 2,
    onLine: (line) => {
      let value: unknown;
      try {
        // SAFETY: Boundary decoding validates the value before it is narrowed to this declared contract.
        value = JSON.parse(line) as unknown;
      } catch {
        destroy();
        return;
      }
      const token =
        value && hasObjectRuntimeType(value) && "token" in value ? value.token : undefined;
      if (!authenticatedToken(state.token, token)) {
        destroy();
        return;
      }
      const message = decodeSupervisorClientMessage(value);
      if (!message || message.runId !== state.metadata.runId) {
        if (peer.authenticated)
          sendAuthenticated(state, peer, {
            type: "error",
            id: null,
            code: "invalid_protocol_message",
            message: "Supervisor protocol message was malformed, excessive, or unsupported.",
          });
        destroy();
        return;
      }
      if (!peer.authenticated) {
        if (message.type !== "hello") {
          destroy();
          return;
        }
        peer.authenticated = true;
        if (authTimer) clearTimeout(authTimer);
        authTimer = undefined;
        sendAuthenticated(state, peer, {
          type: "hello_ok",
          id: message.id,
          assignmentEpoch: state.currentAssignmentEpoch,
        });
        publishReadyGeneration(state);
        return;
      }
      if (message.type === "hello") {
        destroy();
        return;
      }
      dispatchAuthenticated(state, peer, message);
    },
    onOverflow: destroy,
  });
  peer = {
    socket,
    send,
    authenticated: false,
    detach: () => {
      if (authTimer) clearTimeout(authTimer);
      authTimer = undefined;
      detachParser();
      socket.off("error", destroy);
      socket.off("close", destroy);
    },
  };
  state.peers.add(peer);
  socket.once("error", destroy);
  socket.once("close", destroy);
};

const closeNodeChannel = (state: NodeChannelState): Promise<void> => {
  if (state.closePromise) return state.closePromise;
  state.closed = true;
  for (const waiter of state.readinessWaiters)
    Deferred.doneUnsafe(
      waiter,
      Effect.fail(
        channelError(
          "await helper readiness",
          "supervisor_helper_unavailable",
          "The private supervisor channel closed before a live helper became ready.",
        ),
      ),
    );
  state.readinessWaiters.clear();
  failPendingQuestion(
    state,
    "channel_closed",
    "The private supervisor channel closed before the pending question settled.",
  );
  Queue.endUnsafe(state.events);
  state.closePromise = (async () => {
    const serverClose = closeServer(state.server);
    for (const peer of state.peers) {
      sendAuthenticated(state, peer, { type: "closed" });
      closePeer(state, peer);
    }
    await serverClose;
    await removePrivateState(state.stateDirectory, state.connectionConfigPath);
  })();
  return state.closePromise;
};

const acquireNodeChannel = async (
  agentDirectory: string,
  runId: string,
  events: Queue.Queue<SupervisorEvent, Cause.Done>,
): Promise<NodeChannelState> => {
  let stateDirectory: string | undefined;
  let connectionConfigPath: string | undefined;
  const token = randomBytes(32).toString("hex");
  if (token.length !== SUPERVISOR_AUTH_TOKEN_CHARS || !tokenPattern.test(token))
    throw new Error("token-generation");
  const server = createServer();
  let state: NodeChannelState | undefined;
  server.on("error", () => {
    if (state) void closeNodeChannel(state).catch(() => undefined);
  });
  server.on("connection", (socket) => {
    if (!state) {
      socket.destroy();
      return;
    }
    acceptSocket(state, socket);
  });
  try {
    ({ stateDirectory, connectionConfigPath } = await prepareStateDirectory(agentDirectory, runId));
    const port = await listen(server);
    const config = {
      version: SUPERVISOR_CHANNEL_VERSION,
      runId,
      host: LOOPBACK_HOST,
      port,
      token,
    };
    if (!exactConfig(config)) throw new Error("invalid-generated-config");
    await writePrivateConfig(connectionConfigPath, config);
    const metadata = makeMetadata(runId, port, stateDirectory, connectionConfigPath);
    state = {
      server,
      peers: new Set(),
      events,
      metadata,
      stateDirectory,
      connectionConfigPath,
      token,
      assignmentEpochs: new Set(),
      questionEpochs: new Set(),
      reports: new Map(),
      epochAcknowledgements: new Map(),
      readinessWaiters: new Set(),
      pendingAssignmentEpoch: undefined,
      currentAssignmentEpoch: 0,
      nextReportSequence: 1,
      pendingQuestion: undefined,
      closed: false,
      closePromise: undefined,
    };
    return state;
  } catch (error) {
    await closeServer(server).catch(() => undefined);
    if (connectionConfigPath && stateDirectory)
      await removePrivateState(stateDirectory, connectionConfigPath).catch(() => undefined);
    else if (stateDirectory) await fs.rmdir(stateDirectory).catch(() => undefined);
    throw error;
  }
};

export const makeSupervisorChannel = (
  options: SupervisorChannelLayerOptions,
): SupervisorChannelContract => ({
  open: (request) =>
    Effect.gen(function* () {
      if (!isSupervisorRunId(request.runId))
        return yield* channelError(
          "open",
          "invalid_run_id",
          "Private supervisor channel run identity is invalid or exceeds its bound.",
        );
      const events = yield* Queue.dropping<SupervisorEvent, Cause.Done>(EVENT_CAPACITY);
      const state = yield* Effect.tryPromise({
        try: () => acquireNodeChannel(options.agentDirectory, request.runId, events),
        catch: () =>
          channelError(
            "open",
            "channel_open_failed",
            "Unable to create the private loopback supervisor channel.",
          ),
      });
      const close = Effect.tryPromise({
        try: () => closeNodeChannel(state),
        catch: () =>
          channelError(
            "close",
            "channel_close_failed",
            "Private supervisor transport closed, but its bounded state cleanup was not confirmed.",
          ),
      });
      yield* Effect.addFinalizer(() => close.pipe(Effect.orDie));

      const awaitReady = Effect.suspend(() => {
        if (state.closed)
          return Effect.fail(
            channelError(
              "await helper readiness",
              "supervisor_helper_unavailable",
              "The private supervisor channel is closed.",
            ),
          );
        if (liveAuthenticatedPeers(state).length > 0) return Effect.void;
        // This thunk runs synchronously, so no handshake can interleave between the peer check
        // above and waiter installation; only a new live handshake completes this waiter.
        const waiter = Deferred.makeUnsafe<void, SupervisorChannelError>();
        state.readinessWaiters.add(waiter);
        return Deferred.await(waiter).pipe(
          Effect.timeoutOption(REPLY_TIMEOUT),
          Effect.ensuring(Effect.sync(() => void state.readinessWaiters.delete(waiter))),
          Effect.flatMap((ready) =>
            Option.isSome(ready) && liveAuthenticatedPeers(state).length > 0
              ? Effect.void
              : Effect.fail(
                  channelError(
                    "await helper readiness",
                    "supervisor_helper_unavailable",
                    "No live authenticated packaged supervisor helper became ready in time.",
                  ),
                ),
          ),
        );
      });

      const setAssignmentEpoch: SupervisorChannelHandle["setAssignmentEpoch"] = (epoch) =>
        Effect.gen(function* () {
          const peers = liveAuthenticatedPeers(state);
          if (
            state.closed ||
            !Number.isSafeInteger(epoch) ||
            epoch <= state.currentAssignmentEpoch ||
            state.pendingAssignmentEpoch !== undefined ||
            state.assignmentEpochs.size >= MAX_TRACKED_ASSIGNMENTS
          )
            return yield* channelError(
              "set assignment epoch",
              "invalid_assignment_epoch",
              "Supervisor assignment epoch must be positive, monotonic, singular, and within the channel bound.",
            );
          if (peers.length === 0)
            return yield* channelError(
              "set assignment epoch",
              "supervisor_helper_unavailable",
              "Assignment epoch cannot advance without a live authenticated supervisor helper.",
            );
          const firstAcknowledgement = Deferred.makeUnsafe<void, SupervisorChannelError>();
          state.pendingAssignmentEpoch = epoch;
          const updates = peers.map((peer) => {
            const id = `epoch-${randomBytes(16).toString("hex")}`;
            const deferred = Deferred.makeUnsafe<void, SupervisorChannelError>();
            state.epochAcknowledgements.set(id, {
              epoch,
              peer,
              deferred,
              firstAcknowledgement,
            });
            void peer
              .send(
                authenticatedServerMessage(state, {
                  type: "assignment_epoch",
                  id,
                  assignmentEpoch: epoch,
                }),
              )
              .catch(() => closePeer(state, peer));
            return { id, deferred };
          });
          const acknowledged = yield* Deferred.await(firstAcknowledgement).pipe(
            Effect.timeoutOption(REPLY_TIMEOUT),
            Effect.ensuring(
              Effect.sync(() => {
                for (const update of updates) state.epochAcknowledgements.delete(update.id);
                if (state.pendingAssignmentEpoch === epoch)
                  state.pendingAssignmentEpoch = undefined;
              }),
            ),
          );
          if (Option.isNone(acknowledged))
            return yield* channelError(
              "set assignment epoch",
              "assignment_epoch_outcome_uncertain",
              "Assignment epoch was sent but no live authenticated helper acknowledged it within the bound; the task was not issued.",
            );
        });

      const acceptedReportForEpoch: SupervisorChannelHandle["acceptedReportForEpoch"] = (epoch) =>
        Effect.suspend(() =>
          state.closed ||
          !Number.isSafeInteger(epoch) ||
          epoch <= 0 ||
          !state.assignmentEpochs.has(epoch)
            ? Effect.fail(
                channelError(
                  "query accepted report",
                  "report_epoch_ownership_mismatch",
                  "Accepted-report evidence requires an assignment epoch owned by this open channel.",
                ),
              )
            : Effect.succeed(
                [...state.reports.values()].find((report) => report.epoch === epoch)?.report,
              ),
        );

      const hasAcceptedReport: SupervisorChannelHandle["hasAcceptedReport"] = (epoch) =>
        acceptedReportForEpoch(epoch).pipe(Effect.map((report) => report !== undefined));

      const reply: SupervisorChannelHandle["reply"] = (requestId, message) =>
        Effect.gen(function* () {
          const pending = state.pendingQuestion;
          if (
            state.closed ||
            !pending ||
            pending.requestId !== requestId ||
            pending.epoch !== state.currentAssignmentEpoch ||
            pending.replyStarted ||
            !validSupervisorReply(message)
          )
            return yield* channelError(
              "reply",
              "question_ownership_mismatch",
              "No current, exact, replyable supervisor question matched this request.",
            );
          pending.replyStarted = true;
          yield* Effect.tryPromise({
            try: () =>
              pending.peer.send(
                authenticatedServerMessage(state, {
                  type: "question_reply",
                  id: pending.requestId,
                  message,
                }),
              ),
            catch: () =>
              channelError(
                "reply",
                "reply_outcome_uncertain",
                "The exact parent reply may have been delivered; it will not be retried automatically.",
              ),
          });
          const acknowledged = yield* Deferred.await(pending.acknowledgement).pipe(
            Effect.timeoutOption(REPLY_TIMEOUT),
          );
          if (Option.isNone(acknowledged)) {
            if (state.pendingQuestion === pending)
              cancelPendingQuestion(
                state,
                "reply_outcome_uncertain",
                "The exact parent reply was sent but not acknowledged; the question was closed without retry.",
              );
            return yield* channelError(
              "reply",
              "reply_outcome_uncertain",
              "The exact parent reply was sent but not acknowledged; it will not be retried automatically.",
            );
          }
        });

      const cancelPending = (reason?: string): void => {
        if (!state.pendingQuestion) return;
        const trimmedReason = reason?.trim();
        cancelPendingQuestion(
          state,
          "question_cancelled",
          trimmedReason
            ? `The pending supervisor question was cancelled by its owning adapter: ${trimmedReason}`
            : "The pending supervisor question was cancelled.",
        );
      };

      return {
        runId: request.runId,
        metadata: state.metadata,
        events,
        awaitReady,
        setAssignmentEpoch,
        hasAcceptedReport,
        acceptedReportForEpoch,
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
