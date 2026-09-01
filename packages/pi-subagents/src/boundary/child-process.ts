// Node process and session-file ownership is intentionally isolated at this boundary.
import { hasObjectRuntimeType, synchronousNow } from "pi-cosmic-core";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { nodeFsPromises, nodePath, nodeSpawn as spawn } from "./node-builtins.ts";
import {
  getAgentDir,
  getPackageDir,
  SessionManager,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import type * as Scope from "effect/Scope";
import {
  PI_CHILD_COMPETING_ORCHESTRATOR_TOOL_ARGUMENT,
  SUBAGENT_TOOL_NAMES,
} from "../run/tool-policy.ts";
import { processCauseError as processError, SubagentProcessError } from "../run/errors.ts";
import type { RuntimeApiKey } from "../run/model.ts";
import { attachBoundedLineParser, makeByteBoundedQueueRoom } from "./bounded-line-parser.ts";
import { attachLocalPiParentIpc } from "./local-pi-ipc.ts";
import { terminateProcessTree, terminateProcessTreeEffect } from "./process-tree.ts";
import { decodeUnknownJsonOption } from "./wire-shared.ts";
import type {
  LocalPiContact,
  LocalPiParentControl,
  RpcCommand,
} from "../backend/local-pi-protocol.ts";
import type { SubagentContextMode, SubagentEffort } from "../domain/routing.ts";

const { mkdir, rm, rmdir, writeFile } = nodeFsPromises;
const { join } = nodePath;

const MAX_RPC_LINE_BYTES = 4 * 1024 * 1024;
const MAX_RPC_QUEUED_BYTES = 8 * 1024 * 1024;
const MAX_STDERR_BYTES = 128 * 1024;
const EVENT_CAPACITY = 512;
const TRANSPORT_WRITE_TIMEOUT = "10 seconds";
const RUNTIME_API_KEY_ENV = "PI_SUBAGENT_RUNTIME_API_KEY";
const RUNTIME_API_PROVIDER_ENV = "PI_SUBAGENT_RUNTIME_API_PROVIDER";
const BLOCKED_ENV_KEYS = new Set([
  "NODE_OPTIONS",
  "NODE_PATH",
  "PI_SESSION_FILE",
  "PI_SESSION_ID",
  RUNTIME_API_KEY_ENV,
  RUNTIME_API_PROVIDER_ENV,
]);

export interface ChildLaunchRequest {
  readonly runId: string;
  readonly name: string;
  readonly cwd: string;
  readonly context: SubagentContextMode;
  readonly writeIntent: import("../domain/routing.ts").SubagentWriteIntent;
  readonly openaiFastMode: boolean;
  readonly model: string;
  readonly effort: SubagentEffort;
  readonly runtimeApiKey?: RuntimeApiKey | undefined;
  readonly activeTools: ReadonlyArray<string>;
  readonly projectTrusted: boolean;
  readonly parentSessionId: string;
  readonly parentSessionFile?: string;
  readonly parentLeafId?: string;
  readonly resumeSessionFile?: string | undefined;
  readonly systemPrompt: string;
}

export type ChildWireEvent =
  | { readonly type: "rpc_message"; readonly value: unknown }
  | { readonly type: "parent_contact"; readonly value: LocalPiContact }
  | { readonly type: "protocol_error"; readonly message: string }
  | {
      readonly type: "exit";
      readonly exitCode: number | null;
      readonly signal?: string;
      readonly stderr: string;
    };

export interface ChildProcessHandle {
  readonly pid: number;
  readonly events: Queue.Dequeue<ChildWireEvent, Cause.Done>;
  /** Release byte-weighted transport backlog ownership after one event is processed. */
  readonly acknowledge?: ((event: ChildWireEvent) => void) | undefined;
  readonly awaitExit: Effect.Effect<
    Extract<ChildWireEvent, { readonly type: "exit" }>,
    SubagentProcessError
  >;
  readonly send: (command: RpcCommand) => Effect.Effect<void, SubagentProcessError>;
  readonly sendContactControl: (
    control: LocalPiParentControl,
  ) => Effect.Effect<void, SubagentProcessError>;
  readonly terminate: (mode: "graceful" | "force") => Effect.Effect<void, SubagentProcessError>;
}

export interface ChildProcessContract {
  readonly spawn: (
    request: ChildLaunchRequest,
  ) => Effect.Effect<ChildProcessHandle, SubagentProcessError, Scope.Scope>;
  readonly reclaimRunState: (request: {
    readonly parentSessionId: string;
    readonly runId: string;
  }) => Effect.Effect<void, SubagentProcessError>;
}

export function safeSubagentDirectorySegment(value: string): string {
  if (/^[A-Za-z0-9_-]{1,128}$/.test(value)) return value;
  return `id-${createHash("sha256").update(value).digest("hex").slice(0, 32)}`;
}

export const subagentRunDirectory = (
  agentDirectory: string,
  parentSessionId: string,
  runId: string,
): string =>
  join(
    agentDirectory,
    "subagents",
    safeSubagentDirectorySegment(parentSessionId),
    safeSubagentDirectorySegment(runId),
  );

const reclaimChildRunState = (
  agentDirectory: string,
  request: { readonly parentSessionId: string; readonly runId: string },
) =>
  Effect.tryPromise({
    try: () => {
      const runDirectory = subagentRunDirectory(
        agentDirectory,
        request.parentSessionId,
        request.runId,
      );
      return rm(runDirectory, { recursive: true, force: true }).then(() =>
        rmdir(join(runDirectory, "..")).catch((error) => {
          // SAFETY: The boundary adapter's ownership and validation checks establish this host contract before use.
          const code =
            hasObjectRuntimeType(error) && error !== null && "code" in error
              ? (error as { readonly code?: unknown }).code
              : undefined;
          if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST" && code !== "EBUSY")
            throw error;
        }),
      );
    },
    catch: (error) => processError("reclaim subagent run state", error),
  });

export interface ChildToolPolicy {
  readonly enabled: ReadonlyArray<string>;
  readonly excluded: string;
}

export const childToolPolicy = (rootActiveTools: ReadonlyArray<string>): ChildToolPolicy => ({
  enabled: [...new Set([...rootActiveTools, "contact_parent", ...SUBAGENT_TOOL_NAMES])],
  excluded: PI_CHILD_COMPETING_ORCHESTRATOR_TOOL_ARGUMENT,
});

export const requestCooperativeAbort = (
  send: (command: RpcCommand) => Effect.Effect<void, SubagentProcessError>,
): Effect.Effect<void> =>
  send({ type: "abort" }).pipe(
    Effect.interruptible,
    Effect.timeoutOption("250 millis"),
    Effect.catch(() => Effect.void),
    Effect.asVoid,
  );

export interface ChildProcessReleaseOperations {
  readonly platform: NodeJS.Platform;
  readonly requestAbort: Effect.Effect<void>;
  readonly terminate: (mode: "graceful" | "force") => Effect.Effect<void, SubagentProcessError>;
  readonly awaitExit: Effect.Effect<unknown>;
}

const cleanupUnconfirmed = () =>
  processError(
    "confirm subagent process cleanup",
    new Error("Process exit was not confirmed after forced termination."),
    "cleanup_unconfirmed",
  );

export const releaseChildProcess = (
  operations: ChildProcessReleaseOperations,
): Effect.Effect<void, SubagentProcessError> => {
  const waitForExit = operations.awaitExit.pipe(
    Effect.interruptible,
    Effect.timeoutOption("2 seconds"),
  );
  return operations.requestAbort.pipe(
    Effect.andThen(Effect.sleep("100 millis")),
    Effect.andThen(Effect.exit(operations.terminate("graceful"))),
    Effect.flatMap((gracefulAttempt) =>
      waitForExit.pipe(
        Effect.flatMap((gracefulExit) => {
          if (gracefulExit._tag === "Some") {
            if (operations.platform === "win32")
              return Exit.isSuccess(gracefulAttempt)
                ? Effect.void
                : Effect.fail(cleanupUnconfirmed());
            return Effect.sleep("100 millis").pipe(
              // POSIX descendants remain owned by the detached process group after
              // the leader exits, so complete a force sweep before releasing ownership.
              Effect.andThen(operations.terminate("force")),
            );
          }
          return Effect.exit(operations.terminate("force")).pipe(
            Effect.flatMap((forceAttempt) =>
              waitForExit.pipe(
                Effect.flatMap((forcedExit) =>
                  Exit.isSuccess(forceAttempt) && forcedExit._tag === "Some"
                    ? Effect.void
                    : Effect.fail(cleanupUnconfirmed()),
                ),
              ),
            ),
          );
        }),
      ),
    ),
  );
};

function sanitizedEnvironment(request: ChildLaunchRequest): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([key, value]) => value !== undefined && !BLOCKED_ENV_KEYS.has(key),
      ),
    ),
    PI_SUBAGENT_CHILD: "1",
    PI_SUBAGENT_PARENT_SESSION: request.parentSessionId,
    PI_SUBAGENT_RUN_ID: request.runId,
    ...(request.runtimeApiKey && {
      [RUNTIME_API_KEY_ENV]: Redacted.value(request.runtimeApiKey),
      [RUNTIME_API_PROVIDER_ENV]: request.model.slice(0, request.model.indexOf("/")),
    }),
  };
}

