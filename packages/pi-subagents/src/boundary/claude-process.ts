// Claude Code CLI ownership is intentionally isolated at this Node boundary.
// @effect-diagnostics effect/nodeBuiltinImport:off
// @effect-diagnostics effect/processEnv:off
// @effect-diagnostics effect/cryptoRandomUUID:off
// @effect-diagnostics effect/asyncFunction:off
// @effect-diagnostics effect/newPromise:off
// @effect-diagnostics effect/preferSchemaOverJson:off
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
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
import { attachBoundedLineParser, makeByteBoundedQueueRoom } from "./bounded-line-parser.ts";
import type { ChildLaunchRequest, ChildProcessHandle, ChildWireEvent } from "./child-process.ts";
import { decodeClaudeInitOption } from "./claude-protocol.ts";
import { terminateProcessTree } from "./process-tree.ts";

const MAX_STREAM_LINE_BYTES = 4 * 1024 * 1024;
const MAX_STREAM_QUEUED_BYTES = 8 * 1024 * 1024;
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
const BLOCKED_ENV_KEYS = new Set([
  "NODE_OPTIONS",
  "NODE_PATH",
  "PI_SESSION_FILE",
  "PI_SESSION_ID",
  "PI_SUBAGENT_RUNTIME_API_KEY",
  "PI_SUBAGENT_RUNTIME_API_PROVIDER",
]);

