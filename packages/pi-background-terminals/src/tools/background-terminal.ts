// Pi tool execution is a Promise-shaped host boundary.
// @effect-diagnostics effect/asyncFunction:off
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateTail,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import { Type, type Static } from "typebox";
import { BackgroundTerminalService, type BackgroundJobFilter } from "../job/service.ts";
import { InvalidBackgroundCommandError } from "../job/errors.ts";
import type { BackgroundJobSnapshot, BackgroundLogSlice } from "../job/model.ts";
import { sanitizeTerminalLine, sanitizeTerminalText } from "../ui/sanitize.ts";

const ACTIONS = ["start", "list", "status", "logs", "stop", "stop_all", "clear"] as const;

const parameters = Type.Object({
  action: StringEnum(ACTIONS, { description: "Background terminal operation" }),
  command: Type.Optional(Type.String({ description: "Shell command for start" })),
  cwd: Type.Optional(
    Type.String({
      description: "Working directory for start, relative to the session cwd by default",
    }),
  ),
  name: Type.Optional(Type.String({ description: "Short optional display name" })),
  timeoutSeconds: Type.Optional(
    Type.Number({
      minimum: 0.001,
      description: "Optional runtime limit; omitted means no timeout",
    }),
  ),
  id: Type.Optional(Type.String({ description: "Job ID for status, logs, or stop" })),
  state: Type.Optional(
    StringEnum(["active", "completed", "all"] as const, { description: "List filter" }),
  ),
  afterCursor: Type.Optional(
    Type.Integer({ minimum: 0, description: "Return logs after this cursor" }),
  ),
  tailLines: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 2000,
      description: "Tail lines when no cursor is supplied",
    }),
  ),
  waitSeconds: Type.Optional(
    Type.Number({ minimum: 0, maximum: 30, description: "Long-poll wait for newer logs" }),
  ),
  force: Type.Optional(Type.Boolean({ description: "Force immediate process-tree termination" })),
});

export type BackgroundTerminalToolInput = Static<typeof parameters>;

export interface BackgroundTerminalToolDetails {
  readonly action: (typeof ACTIONS)[number];
  readonly snapshot?: BackgroundJobSnapshot;
  readonly jobs?: ReadonlyArray<BackgroundJobSnapshot>;
  readonly logs?: BackgroundLogSlice;
  readonly removed?: number;
  readonly truncation?: ReturnType<typeof truncateTail>;
}

const required = (
  value: string | undefined,
  field: string,
): Effect.Effect<string, InvalidBackgroundCommandError> =>
  value?.trim()
    ? Effect.succeed(value.trim())
    : new InvalidBackgroundCommandError({
        message: `${field} is required for this background_terminal action.`,
      });

const formatJob = (job: BackgroundJobSnapshot) => {
  const suffix = job.exitCode === undefined ? "" : ` code=${job.exitCode ?? "null"}`;
  return sanitizeTerminalLine(
    `${job.id}${job.name ? ` ${job.name}` : ""} ${job.state}${suffix} — ${job.command}`,
  );
};

const formatLogs = (slice: BackgroundLogSlice) => {
  const content = sanitizeTerminalText(
    slice.events
      .map((event) => `${event.stream === "stderr" ? "[stderr] " : ""}${event.text}`)
      .join(""),
  );
  const truncation = truncateTail(content, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });
  const metadata = `[${slice.id} state=${slice.state} cursor=${slice.nextCursor} earliest=${slice.earliestAvailableCursor}]\n`;
  const gap = slice.droppedBytes > 0 ? `[${slice.droppedBytes} earlier log bytes discarded]\n` : "";
  return { text: `${metadata}${gap}${truncation.content || "(no new output)"}`, truncation };
};

export interface BackgroundTerminalToolRunner {
  readonly run: <A, E>(
    effect: Effect.Effect<A, E, BackgroundTerminalService | Path.Path>,
    signal?: AbortSignal,
  ) => Promise<A>;
}