const cloneEntry = (entry: SessionEntry, parentId: string | null): SessionEntry => {
  if (entry.type === "message" && entry.message.role === "assistant") {
    return {
      ...entry,
      parentId,
      message: {
        ...entry.message,
        // Signed/redacted provider thinking blocks are not portable across child models.
        content: entry.message.content.filter((part) => part.type !== "thinking"),
      },
    };
  }
  return { ...entry, parentId };
};

function createForkedSession(request: ChildLaunchRequest, runDir: string): Promise<string> {
  if (!request.parentSessionFile || !request.parentLeafId)
    return Promise.reject(
      new Error("Forked context requires a persisted parent session and stable parent leaf."),
    );
  const source = SessionManager.open(request.parentSessionFile);
  const branch = source.getBranch(request.parentLeafId).filter((entry) => entry.type !== "label");
  if (branch.length === 0)
    return Promise.reject(new Error("The selected parent session branch is empty."));
  const sessionId = randomUUID();
  const sessionFile = join(runDir, `session-${sessionId}.jsonl`);
  const header = {
    type: "session" as const,
    version: 3,
    id: sessionId,
    timestamp: DateTime.formatIso(DateTime.makeUnsafe(synchronousNow())),
    cwd: request.cwd,
    parentSession: request.parentSessionFile,
  };
  let parentId: string | null = null;
  const entries = branch.map((entry) => {
    const cloned = cloneEntry(entry, parentId);
    parentId = cloned.id;
    return cloned;
  });
  const content = [header, ...entries].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
  return writeFile(sessionFile, content, { encoding: "utf8", mode: 0o600 }).then(() => sessionFile);
}

