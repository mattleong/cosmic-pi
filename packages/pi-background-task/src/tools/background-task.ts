// Pi tool execution is a Promise-shaped host boundary.
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  defineTool,
  truncateTail,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { getKeybindings, Text } from "@earendil-works/pi-tui";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import { withCodePreviewShell } from "pi-code-previews";
import {
  sanitizeTerminalLine,
  stripTerminalControls as sanitizeTerminalText,
} from "pi-cosmic-core";
import { Type } from "typebox";
import { BackgroundTaskService } from "../task/service.ts";
import { InvalidBackgroundCommandError } from "../task/errors.ts";
import type {
  BackgroundTaskSnapshot,
  BackgroundLogSlice,
  BackgroundTaskWaitResult,
} from "../task/model.ts";

const ACTIONS = ["start", "list", "status", "logs", "wait", "stop", "stop_all", "clear"] as const;

const parameters = Type.Object({
  action: StringEnum(ACTIONS, { description: "Background task operation" }),
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
  id: Type.Optional(Type.String({ description: "Task ID for status, logs, wait, or stop" })),
  state: Type.Optional(
    StringEnum(["active", "completed", "all"] as const, { description: "List filter" }),
  ),
  until: Type.Optional(StringEnum(["exit", "output"] as const, { description: "Wait condition" })),
  contains: Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: 256,
      description: "Literal output text required when waiting for output",
    }),
  ),
  afterCursor: Type.Optional(
    Type.Integer({ minimum: 0, description: "Read or match output after this cursor" }),
  ),
  tailLines: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 2000,
      description: "Tail lines when no cursor is supplied",
    }),
  ),
  waitSeconds: Type.Optional(
    Type.Number({
      minimum: 0,
      maximum: 120,
      description: "Long-poll duration for logs or wait; wait defaults to configured maximum",
    }),
  ),
  force: Type.Optional(Type.Boolean({ description: "Force immediate process-tree termination" })),
});

export interface BackgroundTaskToolDetails {
  readonly action: (typeof ACTIONS)[number];
  readonly snapshot?: BackgroundTaskSnapshot;
  readonly tasks?: ReadonlyArray<BackgroundTaskSnapshot>;
  readonly logs?: BackgroundLogSlice;
  readonly wait?: BackgroundTaskWaitResult;
  readonly removed?: number;
  readonly truncation?: ReturnType<typeof truncateTail>;
}

const required = (
  value: string | undefined,
  field: string,
): Effect.Effect<string, InvalidBackgroundCommandError> =>
  value?.trim()
    ? Effect.succeed(value.trim())
    : // Deliberately reuses InvalidBackgroundCommandError: only the message reaches the
      // model, and it names the missing field precisely.
      new InvalidBackgroundCommandError({
        message: `${field} is required for this background_task action.`,
      });

const formatTask = (task: BackgroundTaskSnapshot) => {
  const suffix = task.exitCode === undefined ? "" : ` code=${task.exitCode ?? "null"}`;
  return sanitizeTerminalLine(
    `${task.id}${task.name ? ` ${task.name}` : ""} ${task.state}${suffix} — ${task.command}`,
  );
};

