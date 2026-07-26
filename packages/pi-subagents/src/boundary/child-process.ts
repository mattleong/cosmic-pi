// Node process and session-file ownership is intentionally isolated at this boundary.
// @effect-diagnostics effect/nodeBuiltinImport:off
// @effect-diagnostics effect/processEnv:off
// @effect-diagnostics effect/cryptoRandomUUID:off
// @effect-diagnostics effect/asyncFunction:off
// @effect-diagnostics effect/newPromise:off
// @effect-diagnostics effect/globalDate:off
// @effect-diagnostics effect/preferSchemaOverJson:off
import { spawn, type ChildProcess as NodeChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import {
  getAgentDir,
  getPackageDir,
  SessionManager,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import { piToolsForWriteIntent } from "../run/coordination.ts";
import { SubagentProcessError } from "../run/errors.ts";
import { acquireClaudeChild } from "./claude-process.ts";
import type { ParentReply, PeerNotice, RpcCommand } from "../run/protocol.ts";
import type { SubagentContextMode, SubagentEffort } from "../run/model.ts";

const MAX_RPC_LINE_BYTES = 4 * 1024 * 1024;
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
  readonly backend: import("../run/model.ts").SubagentBackend;
  readonly cwd: string;
  readonly context: SubagentContextMode;
  readonly writeIntent: import("../run/model.ts").SubagentWriteIntent;
  readonly model: string;
  readonly effort: SubagentEffort;
  readonly runtimeApiKey?: string | undefined;
  readonly activeTools: ReadonlyArray<string>;
  readonly projectTrusted: boolean;
  readonly parentSessionId: string;
  readonly parentSessionFile?: string;
  readonly parentLeafId?: string;
  readonly resumeSessionFile?: string | undefined;
  readonly resumeSessionId?: string | undefined;
  readonly systemPrompt: string;
}

export type ChildWireEvent =
  | { readonly type: "rpc_message"; readonly value: unknown }
  | { readonly type: "ipc_message"; readonly value: unknown }
  | { readonly type: "claude_message"; readonly value: unknown }
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
  readonly awaitExit: Effect.Effect<Extract<ChildWireEvent, { readonly type: "exit" }>>;
  readonly send: (command: RpcCommand) => Effect.Effect<void, SubagentProcessError>;
  readonly sendIpc: (
    message: ParentReply | PeerNotice,
  ) => Effect.Effect<void, SubagentProcessError>;
  readonly terminate: (mode: "graceful" | "force") => Effect.Effect<void, SubagentProcessError>;
}

export interface ChildProcessShape {
  readonly spawn: (
    request: ChildLaunchRequest,
  ) => Effect.Effect<ChildProcessHandle, SubagentProcessError, Scope.Scope>;
}

const processError = (operation: string, error?: unknown) =>
  new SubagentProcessError({
    operation,
    message:
      error instanceof Error
        ? error.message
        : typeof error === "string"
          ? error
          : `Unable to ${operation} subagent process.`,
  });

export function safeSubagentDirectorySegment(value: string): string {
  if (/^[A-Za-z0-9_-]{1,128}$/.test(value)) return value;
  return `id-${createHash("sha256").update(value).digest("hex").slice(0, 32)}`;
}

export const requestCooperativeAbort = (
  send: (command: RpcCommand) => Effect.Effect<void, SubagentProcessError>,
): Effect.Effect<void> =>
  send({ type: "abort" }).pipe(
    Effect.interruptible,
    Effect.timeoutOption("250 millis"),
    Effect.catch(() => Effect.void),
    Effect.asVoid,
  );

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
    ...(request.runtimeApiKey
      ? {
          [RUNTIME_API_KEY_ENV]: request.runtimeApiKey,
          [RUNTIME_API_PROVIDER_ENV]: request.model.slice(0, request.model.indexOf("/")),
        }
      : {}),
  };
}