function extensionPath(): string {
  return fileURLToPath(new URL("./host-child.ts", import.meta.url));
}

// Locally constructed RPC command frames are serialized by this pure protocol encoder.
const encodeRpcCommandFrame = (command: RpcCommand): string => `${JSON.stringify(command)}\n`;

const acquireChild = Effect.fn("ChildProcess.acquire")(function* (
  agentDirectory: string,
  request: ChildLaunchRequest,
) {
  const runDir = subagentRunDirectory(agentDirectory, request.parentSessionId, request.runId);
  yield* Effect.tryPromise({
    try: () => mkdir(runDir, { recursive: true, mode: 0o700 }),
    catch: (error) => processError("create subagent run directory", error),
  });
  const promptPath = join(runDir, "system-prompt.md");
  yield* Effect.tryPromise({
    try: () => writeFile(promptPath, request.systemPrompt, { encoding: "utf8", mode: 0o600 }),
    catch: (error) => processError("write subagent system prompt", error),
  });
  const sessionFile =
    request.resumeSessionFile === undefined && request.context === "fork"
      ? yield* Effect.tryPromise({
          try: () => createForkedSession(request, runDir),
          catch: (error) => processError("fork parent session", error),
        })
      : undefined;

  const events = yield* Queue.dropping<ChildWireEvent, Cause.Done>(EVENT_CAPACITY);
  const ready = yield* Deferred.make<void, SubagentProcessError>();
  const exited = yield* Deferred.make<Extract<ChildWireEvent, { readonly type: "exit" }>>();
  const cliEntry = join(getPackageDir(), "dist", "cli.js");
  const toolPolicy = childToolPolicy(request.activeTools);
  const cliArgs = [
    "--mode",
    "rpc",
    "--model",
    request.model,
    "--thinking",
    request.effort,
    ...(request.openaiFastMode ? ["--pi-subagents-fast-mode"] : []),
    "--tools",
    toolPolicy.enabled.join(","),
    "--exclude-tools",
    toolPolicy.excluded,
    "--append-system-prompt",
    promptPath,
    "--name",
    request.name,
    request.projectTrusted ? "--approve" : "--no-approve",
    "--extension",
    extensionPath(),
    ...(request.resumeSessionFile
      ? ["--session", request.resumeSessionFile]
      : sessionFile
        ? ["--session", sessionFile]
        : ["--session-dir", runDir]),
  ];
  const args = [cliEntry, ...cliArgs];
  let stderr = "";
  let settled = false;
  let spawned = false;
  let cleaned = false;
  let eventQueueOverflowed = false;
  let transportBacklogOverflowed = false;
  let stdinError: Error | undefined;

  return yield* Effect.uninterruptible(
    Effect.gen(function* () {
      const child = yield* Effect.try({
        try: () =>
          spawn(process.execPath, args, {
            cwd: request.cwd,
            detached: process.platform !== "win32",
            env: sanitizedEnvironment(request),
            stdio: ["pipe", "pipe", "pipe", "ipc"],
            windowsHide: true,
          }),
        catch: (error) => processError("spawn", error),
      });

      const transportRoom = makeByteBoundedQueueRoom(events, MAX_RPC_QUEUED_BYTES, () => {
        transportBacklogOverflowed = true;
        stderr = `${stderr}\nSubagent RPC event backlog exceeded ${MAX_RPC_QUEUED_BYTES} bytes.`;
        Queue.offerUnsafe(events, {
          type: "protocol_error",
          message: "Subagent RPC event backlog exceeded its byte budget.",
        });
        void terminateProcessTree(child, "force").catch(() => {});
      });
      const offer = (event: ChildWireEvent, bytes = 0) => {
        if (transportRoom.offer(event, bytes)) return;
        if (transportBacklogOverflowed || eventQueueOverflowed) return;
        eventQueueOverflowed = true;
        stderr = `${stderr}\nSubagent event queue exceeded ${EVENT_CAPACITY} pending events.`;
        void terminateProcessTree(child, "force").catch(() => {});
      };
      const onLine = (line: string) => {
        const bytes = Buffer.byteLength(line, "utf8") + 1;
        const decoded = decodeUnknownJsonOption(line);
        if (Option.isSome(decoded)) offer({ type: "rpc_message", value: decoded.value }, bytes);
        else
          offer({ type: "protocol_error", message: "Subagent emitted malformed RPC JSON." }, bytes);
      };
      const detachStdout = child.stdout
        ? attachBoundedLineParser(child.stdout, {
            maxLineBytes: MAX_RPC_LINE_BYTES,
            maxQueuedBytes: MAX_RPC_QUEUED_BYTES,
            onLine,
            onOverflow: () =>
              offer({
                type: "protocol_error",
                message: "Subagent RPC input exceeded its bounded parser budget.",
              }),
          })
        : () => {};
      const onStderr = (chunk: Buffer) => {
        stderr = `${stderr}${chunk.toString("utf8")}`;
        if (Buffer.byteLength(stderr, "utf8") > MAX_STDERR_BYTES)
          stderr = Buffer.from(stderr, "utf8").subarray(-MAX_STDERR_BYTES).toString("utf8");
      };
      const onStdoutError = (error: Error) => {
        onStderr(Buffer.from(`\nSubagent stdout error: ${error.message}\n`, "utf8"));
        offer({ type: "protocol_error", message: "Subagent RPC output stream failed." });
      };
      const onStderrError = (error: Error) => {
        onStderr(Buffer.from(`\nSubagent stderr error: ${error.message}\n`, "utf8"));
        offer({ type: "protocol_error", message: "Subagent diagnostic stream failed." });
      };
      const onStdinError = (error: Error) => {
        stdinError = error;
      };
      const onSpawn = () => {
        spawned = true;
        Deferred.doneUnsafe(ready, Effect.void);
      };
      const ipc = attachLocalPiParentIpc(child, {
        onContact: (contact) => offer({ type: "parent_contact", value: contact }),
        onProtocolError: (message) => offer({ type: "protocol_error", message }),
        onDisconnect: () => {},
      });
      const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
        if (settled) return;
        settled = true;
        const event: Extract<ChildWireEvent, { readonly type: "exit" }> = {
          type: "exit",
          exitCode,
          ...(signal && { signal }),
          stderr,
        };
        Queue.endUnsafe(events);
        Deferred.doneUnsafe(exited, Effect.succeed(event));
      };
      const onError = (error: Error) => {
        Deferred.doneUnsafe(ready, Effect.fail(processError("spawn", error)));
        if (!spawned) finish(null, null);
      };
      const onClose = (code: number | null, signal: NodeJS.Signals | null) => finish(code, signal);
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        detachStdout();
        child.stdout?.off("error", onStdoutError);
        child.stderr?.off("data", onStderr);
        child.stderr?.off("error", onStderrError);
        child.stdin?.off("error", onStdinError);
        child.off("spawn", onSpawn);
        ipc.detach();
        child.off("error", onError);
        child.off("close", onClose);
        child.stdin?.destroy();
        child.stdout?.destroy();
        child.stderr?.destroy();
      };

      child.stdout?.on("error", onStdoutError);
      child.stderr?.on("data", onStderr);
      child.stderr?.on("error", onStderrError);
      child.stdin?.on("error", onStdinError);
      child.once("spawn", onSpawn);
      child.once("error", onError);
      child.once("close", onClose);
      yield* Deferred.await(ready).pipe(Effect.onError(() => Effect.sync(cleanup)));
      const pid = child.pid;
      if (!pid) {
        cleanup();
        return yield* processError("spawn", "Subagent process did not expose a pid.");
      }

      const withWriteTimeout = (
        effect: Effect.Effect<void, SubagentProcessError>,
        operation: string,
      ) =>
        effect.pipe(
          Effect.timeoutOption(TRANSPORT_WRITE_TIMEOUT),
          Effect.flatMap((outcome) =>
            outcome._tag === "Some"
              ? Effect.void
              : Effect.fail(
                  processError(
                    operation,
                    `Subagent transport write exceeded ${TRANSPORT_WRITE_TIMEOUT}; the frame may already have been accepted.`,
                    "transport_outcome_uncertain",
                  ),
                ),
          ),
        );
      const send = (command: RpcCommand) =>
        withWriteTimeout(
          Effect.callback<void, SubagentProcessError>((resume) => {
            const stdin = child.stdin;
            if (!stdin || stdin.destroyed || stdinError) {
              resume(
                Effect.fail(
                  processError(
                    "send RPC command to",
                    stdinError ?? "Subagent RPC input is closed.",
                    "transport_not_sent",
                  ),
                ),
              );
              return;
            }
            let encoded: string;
            try {
              encoded = encodeRpcCommandFrame(command);
              stdin.write(encoded, (error) =>
                resume(
                  error
                    ? Effect.fail(
                        processError("send RPC command to", error, "transport_outcome_uncertain"),
                      )
                    : Effect.void,
                ),
              );
            } catch (error) {
              resume(
                Effect.fail(processError("encode RPC command for", error, "transport_not_sent")),
              );
            }
          }),
          "send RPC command to",
        );
      const terminate = (mode: "graceful" | "force") =>
        terminateProcessTreeEffect(child, mode).pipe(
          Effect.mapError((error) => processError("terminate", error)),
        );
      const releaseActive = releaseChildProcess({
        platform: process.platform,
        requestAbort: requestCooperativeAbort(send),
        terminate,
        awaitExit: Deferred.await(exited),
      });
      const release = releaseActive.pipe(Effect.ensuring(Effect.sync(cleanup)));

      return {
        pid,
        events,
        acknowledge: transportRoom.acknowledge,
        awaitExit: Deferred.await(exited),
        send,
        sendContactControl: ipc.sendControl,
        terminate,
        release,
      };
    }),
  );
});

export class ChildProcess extends Context.Service<ChildProcess, ChildProcessContract>()(
  "pi-subagents/boundary/child-process/ChildProcess",
) {
  static readonly layer = (options: { readonly agentDirectory?: string } = {}) => {
    const agentDirectory = options.agentDirectory ?? getAgentDir();
    return Layer.succeed(this, {
      spawn: (request) =>
        Effect.acquireRelease(acquireChild(agentDirectory, request), (handle) =>
          handle.release.pipe(Effect.orDie),
        ).pipe(Effect.map(({ release: _release, ...handle }) => handle)),
      reclaimRunState: (request) => reclaimChildRunState(agentDirectory, request),
    });
  };
}