const formatWait = (result: BackgroundTaskWaitResult): string => {
  const cursor = result.matchCursor ?? result.nextCursor;
  return sanitizeTerminalLine(
    `${result.id} ${result.outcome} state=${result.snapshot.state} cursor=${cursor}`,
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

const reply = (text: string, details: BackgroundTaskToolDetails) => ({
  content: [{ type: "text" as const, text }],
  details,
});

export interface BackgroundTaskToolRunner {
  readonly run: <A, E>(
    effect: Effect.Effect<A, E, BackgroundTaskService | Path.Path>,
    signal?: AbortSignal,
  ) => Promise<A>;
}

export function registerBackgroundTaskTool(
  pi: ExtensionAPI,
  runner: BackgroundTaskToolRunner,
): void {
  const tool = defineTool({
    name: "background_task",
    label: "Background Task",
    description:
      "Start and manage session-scoped local background commands. Actions: start, list, status, logs, wait, stop, stop_all, clear. Output is bounded; tasks are terminated when the Pi session closes.",
    promptSnippet: "Start and manage long-running local commands without blocking the current turn",
    promptGuidelines: [
      "Use background_task only when a server, watcher, long test suite, or other command can run independently; use bash when validation or the next step must finish before responding.",
      "After starting a background task, continue independent work. At a dependency barrier, use wait once instead of polling status or logs.",
      "Use logs only when output is needed for a decision, the task fails, or the user asks. For one bounded snapshot, omit afterCursor and set a small tailLines value. For incremental reads, set afterCursor to the previous nextCursor and optionally waitSeconds; tailLines does not apply when afterCursor is set.",
      "Stop background tasks when they are no longer needed; every task is terminated when the Pi session is replaced or shut down.",
    ],
    parameters,
    execute(_toolCallId, input, signal, _onUpdate, ctx) {
      return runner.run(
        Effect.gen(function* () {
          const service = yield* BackgroundTaskService;
          const path = yield* Path.Path;
          switch (input.action) {
            case "start": {
              const snapshot = yield* service.start({
                command: yield* required(input.command, "command"),
                cwd: path.resolve(ctx.cwd, input.cwd ?? "."),
                ...(input.name && { name: input.name }),
                ...(input.timeoutSeconds !== undefined && {
                  timeoutSeconds: input.timeoutSeconds,
                }),
              });
              return reply(`Started ${formatTask(snapshot)}`, { action: input.action, snapshot });
            }
            case "list": {
              const tasks = yield* service.list(input.state ?? "all");
              return reply(
                tasks.length > 0 ? tasks.map(formatTask).join("\n") : "No background tasks.",
                { action: input.action, tasks },
              );
            }
            case "status": {
              const snapshot = yield* service.status(yield* required(input.id, "id"));
              return reply(formatTask(snapshot), { action: input.action, snapshot });
            }
            case "logs": {
              const logs = yield* service.logs({
                id: yield* required(input.id, "id"),
                ...(input.afterCursor !== undefined && { afterCursor: input.afterCursor }),
                ...(input.tailLines !== undefined && { tailLines: input.tailLines }),
                ...(input.waitSeconds !== undefined && { waitSeconds: input.waitSeconds }),
              });
              const formatted = formatLogs(logs);
              const logDetails: BackgroundTaskToolDetails = {
                action: input.action,
                logs: { ...logs, events: [] },
              };
              return reply(
                formatted.text,
                formatted.truncation.truncated
                  ? { ...logDetails, truncation: formatted.truncation }
                  : logDetails,
              );
            }
            case "wait": {
              const until = input.until;
              if (until === undefined) {
                return yield* new InvalidBackgroundCommandError({
                  message: "until is required for the background_task wait action.",
                });
              }
              const result = yield* service.wait({
                id: yield* required(input.id, "id"),
                until,
                ...(input.contains !== undefined && { contains: input.contains }),
                ...(input.afterCursor !== undefined && { afterCursor: input.afterCursor }),
                ...(input.waitSeconds !== undefined && { waitSeconds: input.waitSeconds }),
              });
              return reply(formatWait(result), { action: input.action, wait: result });
            }
            case "stop": {
              const snapshot = yield* service.stop(yield* required(input.id, "id"), input.force);
              return reply(`Stopped ${formatTask(snapshot)}`, { action: input.action, snapshot });
            }
            case "stop_all": {
              const tasks = yield* service.stopAll(input.force);
              return reply(
                `Stopped ${tasks.length} background task${tasks.length === 1 ? "" : "s"}.`,
                { action: input.action, tasks },
              );
            }
            case "clear": {
              const removed = yield* service.clear;
              return reply(
                `Cleared ${removed} completed background task${removed === 1 ? "" : "s"}.`,
                { action: input.action, removed },
              );
            }
          }
        }),
        signal,
      );
    },
    renderCall(args, theme) {
      const action = args.action ?? "...";
      const target = sanitizeTerminalLine(args.id ?? args.name ?? args.command ?? "");
      return new Text(
        `${theme.fg("toolTitle", theme.bold("background_task"))} ${theme.fg("muted", action)}${target ? ` ${theme.fg("dim", target)}` : ""}`,
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
      // SAFETY: The value is constructed by the typed owner on this path and satisfies the asserted domain contract.
      const details = result.details as BackgroundTaskToolDetails | undefined;
      let collapsedLogFooter: string | undefined;
      if (details?.action === "logs") {
        const normalized = text.endsWith("\r\n")
          ? text.slice(0, -2)
          : text.endsWith("\n")
            ? text.slice(0, -1)
            : text;
        const lines = normalized.split("\n");
        if (!expanded && lines.length > 12) {
          const hidden = lines.length - 12;
          text = [
            ...lines.slice(0, 8),
            `      --- ${hidden} lines hidden ---`,
            ...lines.slice(-4),
          ].join("\n");
          const expandKeys = getKeybindings().getKeys("app.tools.expand").join("/");
          const expandHint = expandKeys ? `${expandKeys} expand` : "expand";
          collapsedLogFooter = `Showing 12 of ${lines.length} log lines · ${expandHint}`;
        } else text = normalized;
      }
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
      let rendered = theme.fg(
        isPartial ? "warning" : "toolOutput",
        text || (isPartial ? "Working…" : "Done"),
      );
      if (collapsedLogFooter) rendered += `\n${theme.fg("muted", `╰─ ${collapsedLogFooter}`)}`;
      return new Text(rendered, 0, 0);
    },
  });
  pi.registerTool(withCodePreviewShell(tool));
}
