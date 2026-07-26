// Claude Code CLI ownership is intentionally isolated at this Node boundary.
// @effect-diagnostics effect/nodeBuiltinImport:off
// @effect-diagnostics effect/processEnv:off
// @effect-diagnostics effect/cryptoRandomUUID:off
// @effect-diagnostics effect/asyncFunction:off
// @effect-diagnostics effect/newPromise:off
// @effect-diagnostics effect/preferSchemaOverJson:off
import { spawn, type ChildProcess as NodeChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import { SubagentProcessError } from "../run/errors.ts";
import {
  isClaudeModelSelector,
  type SubagentEffort,
  type SubagentWriteIntent,
} from "../run/model.ts";
import { sanitizeDiagnosticText } from "../run/state.ts";
import type { ChildLaunchRequest, ChildProcessHandle, ChildWireEvent } from "./child-process.ts";
import { decodeClaudeInitOption } from "./claude-protocol.ts";

const MAX_STREAM_LINE_BYTES = 4 * 1024 * 1024;
const MAX_STDERR_BYTES = 128 * 1024;
const EVENT_CAPACITY = 512;
const MAX_ERROR_STDERR_CHARS = 8 * 1024;
const TRANSPORT_WRITE_TIMEOUT = "10 seconds";
const CLAUDE_TOOLS = {
  "read-only": ["Read", "Glob", "Grep", "WebFetch", "WebSearch"],
  writer: ["Read", "Glob", "Grep", "Edit", "Write", "Bash", "WebFetch", "WebSearch"],
} as const satisfies Record<SubagentWriteIntent, ReadonlyArray<string>>;
const CLAUDE_DISALLOWED_TOOLS = {
  "read-only": ["Agent", "Task", "Workflow", "Edit", "Write", "Bash", "NotebookEdit", "MultiEdit"],
  writer: ["Agent", "Task", "Workflow"],
} as const satisfies Record<SubagentWriteIntent, ReadonlyArray<string>>;
const CLAUDE_READ_ONLY_TOOLS: ReadonlySet<string> = new Set(CLAUDE_TOOLS["read-only"]);
const BLOCKED_ENV_KEYS = new Set([
  "NODE_OPTIONS",
  "NODE_PATH",
  "PI_SESSION_FILE",
  "PI_SESSION_ID",
  "PI_SUBAGENT_RUNTIME_API_KEY",
  "PI_SUBAGENT_RUNTIME_API_PROVIDER",
]);

const processError = (operation: string, error?: unknown) =>
  new SubagentProcessError({
    operation,
    message:
      error instanceof Error
        ? error.message
        : typeof error === "string"
          ? error
          : `Unable to ${operation} Claude Code process.`,
  });

const claudeEffort = (effort: SubagentEffort): "low" | "medium" | "high" | "xhigh" | "max" =>
  effort === "off" || effort === "minimal" ? "low" : effort;

export function buildClaudeCliArgs(
  request: ChildLaunchRequest,
  sessionId: string,
): ReadonlyArray<string> {
  const tools = CLAUDE_TOOLS[request.writeIntent];
  const disallowedTools = CLAUDE_DISALLOWED_TOOLS[request.writeIntent];
  return [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    request.model,
    "--effort",
    claudeEffort(request.effort),
    ...(request.resumeSessionId
      ? ["--resume", request.resumeSessionId]
      : ["--session-id", sessionId]),
    "--name",
    request.name,
    "--safe-mode",
    "--no-chrome",
    "--permission-mode",
    "dontAsk",
    "--tools",
    tools.join(","),
    "--allowedTools",
    tools.join(","),
    "--disallowedTools",
    disallowedTools.join(","),
    "--strict-mcp-config",
    "--append-system-prompt",
    request.systemPrompt,
  ];
}

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
  };
}

