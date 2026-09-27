// Pi tool execution is a Promise-shaped host boundary.
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import {
  expandedSection,
  getTextContent,
  withCodePreviewShell,
  type CompactAnimationScheduler,
} from "pi-code-previews";
import { stripTerminalControls as sanitizeTerminalText } from "pi-cosmic-core";
import { composeToolComponent, renderToolHeader, toolRunningLine } from "pi-cosmic-ui/tool";
import { BackgroundTaskService } from "../task/service.ts";
import {
  backgroundTaskActionLabel,
  backgroundTaskCallSubject,
  backgroundTaskCompactSummary,
  backgroundTaskResultSubject,
  decodeBackgroundTaskDetails,
} from "../ui/compact-summary.ts";
import { executeBackgroundTaskCommand, type BackgroundTaskToolDetails } from "./command.ts";
import { resultSnapshot, renderBackgroundTaskPreview, taskProcessLine } from "./preview.ts";
import { BackgroundTaskParameters, type BackgroundTaskToolInput } from "./schema.ts";

export interface BackgroundTaskToolRunner {
  readonly scheduleAnimation?: CompactAnimationScheduler;
  readonly run: <A, E>(
    effect: Effect.Effect<A, E, BackgroundTaskService | Path.Path>,
    signal?: AbortSignal,
  ) => Promise<A>;
}

/**
 * Row state shared by the call and result renderers. The result names the task, so the call's
 * heading, drawn after both render, can say which task an ID-only call was about.
 */
interface BackgroundTaskRenderState {
  backgroundTaskSubject?: string;
}

const TITLE = "Background task";

/** The heading's subtitle: the action as people read it, then its human subject. */
const headingSubtitle = (
  args: Partial<BackgroundTaskToolInput>,
  resultSubject: string | undefined,
): string => {
  if (!args.action) return "";
  const subject = resultSubject || backgroundTaskCallSubject(args);
  return [backgroundTaskActionLabel(args.action), subject].filter(Boolean).join(" ");
};

const resultText = (content: Parameters<typeof getTextContent>[0]): string =>
  sanitizeTerminalText(getTextContent(content));

export function registerBackgroundTaskTool(
  pi: ExtensionAPI,
  runner: BackgroundTaskToolRunner,
): void {
  const tool = defineTool<
    typeof BackgroundTaskParameters,
    BackgroundTaskToolDetails,
    BackgroundTaskRenderState
  >({
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
    renderCall(args, theme, context) {
      // Drawn lazily: the result, rendered after the call, supplies the task's name.
      return composeToolComponent((width) => {
        if (!Number.isFinite(width) || width < 1) return [];
        const subtitle = headingSubtitle(args, context.state.backgroundTaskSubject);
        const lines = new Text(renderToolHeader({ title: TITLE, subtitle }, theme), 0, 0).render(
          width,
        );
        const running =
          context.executionStarted &&
          context.isPartial &&
          context.state.backgroundTaskSubject === undefined;
        return running ? [...lines, toolRunningLine(theme)] : lines;
      });
    },
    renderResult(result, { isPartial, expanded }, theme, context) {
      // The call body says it is running; a partial result has nothing else to show.
      if (isPartial) return new Container();
      const details = decodeBackgroundTaskDetails(result.details).pipe(
        Option.filter((decoded) => decoded.action === context.args.action),
      );
      context.state.backgroundTaskSubject = Option.match(details, {
        onNone: () => "",
        onSome: (decoded) => backgroundTaskResultSubject(decoded, context.args),
      });
      return renderBackgroundTaskPreview(
        {
          details,
          text: resultText(result.content),
          args: context.args,
          expanded,
          isError: context.isError,
        },
        theme,
      );
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
          const text = resultText(result.content).replace(/\n+$/u, "");
          const snapshot = Option.getOrUndefined(
            Option.map(decodeBackgroundTaskDetails(result.details), resultSnapshot),
          );
          const container = new Container();
          if (snapshot)
            container.addChild(
              expandedSection(theme, undefined, new Text(taskProcessLine(snapshot, theme), 0, 0)),
            );
          container.addChild(
            expandedSection(
              theme,
              "Raw result",
              new Text(theme.fg("toolOutput", text || "(empty)"), 0, 0),
            ),
          );
          return container;
        },
      },
      scheduleAnimation: runner.scheduleAnimation,
    }),
  );
}
