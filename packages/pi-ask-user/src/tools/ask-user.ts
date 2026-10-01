// Pi tool execution and synchronous rendering are host boundaries.
import {
  defineTool,
  type AgentToolResult,
  type ExtensionAPI,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import { withCodePreviewShell, type CompactAnimationScheduler } from "pi-code-previews";
import { toolRunningLine } from "pi-cosmic-ui/tool";
import { formatAskUserOutcome } from "../questionnaire/format.ts";
import type { AskUserOutcome } from "../questionnaire/model.ts";
import { AskUserParameters, type AskUserRequest } from "../questionnaire/schema.ts";
import { askUserCompactSummary } from "../ui/compact-summary.ts";
import {
  answersBody,
  argumentsSection,
  callBody,
  cancelledLine,
  emptyBody,
  expandedResult,
  stacked,
  type RenderContext,
} from "../ui/tool-body.ts";
import {
  callTitles,
  decodeOutcome,
  fallbackText,
  titlesByKey,
} from "../ui/tool-render-projection.ts";

export function registerAskUserTool(
  pi: ExtensionAPI,
  ask: (request: AskUserRequest, signal: AbortSignal | undefined) => Promise<AskUserOutcome>,
  scheduleAnimation?: CompactAnimationScheduler,
): void {
  const tool = defineTool({
    name: "ask_user",
    label: "Ask User",
    description:
      "Present one structured questionnaire containing one to six questions. Use single/multiple mode with two to four concrete choices and an automatic custom-answer action, or text mode without choices for a required free-text answer. Text answers are trimmed and limited to 4000 code units. All questions support optional notes up to 2000 code units; choices may include markdown previews. Use this only when a decision is needed to proceed safely. Questionnaires open automatically in FIFO order, sharing a session queue of at most 16 pending requests; the tool waits for answers, not merely admission. Local Pi child requests route to the root UI with authenticated run ownership.",
    promptSnippet:
      "Ask one structured batch of questions when concrete user decisions are required",
    promptGuidelines: [
      "Use ask_user when the request is materially ambiguous and proceeding would commit to a user preference, requirement, or trade-off that cannot be inferred safely.",
      "Do not use ask_user for rhetorical questions, routine confirmations, information already present in context, or decisions that can be reversed cheaply.",
      "Batch related decisions into one ask_user invocation and do not call ask_user repeatedly after the user cancels.",
      "Use ask_user text mode without choices when the user must supply wording or information rather than select alternatives. Text answers must be nonblank and at most 4000 code units after trimming.",
      "Every ask_user choice needs a stable value, concise label, and useful trade-off description. Use previews only for concrete artifacts that benefit from visual comparison.",
      "When ask_user offers alternatives and one choice is the main agent's recommendation, place it first, append (Recommended) to its label, and explain why in its description; do not force a recommendation for preference-only choices.",
      "Never ask users to enter passwords, API keys, tokens, private keys, or other credentials through ask_user.",
    ],
    parameters: AskUserParameters,
    executionMode: "sequential",
    execute(_toolCallId, input, signal) {
      return ask(input, signal).then((outcome) => ({
        content: [{ type: "text" as const, text: formatAskUserOutcome(outcome) }],
        details: outcome satisfies AskUserOutcome,
      }));
    },
    renderCall(args, theme, context) {
      return callBody({ title: "Ask user", subtitle: callTitles(args) }, args, theme, context);
    },
    renderResult(result, options, theme, context) {
      if (options.isPartial) return new Text(toolRunningLine(theme), 0, 0);
      const details = decodeOutcome(result.details);
      // The shell states failures and the cancellations Pi reports; the body states the rest.
      const cancelled = details?.outcome === "cancelled" && !context.isError;
      if (options.expanded)
        return cancelled
          ? stacked([cancelledLine(theme), expandedContent(result, theme, context)])
          : expandedContent(result, theme, context);
      if (context.isError) return emptyBody();
      if (cancelled) return cancelledLine(theme);
      if (details?.outcome === "submitted")
        return answersBody(details.answers, titlesByKey(context.args), theme, true);
      return new Text(fallbackText(result.content), 0, 0);
    },
  });
  pi.registerTool(
    withCodePreviewShell(tool, {
      compactSummary: askUserCompactSummary,
      expandedContent: {
        renderCall: (args, theme) => argumentsSection(theme, args),
        renderResult: (result, _options, theme, context) => expandedContent(result, theme, context),
      },
      scheduleAnimation,
    }),
  );
}

/** The labeled agent-facing text; a replay without text shows its answers whole. */
function expandedContent<Details>(
  result: AgentToolResult<Details>,
  theme: Theme,
  context: Pick<RenderContext, "args" | "isError">,
): Component {
  const details = decodeOutcome(result.details);
  return expandedResult(
    fallbackText(result.content),
    context.isError,
    details?.outcome === "submitted" ? details.answers : undefined,
    titlesByKey(context.args),
    theme,
  );
}
