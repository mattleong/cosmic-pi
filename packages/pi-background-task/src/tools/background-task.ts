import {
  defineTool,
  type AgentToolResult,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import * as Arr from "effect/Array";
import type * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import * as Str from "effect/String";
import {
  expandedArguments,
  expandedSection,
  getTextContent,
  previewIssuesSlot,
  withCodePreviewShell,
  type CompactAnimationScheduler,
} from "pi-code-previews";
import { stripTerminalControls as sanitizeTerminalText } from "pi-cosmic-core/security";
import { toPiToolOutputSchema } from "pi-cosmic-core/schema/tool-output";
import { composeToolComponent, renderToolHeader, toolRunningLine } from "pi-cosmic-ui/tool";
import { type BackgroundTaskService } from "../task/service.ts";
import {
  backgroundTaskActionLabel,
  backgroundTaskCallSubject,
  backgroundTaskCompactSummary,
  backgroundTaskResultSubject,
  decodeBackgroundTaskDetails,
  resultSnapshot,
} from "../ui/compact-summary.ts";
import {
  executeBackgroundTaskCommand,
  type BackgroundTaskContractResult,
  type BackgroundTaskToolDetails,
} from "./command.ts";
import { BackgroundTaskContractSchema, encodeBackgroundTaskContract } from "./contract-schema.ts";
import { renderBackgroundTaskPreview, taskProcessLine } from "./preview.ts";
import {
  BackgroundTaskParameters,
  prepareBackgroundTaskArguments,
  type BackgroundTaskToolInput,
} from "./schema.ts";

export interface BackgroundTaskToolRunner {
  readonly scheduleAnimation?: CompactAnimationScheduler;
  readonly run: <A, E>(
    effect: Effect.Effect<A, E, BackgroundTaskService | Path.Path>,
    signal?: AbortSignal,
  ) => Promise<A>;
}

interface BackgroundTaskRenderState {
  backgroundTaskSubject?: string;
}

const TITLE = "Background task";

const headingSubtitle = (
  args: Partial<BackgroundTaskToolInput>,
  resultSubject: string | undefined,
): string => {
  if (!args.action) return "";
  const subject =
    resultSubject === undefined || resultSubject === ""
      ? backgroundTaskCallSubject(args)
      : resultSubject;
  return Arr.join(
    Arr.filter([backgroundTaskActionLabel(args.action), subject], Str.isNonEmpty),
    " ",
  );
};

const resultText = (content: Parameters<typeof getTextContent>[0]): string =>
  sanitizeTerminalText(getTextContent(content));

const OUTPUT_SCHEMA = toPiToolOutputSchema(BackgroundTaskContractSchema);

const CONTRACT_UNAVAILABLE =
  "Background task result is unavailable; the action may have taken effect";

const backgroundTaskToolResult = (
  result: BackgroundTaskContractResult,
): AgentToolResult<BackgroundTaskToolDetails> => {
  const structuredContent = encodeBackgroundTaskContract(result.contract);
  return structuredContent === undefined
    ? {
        content: [{ type: "text", text: `${CONTRACT_UNAVAILABLE}\n${result.text}` }],
        details: result.details,
        isError: true,
      }
    : {
        content: [{ type: "text", text: result.text }],
        details: result.details,
        structuredContent,
      };
};

export function registerBackgroundTaskTool(
  pi: ExtensionAPI,
  runner: BackgroundTaskToolRunner,
  shell: typeof withCodePreviewShell = withCodePreviewShell,
): void {
  const tool = defineTool<
    typeof BackgroundTaskParameters,
    BackgroundTaskToolDetails,
    BackgroundTaskRenderState
  >({
    name: "background_task",
    label: "Background Task",
    description:
      "Start and manage session-scoped local background commands, run in Pi's shell (bash by default) with stdin open but never written, so a command that may prompt or read stdin waits until stopped or timed out: give it </dev/null or non-interactive flags. Actions: start, list, status, logs, wait, stop, stop_all, clear. Task IDs are opaque and come only from a start result, so a call that names a new task must wait for it. Start with notify to get a message when the task finishes. Each action accepts only its own parameters; empty, false, or zero placeholders in other fields are ignored, and other values there are rejected. Output is bounded; each task's process group is terminated when the Pi session closes, but processes that start their own session or process group, such as daemons, are not tracked.",
    promptSnippet: "Start and manage long-running local commands without blocking the current turn",
    promptGuidelines: [
      "Use background_task only when a server, watcher, long test suite, or other command can run independently; use bash when validation or the next step must finish before responding.",
      'When you start a task whose result you will act on later, set notify to "exit" (or "failure" to hear only about failures and timeouts) and continue independent work: a message arrives when it finishes, with its outcome and recent output, so don\'t poll it. No message follows a stop you made, or a finish you already saw in a tool result.',
      "At a dependency barrier, use wait instead of polling status or logs. The maxWaitSeconds setting (30 seconds by default) caps every wait, and the result reports the applied limit and the task's recent output. A timeout leaves the task running; call wait again until it matches or completes. Output waits match the plain text that logs shows within one stream, without the [stderr] label; contains may list a few alternatives, such as a ready line and an error, and the result names the one found and its line. Set afterCursor to an earlier nextCursor to wait only for new output, because earlier retained output can match immediately.",
      "Use logs only when output is needed for a decision, the task fails, or the user asks. For one bounded snapshot, omit afterCursor and set a small tailLines value. For incremental reads, set afterCursor to the previous nextCursor and optionally waitSeconds; don't combine tailLines with afterCursor.",
      "Stop background tasks when they are no longer needed; every task's process group is terminated when the Pi session is replaced or shut down. Run services in the foreground: daemonized or detached processes escape that cleanup.",
      "Native codemode receives version-1 structured results. Print successful task IDs immediately and check the contract envelope before using them. A task's finished flag means terminal state, not command success or cleanup confirmation.",
      "Rejected or cancelled calls do not roll back admitted starts or stop signals. Hand uncertainty to the main agent for list/status recovery before replaying a command. Task IDs from before a reload or tree navigation name no current task; discard old workflow checkpoints.",
    ],
    parameters: BackgroundTaskParameters,
    prepareArguments: prepareBackgroundTaskArguments,
    outputSchema: OUTPUT_SCHEMA,
    execute(_toolCallId, input, signal, _onUpdate, ctx) {
      return runner
        .run(executeBackgroundTaskCommand(input, ctx.cwd), signal)
        .then(backgroundTaskToolResult);
    },
    renderCall(args, theme, context) {
      const { state, executionStarted, isPartial } = context;
      const heading = composeToolComponent((width) => {
        if (!Number.isFinite(width) || width < 1) return [];
        const subtitle = headingSubtitle(args, state.backgroundTaskSubject);
        const lines = new Text(renderToolHeader({ title: TITLE, subtitle }, theme), 0, 0).render(
          width,
        );
        const running = executionStarted && isPartial && state.backgroundTaskSubject === undefined;
        return running ? [...lines, toolRunningLine(theme)] : lines;
      });
      if (!context.expanded) return heading;
      const body = new Container();
      body.addChild(heading);
      body.addChild(previewIssuesSlot(context));
      body.addChild(expandedArguments(theme, args));
      return body;
    },
    renderResult(result, { isPartial, expanded }, theme, context) {
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
    shell(tool, {
      compactSummary: backgroundTaskCompactSummary,
      expandedContent: {
        renderCall: (args, theme) => expandedArguments(theme, args),
        renderResult(result, _options, theme) {
          const text = Fn.pipe(resultText(result.content), Str.replace(/\n+$/u, ""));
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