async function terminateTree(child: NodeChildProcess, force: boolean): Promise<void> {
  const pid = child.pid;
  if (!pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    await new Promise<void>((resolve, reject) => {
      const killer = spawn("taskkill", ["/pid", String(pid), "/T", ...(force ? ["/F"] : [])], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.once("error", reject);
      killer.once("close", (code) =>
        code === 0 || child.exitCode !== null
          ? resolve()
          : reject(new Error(`taskkill exited ${code}`)),
      );
    });
    return;
  }
  const signal = force ? "SIGKILL" : "SIGTERM";
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (!child.kill(signal)) throw error;
  }
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
    if (Buffer.byteLength(buffered, "utf8") > MAX_STREAM_LINE_BYTES) {
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

export interface ClaudeProcessOptions {
  readonly command?: string | undefined;
  readonly commandArgs?: ReadonlyArray<string> | undefined;
}

export const acquireClaudeChild = Effect.fn("ClaudeProcess.acquire")(function* (
  request: ChildLaunchRequest,
  options: ClaudeProcessOptions = {},
) {
  if (!request.projectTrusted)
    return yield* processError("launch", "Claude Code print mode requires a trusted project.");
  if (!isClaudeModelSelector(request.model))
    return yield* processError(
      "launch",
      "Claude model must be an alias or full model ID of at most 128 characters.",
    );
  const events = yield* Queue.dropping<ChildWireEvent, Cause.Done>(EVENT_CAPACITY);
  const ready = yield* Deferred.make<void, SubagentProcessError>();
  const initialized = yield* Deferred.make<
    { readonly sessionId: string; readonly model?: string | undefined },
    SubagentProcessError
  >();
  const exited = yield* Deferred.make<Extract<ChildWireEvent, { readonly type: "exit" }>>();
  const sessionId = request.resumeSessionId ?? randomUUID();
  const args = buildClaudeCliArgs(request, sessionId);
  let stderr = "";
  let spawned = false;
  let settled = false;
  let cleaned = false;
  let overflowed = false;
  let stdinError: Error | undefined;

  return yield* Effect.uninterruptible(
    Effect.gen(function* () {
      const child = yield* Effect.try({
        try: () =>
          spawn(options.command ?? "claude", [...(options.commandArgs ?? []), ...args], {
            cwd: request.cwd,
            detached: process.platform !== "win32",
            env: sanitizedEnvironment(request),
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
          }),
        catch: (error) => processError("spawn", error),
      });

      const offer = (event: ChildWireEvent) => {
        if (Queue.offerUnsafe(events, event) || overflowed) return;
        overflowed = true;
        stderr = `${stderr}\nClaude event queue exceeded ${EVENT_CAPACITY} pending events.`;
        void terminateTree(child, true).catch(() => {});
      };
      const onLine = (line: string) => {
        try {
          const value = JSON.parse(line) as unknown;
          const init = decodeClaudeInitOption(value);
          if (init) {
            if (request.writeIntent === "read-only") {
              const unexpectedTools = init.tools?.filter(
                (tool) => !CLAUDE_READ_ONLY_TOOLS.has(tool),
              );
              const policyError =
                init.tools === undefined
                  ? processError(
                      "verify Claude tool policy",
                      "Claude did not report its resolved tool set for a read-only run.",
                    )
                  : unexpectedTools && unexpectedTools.length > 0
                    ? processError(
                        "verify Claude tool policy",
                        `Claude enabled unexpected read-only tools: ${unexpectedTools.slice(0, 16).join(", ")}${unexpectedTools.length > 16 ? ", …" : ""}.`,
                      )
                    : undefined;
              if (policyError) {
                Deferred.doneUnsafe(initialized, Effect.fail(policyError));
                void terminateTree(child, true).catch(() => {});
              } else {
                Deferred.doneUnsafe(
                  initialized,
                  Effect.succeed({
                    sessionId: init.session_id,
                    ...(init.model ? { model: init.model } : {}),
                  }),
                );
              }
            } else {
              Deferred.doneUnsafe(
                initialized,
                Effect.succeed({
                  sessionId: init.session_id,
                  ...(init.model ? { model: init.model } : {}),
                }),
              );
            }
          }
          offer({ type: "claude_message", value });
        } catch {
          if (!Deferred.isDoneUnsafe(initialized)) {
            Deferred.doneUnsafe(
              initialized,
              Effect.fail(
                processError("initialize stream", "Claude emitted malformed stream JSON."),
              ),
            );
            void terminateTree(child, true).catch(() => {});
            return;
          }
          offer({ type: "protocol_error", message: "Claude emitted malformed stream JSON." });
        }
      };
      const onStdoutOverflow = () => {
        if (!Deferred.isDoneUnsafe(initialized)) {
          Deferred.doneUnsafe(
            initialized,
            Effect.fail(
              processError("initialize stream", "Claude stream JSON line exceeded 4 MiB."),
            ),
          );
          void terminateTree(child, true).catch(() => {});
          return;
        }
        offer({ type: "protocol_error", message: "Claude stream JSON line exceeded 4 MiB." });
      };
      const detachStdout = child.stdout
        ? appendLineParser(child.stdout, onLine, onStdoutOverflow)
        : () => {};
      const onStderr = (chunk: Buffer) => {
        stderr = `${stderr}${chunk.toString("utf8")}`;
        if (Buffer.byteLength(stderr, "utf8") > MAX_STDERR_BYTES)
          stderr = Buffer.from(stderr, "utf8").subarray(-MAX_STDERR_BYTES).toString("utf8");
      };
      const onStdoutError = (error: Error) => {
        onStderr(Buffer.from(`\nClaude stdout error: ${error.message}\n`, "utf8"));
        offer({ type: "protocol_error", message: "Claude output stream failed." });
      };
      const onStderrError = (error: Error) => {
        onStderr(Buffer.from(`\nClaude stderr error: ${error.message}\n`, "utf8"));
        offer({ type: "protocol_error", message: "Claude diagnostic stream failed." });
      };
      const withStderr = (message: string) => {
        const detail = sanitizeDiagnosticText(stderr.trim(), MAX_ERROR_STDERR_CHARS);
        return detail ? `${message}\n${detail}` : message;
      };
      const onStdinError = (error: Error) => {
        stdinError = error;
      };
      const onSpawn = () => {
        spawned = true;
        Deferred.doneUnsafe(ready, Effect.void);
      };
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
        Deferred.doneUnsafe(
          initialized,
          Effect.fail(
            processError(
              "initialize",
              withStderr(
                "Claude Code exited before its system/init event; check CLI authentication and model availability.",
              ),
            ),
          ),
        );
        Deferred.doneUnsafe(exited, Effect.succeed(event));
      };
      const onError = (error: Error) => {
        Deferred.doneUnsafe(ready, Effect.fail(processError("spawn", error)));
        if (!spawned) finish(null, null);
        else onStderr(Buffer.from(`\nClaude process error: ${error.message}\n`, "utf8"));
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
        return yield* processError("spawn", "Claude Code did not expose a pid.");
      }

      const writeLine = (value: unknown) =>
        Effect.callback<void, SubagentProcessError>((resume) => {
          const stdin = child.stdin;
          if (!stdin || stdin.destroyed || stdinError) {
            const message = stdinError?.message ?? "Claude stdin is closed.";
            resume(Effect.fail(processError("write to", withStderr(message))));
            return;
          }
          try {
            stdin.write(`${JSON.stringify(value)}\n`, (error) =>
              resume(
                error
                  ? Effect.fail(processError("write to", withStderr(error.message)))
                  : Effect.void,
              ),
            );
          } catch (error) {
            resume(Effect.fail(processError("encode input for", error)));
          }
        }).pipe(
          Effect.timeoutOption(TRANSPORT_WRITE_TIMEOUT),
          Effect.flatMap((outcome) =>
            outcome._tag === "Some"
              ? Effect.void
              : Effect.fail(processError("write to", "Claude stdin write timed out.")),
          ),
        );
      const respond = (
        command: import("../run/protocol.ts").RpcCommand,
        success: boolean,
        data?: unknown,
        error?: string,
      ) =>
        Effect.sync(() => {
          offer({
            type: "rpc_message",
            value: {
              type: "response",
              id: command.id,
              command: command.type,
              success,
              ...(data === undefined ? {} : { data }),
              ...(error ? { error } : {}),
            },
          });
        });
      const send: ChildProcessHandle["send"] = (command) => {
        switch (command.type) {
          case "get_state":
            return Deferred.await(initialized).pipe(
              Effect.flatMap((init) =>
                respond(command, true, {
                  sessionId: init.sessionId,
                  ...(init.model ? { model: init.model } : {}),
                  thinkingLevel: claudeEffort(request.effort),
                }),
              ),
            );
          case "prompt": {
            const message = typeof command.message === "string" ? command.message : "";
            return Deferred.await(initialized).pipe(
              Effect.flatMap(() =>
                writeLine({
                  type: "user",
                  message: { role: "user", content: message },
                  parent_tool_use_id: null,
                  session_id: sessionId,
                }),
              ),
              Effect.andThen(respond(command, true)),
            );
          }
          default:
            return respond(
              command,
              false,
              undefined,
              `Claude CLI backend does not support ${command.type}.`,
            );
        }
      };
      const sendIpc: ChildProcessHandle["sendIpc"] = () =>
        Effect.fail(processError("send IPC to", "Claude CLI parent contact is not enabled."));
      const terminate: ChildProcessHandle["terminate"] = (mode) =>
        Effect.suspend(() =>
          settled
            ? Effect.void
            : Effect.tryPromise({
                try: () => terminateTree(child, mode === "force"),
                catch: (error) => processError("terminate", error),
              }),
        );
      const waitForExit = Deferred.await(exited).pipe(
        Effect.interruptible,
        Effect.timeoutOption("2 seconds"),
      );
      const releaseActive = terminate("graceful").pipe(
        Effect.catch(() => Effect.void),
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
                        "Claude Code did not report closure after forced termination.",
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