async function terminateTree(child: NodeChildProcess, mode: "graceful" | "force"): Promise<void> {
  const pid = child.pid;
  if (!pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    await new Promise<void>((resolve, reject) => {
      const killer = spawn(
        "taskkill",
        ["/pid", String(pid), "/T", ...(mode === "force" ? ["/F"] : [])],
        { stdio: "ignore", windowsHide: true },
      );
      killer.once("error", reject);
      killer.once("close", (code) => {
        if (code === 0 || child.exitCode !== null || child.signalCode !== null) resolve();
        else reject(new Error(`taskkill exited with code ${code ?? "unknown"}.`));
      });
    });
    return;
  }
  const signal = mode === "force" ? "SIGKILL" : "SIGTERM";
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      if (!child.kill(signal)) throw error;
    } catch {
      throw error;
    }
  }
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

async function createForkedSession(request: ChildLaunchRequest, runDir: string): Promise<string> {
  if (!request.parentSessionFile || !request.parentLeafId)
    throw new Error("Forked context requires a persisted parent session and stable parent leaf.");
  const source = SessionManager.open(request.parentSessionFile);
  const branch = source.getBranch(request.parentLeafId).filter((entry) => entry.type !== "label");
  if (branch.length === 0) throw new Error("The selected parent session branch is empty.");
  const sessionId = randomUUID();
  const sessionFile = join(runDir, `session-${sessionId}.jsonl`);
  const header = {
    type: "session" as const,
    version: 3,
    id: sessionId,
    timestamp: new Date().toISOString(),
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
  await writeFile(sessionFile, content, { encoding: "utf8", mode: 0o600 });
  return sessionFile;
}

function extensionPath(): string {
  return fileURLToPath(new URL("./host-child.ts", import.meta.url));
}

function appendLineParser(
  stream: NodeJS.ReadableStream,
  onLine: (line: string) => void,
  onOverflow: () => void,
): () => void {
  const decoder = new StringDecoder("utf8");
  let buffered = "";
  let overflowed = false;
  const onData = (chunk: Buffer) => {
    if (overflowed) return;
    buffered += decoder.write(chunk);
    if (Buffer.byteLength(buffered, "utf8") > MAX_RPC_LINE_BYTES) {
      overflowed = true;
      buffered = "";
      onOverflow();
      return;
    }
    while (true) {
      const index = buffered.indexOf("\n");
      if (index < 0) break;
      let line = buffered.slice(0, index);
      buffered = buffered.slice(index + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line) onLine(line);
    }
  };
  stream.on("data", onData);
  return () => stream.off("data", onData);
}

const acquireChild = Effect.fn("ChildProcess.acquire")(function* (request: ChildLaunchRequest) {
  const runDir = join(
    getAgentDir(),
    "subagents",
    safeSubagentDirectorySegment(request.parentSessionId),
    safeSubagentDirectorySegment(request.runId),
  );
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
  const activeTools = piToolsForWriteIntent(request.activeTools, request.writeIntent);
  const cliArgs = [
    "--mode",
    "rpc",
    "--model",
    request.model,
    "--thinking",
    request.effort,
    "--tools",
    [...new Set([...activeTools, "contact_parent"])].join(","),
    "--exclude-tools",
    "subagent,subagent_wait,subagent_supervisor,workflow,workflow_control",
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
  let overflowed = false;
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

      const offer = (event: ChildWireEvent) => {
        if (Queue.offerUnsafe(events, event) || overflowed) return;
        overflowed = true;
        stderr = `${stderr}\nSubagent event queue exceeded ${EVENT_CAPACITY} pending events.`;
        void terminateTree(child, "force").catch(() => {});
      };
      const onLine = (line: string) => {
        try {
          offer({ type: "rpc_message", value: JSON.parse(line) as unknown });
        } catch {
          offer({ type: "protocol_error", message: "Subagent emitted malformed RPC JSON." });
        }
      };
      const detachStdout = child.stdout
        ? appendLineParser(child.stdout, onLine, () =>
            offer({ type: "protocol_error", message: "Subagent RPC line exceeded 4 MiB." }),
          )
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
      const onMessage = (message: unknown) => offer({ type: "ipc_message", value: message });
      const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
        if (settled) return;
        settled = true;
        const event: Extract<ChildWireEvent, { readonly type: "exit" }> = {
          type: "exit",
          exitCode,
          ...(signal ? { signal } : {}),
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
        child.off("message", onMessage);
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
      child.on("message", onMessage);
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
                    `Subagent transport write exceeded ${TRANSPORT_WRITE_TIMEOUT}.`,
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
                  ),
                ),
              );
              return;
            }
            let encoded: string;
            try {
              encoded = `${JSON.stringify(command)}\n`;
              stdin.write(encoded, (error) =>
                resume(
                  error ? Effect.fail(processError("send RPC command to", error)) : Effect.void,
                ),
              );
            } catch (error) {
              resume(Effect.fail(processError("encode RPC command for", error)));
            }
          }),
          "send RPC command to",
        );
      const sendIpc = (message: ParentReply | PeerNotice) =>
        withWriteTimeout(
          Effect.callback<void, SubagentProcessError>((resume) => {
            if (!child.connected) {
              resume(Effect.fail(processError("send IPC message to", "Subagent IPC is closed.")));
              return;
            }
            try {
              child.send(message, (error) =>
                resume(
                  error ? Effect.fail(processError("send IPC message to", error)) : Effect.void,
                ),
              );
            } catch (error) {
              resume(Effect.fail(processError("send IPC message to", error)));
            }
          }),
          "send IPC message to",
        );
      const terminate = (mode: "graceful" | "force") =>
        Effect.suspend(() =>
          settled
            ? Effect.void
            : Effect.tryPromise({
                try: () => terminateTree(child, mode),
                catch: (error) => processError("terminate", error),
              }),
        );
      const waitForExit = Deferred.await(exited).pipe(
        Effect.interruptible,
        Effect.timeoutOption("2 seconds"),
      );
      const releaseActive = requestCooperativeAbort(send).pipe(
        Effect.andThen(Effect.sleep("100 millis")),
        Effect.andThen(terminate("graceful").pipe(Effect.catch(() => Effect.void))),
        Effect.andThen(waitForExit),
        Effect.flatMap((gracefulExit) =>
          gracefulExit._tag === "Some"
            ? Effect.void
            : terminate("force").pipe(
                Effect.catch(() => Effect.void),
                Effect.andThen(waitForExit),
                Effect.flatMap((forcedExit) =>
                  forcedExit._tag === "Some"
                    ? Effect.void
                    : Effect.logWarning(
                        "Subagent process did not report closure after forced termination.",
                      ),
                ),
              ),
        ),
      );
      const release = Effect.suspend(() => (settled ? Effect.void : releaseActive)).pipe(
        Effect.ensuring(Effect.sync(cleanup)),
      );

      return {
        pid,
        events,
        awaitExit: Deferred.await(exited),
        send,
        sendIpc,
        terminate,
        release,
      };
    }),
  );
});

export const acquirePiChild = acquireChild;

export class ChildProcess extends Context.Service<ChildProcess, ChildProcessShape>()(
  "pi-subagents/boundary/child-process/ChildProcess",
) {
  static readonly layer = Layer.succeed(this, {
    spawn: (request) =>
      request.backend === "claude-cli"
        ? Effect.acquireRelease(acquireClaudeChild(request), (handle) => handle.release).pipe(
            Effect.map(({ release: _release, ...handle }) => handle),
          )
        : Effect.acquireRelease(acquireChild(request), (handle) => handle.release).pipe(
            Effect.map(({ release: _release, ...handle }) => handle),
          ),
  });
}