export function registerBackgroundTerminalTool(
  pi: ExtensionAPI,
  runner: BackgroundTerminalToolRunner,
): void {
  pi.registerTool({
    name: "background_terminal",
    label: "Background Terminal",
    description:
      "Start and manage session-scoped local background commands. Actions: start, list, status, logs, stop, stop_all, clear. Output is bounded; jobs are terminated when the Pi session closes.",
    promptSnippet: "Start and manage long-running local commands without blocking the current turn",
    promptGuidelines: [
      "The main agent should use background_terminal when a server, watcher, long test suite, or other command can run independently; use bash when the next step immediately depends on completion.",
      "Use background_terminal log cursors and waitSeconds instead of repeatedly polling at fixed intervals.",
      "Stop background_terminal jobs when they are no longer needed; every job is terminated when the Pi session is replaced or shut down.",
    ],
    parameters,
    async execute(_toolCallId, input, signal, _onUpdate, ctx) {
      const result = await runner.run(
        Effect.gen(function* () {
          const service = yield* BackgroundTerminalService;
          const path = yield* Path.Path;
          switch (input.action) {
            case "start": {
              const command = yield* required(input.command, "command");
              const cwd = path.resolve(ctx.cwd, input.cwd ?? ".");
              const snapshot = yield* service.start({
                command,
                cwd,
                ...(input.name ? { name: input.name } : {}),
                ...(input.timeoutSeconds !== undefined
                  ? { timeoutSeconds: input.timeoutSeconds }
                  : {}),
              });
              return {
                content: `Started ${formatJob(snapshot)}`,
                details: { action: input.action, snapshot } satisfies BackgroundTerminalToolDetails,
              };
            }
            case "list": {
              const jobs = yield* service.list((input.state ?? "all") as BackgroundJobFilter);
              return {
                content: jobs.length > 0 ? jobs.map(formatJob).join("\n") : "No background jobs.",
                details: { action: input.action, jobs } satisfies BackgroundTerminalToolDetails,
              };
            }
            case "status": {
              const snapshot = yield* service.status(yield* required(input.id, "id"));
              return {
                content: formatJob(snapshot),
                details: { action: input.action, snapshot } satisfies BackgroundTerminalToolDetails,
              };
            }
            case "logs": {
              const logs = yield* service.logs({
                id: yield* required(input.id, "id"),
                ...(input.afterCursor !== undefined ? { afterCursor: input.afterCursor } : {}),
                ...(input.tailLines !== undefined ? { tailLines: input.tailLines } : {}),
                ...(input.waitSeconds !== undefined ? { waitSeconds: input.waitSeconds } : {}),
              });
              const formatted = formatLogs(logs);
              return {
                content: formatted.text,
                details: {
                  action: input.action,
                  logs: { ...logs, events: [] },
                  ...(formatted.truncation.truncated ? { truncation: formatted.truncation } : {}),
                } satisfies BackgroundTerminalToolDetails,
              };
            }
            case "stop": {
              const snapshot = yield* service.stop(yield* required(input.id, "id"), input.force);
              return {
                content: `Stopped ${formatJob(snapshot)}`,
                details: { action: input.action, snapshot } satisfies BackgroundTerminalToolDetails,
              };
            }
            case "stop_all": {
              const jobs = yield* service.stopAll(input.force);
              return {
                content: `Stopped ${jobs.length} background job${jobs.length === 1 ? "" : "s"}.`,
                details: { action: input.action, jobs } satisfies BackgroundTerminalToolDetails,
              };
            }
            case "clear": {
              const removed = yield* service.clear;
              return {
                content: `Cleared ${removed} completed background job${removed === 1 ? "" : "s"}.`,
                details: { action: input.action, removed } satisfies BackgroundTerminalToolDetails,
              };
            }
          }
        }),
        signal,
      );
      return {
        content: [{ type: "text", text: result.content }],
        details: result.details,
      };
    },
    renderCall(args, theme) {
      const action = args.action ?? "...";
      const target = sanitizeTerminalLine(args.id ?? args.name ?? args.command ?? "");
      return new Text(
        `${theme.fg("toolTitle", theme.bold("background_terminal"))} ${theme.fg("muted", action)}${target ? ` ${theme.fg("dim", target)}` : ""}`,
        0,
        0,
      );
    },
    renderResult(result, { isPartial, expanded }, theme) {
      let text = sanitizeTerminalText(
        result.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n"),
      );
      const details = result.details as BackgroundTerminalToolDetails | undefined;
      if (expanded && details?.snapshot) {
        const snapshot = details.snapshot;
        text += `\n${sanitizeTerminalLine(snapshot.cwd)}${snapshot.pid ? ` · pid ${snapshot.pid}` : ""}`;
        if (snapshot.droppedLogBytes > 0) {
          text += `\n${snapshot.droppedLogBytes} log bytes discarded`;
        }
      }
      if (expanded && details?.logs) {
        text += `\nnext cursor ${details.logs.nextCursor} · earliest ${details.logs.earliestAvailableCursor}`;
      }
      return new Text(
        theme.fg(isPartial ? "warning" : "toolOutput", text || (isPartial ? "Working…" : "Done")),
        0,
        0,
      );
    },
  });
}