const processError = (operation: string, error?: unknown, code?: string) =>
  new SubagentProcessError({
    operation,
    message:
      error instanceof Error
        ? error.message
        : typeof error === "string"
          ? error
          : `Unable to ${operation} Claude Code process.`,
    ...(code ? { code } : {}),
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

function resolvedToolPolicyError(
  writeIntent: SubagentWriteIntent,
  reportedTools: ReadonlyArray<string> | undefined,
): SubagentProcessError | undefined {
  if (reportedTools === undefined)
    return processError(
      "verify Claude tool policy",
      `Claude did not report its resolved tool set for a ${writeIntent} run.`,
    );
  const expected = new Set<string>(CLAUDE_TOOLS[writeIntent]);
  const reported = new Set(reportedTools);
  const missing = [...expected].filter((tool) => !reported.has(tool));
  const unexpected = [...reported].filter((tool) => !expected.has(tool));
  if (missing.length === 0 && unexpected.length === 0) return undefined;
  const details = [
    ...(missing.length > 0 ? [`missing: ${missing.slice(0, 16).join(", ")}`] : []),
    ...(unexpected.length > 0
      ? [`unexpected: ${unexpected.slice(0, 16).join(", ")}${unexpected.length > 16 ? ", …" : ""}`]
      : []),
  ].join("; ");
  return processError(
    "verify Claude tool policy",
    `Claude resolved an invalid ${writeIntent} tool set (${details}).`,
  );
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
      'Claude model must be fable, sonnet, opus, haiku, or a full model ID beginning with "claude" (at most 128 characters).',
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
  let eventQueueOverflowed = false;
  let transportBacklogOverflowed = false;
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

      const transportRoom = makeByteBoundedQueueRoom(events, MAX_STREAM_QUEUED_BYTES, () => {
        transportBacklogOverflowed = true;
        stderr = `${stderr}\nClaude event backlog exceeded ${MAX_STREAM_QUEUED_BYTES} bytes.`;
        Queue.offerUnsafe(events, {
          type: "protocol_error",
          message: "Claude event backlog exceeded its byte budget.",
        });
        void terminateProcessTree(child, "force").catch(() => {});
      });
      const offer = (event: ChildWireEvent, bytes = 0) => {
        if (transportRoom.offer(event, bytes)) return;
        if (transportBacklogOverflowed || eventQueueOverflowed) return;
        eventQueueOverflowed = true;
        stderr = `${stderr}\nClaude event queue exceeded ${EVENT_CAPACITY} pending events.`;
        void terminateProcessTree(child, "force").catch(() => {});
      };
      const onLine = (line: string) => {
        const bytes = Buffer.byteLength(line, "utf8") + 1;
        try {
          const value = JSON.parse(line) as unknown;
          const isInitEnvelope =
            typeof value === "object" &&
            value !== null &&
            "type" in value &&
            value.type === "system" &&
            "subtype" in value &&
            value.subtype === "init";
          const init = decodeClaudeInitOption(value);
          if (isInitEnvelope && !init) {
            Deferred.doneUnsafe(
              initialized,
              Effect.fail(
                processError(
                  "validate Claude initialization",
                  "Claude emitted invalid system/init data; session_id must be a non-empty string.",
                ),
              ),
            );
            void terminateProcessTree(child, "force").catch(() => {});
            return;
          }
          if (init) {
            const policyError = resolvedToolPolicyError(request.writeIntent, init.tools);
            if (policyError) {
              Deferred.doneUnsafe(initialized, Effect.fail(policyError));
              void terminateProcessTree(child, "force").catch(() => {});
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
          offer({ type: "claude_message", value }, bytes);
        } catch {
          if (!Deferred.isDoneUnsafe(initialized)) {
            Deferred.doneUnsafe(
              initialized,
              Effect.fail(
                processError("initialize stream", "Claude emitted malformed stream JSON."),
              ),
            );
            void terminateProcessTree(child, "force").catch(() => {});
            return;
          }
          offer(
            { type: "protocol_error", message: "Claude emitted malformed stream JSON." },
            bytes,
          );
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
          void terminateProcessTree(child, "force").catch(() => {});
          return;
        }
        offer({ type: "protocol_error", message: "Claude stream JSON line exceeded 4 MiB." });
      };
      const detachStdout = child.stdout
        ? attachBoundedLineParser(child.stdout, {
            maxLineBytes: MAX_STREAM_LINE_BYTES,
            maxQueuedBytes: MAX_STREAM_QUEUED_BYTES,
            onLine,
            onOverflow: onStdoutOverflow,
          })
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
            resume(
              Effect.fail(processError("write to", withStderr(message), "transport_not_sent")),
            );
            return;
          }
          try {
            stdin.write(`${JSON.stringify(value)}\n`, (error) =>
              resume(
                error
                  ? Effect.fail(
                      processError(
                        "write to",
                        withStderr(error.message),
                        "transport_outcome_uncertain",
                      ),
                    )
                  : Effect.void,
              ),
            );
          } catch (error) {
            resume(Effect.fail(processError("encode input for", error, "transport_not_sent")));
          }
        }).pipe(
          Effect.timeoutOption(TRANSPORT_WRITE_TIMEOUT),
          Effect.flatMap((outcome) =>
            outcome._tag === "Some"
              ? Effect.void
              : Effect.fail(
                  processError(
                    "write to",
                    "Claude stdin write timed out; the frame may already have been accepted.",
                    "transport_outcome_uncertain",
                  ),
                ),
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
            // Claude stream-json emits system/init only after its first user frame.
            return writeLine({
              type: "user",
              message: { role: "user", content: message },
              parent_tool_use_id: null,
              session_id: sessionId,
            }).pipe(Effect.andThen(respond(command, true)));
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
        Effect.tryPromise({
          try: () => terminateProcessTree(child, mode),
          catch: (error) => processError("terminate", error),
        });
      const waitForExit = Deferred.await(exited).pipe(
        Effect.interruptible,
        Effect.timeoutOption("2 seconds"),
      );
      const releaseActive = terminate("graceful").pipe(
        Effect.catch(() => Effect.void),
        Effect.andThen(waitForExit),
        Effect.flatMap((gracefulExit) =>
          gracefulExit._tag === "Some"
            ? process.platform === "win32"
              ? Effect.void
              : Effect.sleep("100 millis").pipe(
                  // POSIX descendants remain owned by the detached process group.
                  Effect.andThen(terminate("force").pipe(Effect.catch(() => Effect.void))),
                )
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
      const release = releaseActive.pipe(Effect.ensuring(Effect.sync(cleanup)));

      return {
        pid,
        events,
        acknowledge: transportRoom.acknowledge,
        awaitExit: Deferred.await(exited),
        send,
        sendIpc,
        terminate,
        release,
      };
    }),
  );
});
