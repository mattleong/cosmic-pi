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
import { Type, type Static } from "typebox";
import { BackgroundTerminalService, type BackgroundJobFilter } from "../job/service.ts";
import { InvalidBackgroundCommandError } from "../job/errors.ts";
import type { BackgroundJobSnapshot, BackgroundLogSlice } from "../job/model.ts";
import { selectBackgroundLogPreview } from "../ui/log-preview.ts";
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
    : // Deliberately reuses InvalidBackgroundCommandError: only the message reaches the
      // model, and it names the missing field precisely.
      new InvalidBackgroundCommandError({
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
  const tool = defineTool({
    name: "background_terminal",
    label: "Background Terminal",
    description:
      "Start and manage session-scoped local background commands. Actions: start, list, status, logs, stop, stop_all, clear. Output is bounded; jobs are terminated when the Pi session closes.",
    promptSnippet: "Start and manage long-running local commands without blocking the current turn",
    promptGuidelines: [
      "Use background_terminal only when a server, watcher, long test suite, or other command can run independently; use bash when validation or the next step must finish before responding.",
      "After starting a background job, continue independent work. When completion becomes actionable, check status once; do not repeatedly poll status or logs merely to watch progress.",
      "Use logs only when output is needed for a decision, the job fails, or the user asks. For one bounded snapshot, omit afterCursor and set a small tailLines value. For incremental reads, set afterCursor to the previous nextCursor and optionally waitSeconds; tailLines does not apply when afterCursor is set.",
      "Stop background_terminal jobs when they are no longer needed; every job is terminated when the Pi session is replaced or shut down.",
    ],
    parameters,
    execute(_toolCallId, input, signal, _onUpdate, ctx) {
      return runner
        .run(
          Effect.gen(function* () {
            const service = yield* BackgroundTerminalService;
            const path = yield* Path.Path;
            switch (input.action) {
              case "start": {
                const command = yield* required(input.command, "command");
                const cwd = path.resolve(ctx.cwd, input.cwd ?? ".");
                const startRequestBase = { command, cwd };
                const startRequestWithName = input.name
                  ? { ...startRequestBase, name: input.name }
                  : startRequestBase;
                const snapshot = yield* service.start(
                  input.timeoutSeconds !== undefined
                    ? { ...startRequestWithName, timeoutSeconds: input.timeoutSeconds }
                    : startRequestWithName,
                );
                return {
                  content: `Started ${formatJob(snapshot)}`,
                  details: {
                    action: input.action,
                    snapshot,
                  } satisfies BackgroundTerminalToolDetails,
                };
              }
              case "list": {
                // SAFETY: The value is constructed by the typed owner on this path and satisfies the asserted domain contract.
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
                  details: {
                    action: input.action,
                    snapshot,
                  } satisfies BackgroundTerminalToolDetails,
                };
              }
              case "logs": {
                const logRequestBase = { id: yield* required(input.id, "id") };
                const logRequestWithCursor =
                  input.afterCursor === undefined
                    ? logRequestBase
                    : { ...logRequestBase, afterCursor: input.afterCursor };
                const logRequestWithTail =
                  input.tailLines === undefined
                    ? logRequestWithCursor
                    : { ...logRequestWithCursor, tailLines: input.tailLines };
                const logRequest =
                  input.waitSeconds === undefined
                    ? logRequestWithTail
                    : { ...logRequestWithTail, waitSeconds: input.waitSeconds };
                const logs = yield* service.logs(logRequest);
                const formatted = formatLogs(logs);
                const logDetails = {
                  action: input.action,
                  logs: { ...logs, events: [] },
                } satisfies BackgroundTerminalToolDetails;
                return {
                  content: formatted.text,
                  details: formatted.truncation.truncated
                    ? { ...logDetails, truncation: formatted.truncation }
                    : logDetails,
                };
              }
              case "stop": {
                const snapshot = yield* service.stop(yield* required(input.id, "id"), input.force);
                return {
                  content: `Stopped ${formatJob(snapshot)}`,
                  details: {
                    action: input.action,
                    snapshot,
                  } satisfies BackgroundTerminalToolDetails,
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
                  details: {
                    action: input.action,
                    removed,
                  } satisfies BackgroundTerminalToolDetails,
                };
              }
            }
          }),
          signal,
        )
        .then((result) => ({
          content: [{ type: "text", text: result.content }],
          details: result.details,
        }));
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
      // SAFETY: The value is constructed by the typed owner on this path and satisfies the asserted domain contract.
      const details = result.details as BackgroundTerminalToolDetails | undefined;
      let collapsedLogFooter: string | undefined;
      if (details?.action === "logs") {
        const preview = selectBackgroundLogPreview(text, expanded);
        text = preview.text;
        if (preview.hidden > 0) {
          const expandKeys = getKeybindings().getKeys("app.tools.expand").join("/");
          const expandHint = expandKeys ? `${expandKeys} expand` : "expand";
          collapsedLogFooter = `Showing ${preview.shown} of ${preview.total} log lines · ${expandHint}`;
        }
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
