// Pi tool execution is a Promise-shaped host boundary.
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, getKeybindings, Text } from "@earendil-works/pi-tui";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import {
  getTextContent,
  withCodePreviewShell,
  type CompactAnimationScheduler,
} from "pi-code-previews";
import {
  sanitizeTerminalLine,
  stripTerminalControls as sanitizeTerminalText,
} from "pi-cosmic-core";
import { expandKeyHint, renderToolHeader } from "pi-cosmic-ui/tool";
import { BackgroundTaskService } from "../task/service.ts";
import { executeBackgroundTaskCommand, type BackgroundTaskToolDetails } from "./command.ts";
import { BackgroundTaskParameters } from "./schema.ts";
import { backgroundTaskCompactSummary } from "../ui/compact-summary.ts";

export interface BackgroundTaskToolRunner {
  readonly scheduleAnimation?: CompactAnimationScheduler;
  readonly run: <A, E>(
    effect: Effect.Effect<A, E, BackgroundTaskService | Path.Path>,
    signal?: AbortSignal,
  ) => Promise<A>;
}

export function registerBackgroundTaskTool(
  pi: ExtensionAPI,
  runner: BackgroundTaskToolRunner,
): void {
  const expandKeys = getKeybindings().getKeys("app.tools.expand");
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
    parameters: BackgroundTaskParameters,
    execute(_toolCallId, input, signal, _onUpdate, ctx) {
      return runner.run(executeBackgroundTaskCommand(input, ctx.cwd), signal).then((result) => ({
        content: [{ type: "text" as const, text: result.text }],
        details: result.details,
      }));
    },
    renderCall(args, theme) {
      const action = args.action ?? "...";
      const target = sanitizeTerminalLine(args.id ?? args.name ?? args.command ?? "");
      return new Text(
        renderToolHeader(
          { title: "background_task", subtitle: `${action}${target ? ` ${target}` : ""}` },
          theme,
        ),
        0,
        0,
      );
    },
    renderResult(result, { isPartial, expanded }, theme) {
      let text = sanitizeTerminalText(getTextContent(result.content));
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
          collapsedLogFooter = `Showing 12 of ${lines.length} log lines · ${expandKeyHint(expandKeys, "expand")}`;
        } else text = normalized;
      }
      if (
        expanded &&
        details !== undefined &&
        (details.action === "start" || details.action === "status" || details.action === "stop")
      ) {
        const snapshot = details.snapshot;
        text += `\n${sanitizeTerminalLine(snapshot.cwd)}${snapshot.pid ? ` · pid ${snapshot.pid}` : ""}`;
        if (snapshot.droppedLogBytes > 0) {
          text += `\n${snapshot.droppedLogBytes} log bytes discarded`;
        }
      }
      // The owned logs producer already includes complete cursor metadata before the logs.
      let rendered = theme.fg(
        isPartial ? "warning" : "toolOutput",
        text || (isPartial ? "Working…" : "Done"),
      );
      if (collapsedLogFooter) rendered += `\n${theme.fg("muted", `╰─ ${collapsedLogFooter}`)}`;
      return new Text(rendered, 0, 0);
    },
  });
  pi.registerTool(
    withCodePreviewShell(tool, {
      compactSummary: backgroundTaskCompactSummary,
      expandedContent: {
        renderCall: () => new Container(),
        renderResult(result, _options, theme) {
          // Preserve fetched output and cursor text verbatim apart from terminal controls.
          // Task attention is projected from typed details, never parsed from this body.
          let text = sanitizeTerminalText(getTextContent(result.content));
          // SAFETY: The owned executor constructs this union; compact projection validates its snapshot.
          const details = result.details as BackgroundTaskToolDetails | undefined;
          if (
            details &&
            (details.action === "start" || details.action === "status" || details.action === "stop")
          ) {
            text += `\n${sanitizeTerminalLine(details.snapshot.cwd)}${details.snapshot.pid ? ` · pid ${details.snapshot.pid}` : ""}`;
          }
          return new Text(
            theme.fg("toolOutput", text ? `Raw task result\n${text}` : "Raw task result (empty)"),
            0,
            0,
          );
        },
      },
      scheduleAnimation: runner.scheduleAnimation,
    }),
  );
}
