import {
  defineTool,
  type AgentToolResult,
  type ExtensionAPI,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import * as Fn from "effect/Function";
import * as Predicate from "effect/Predicate";
import {
  captureCodePreviewPresentationPolicy,
  withCodePreviewShell,
  type CompactAnimationScheduler,
} from "pi-code-previews";
import { toPiToolOutputSchema } from "pi-cosmic-core/schema/tool-output";
import { toolRunningLine, toolStatusLine } from "pi-cosmic-ui/tool";
import { formatAskUserOutcome } from "../questionnaire/format.ts";
import type { AskUserOutcome } from "../questionnaire/model.ts";
import { AskUserParameters, type AskUserRequest } from "../questionnaire/schema.ts";
import { askUserCompactSummaryFor } from "../ui/compact-summary.ts";
import {
  answerInCompactHeading,
  answersBody,
  callBody,
  cancelledLine,
  emptyBody,
  expandedResult,
  markReported,
  pendingRequest,
  stacked,
  type RenderContext,
} from "../ui/tool-body.ts";
import {
  callTitles,
  contentText,
  QUESTIONS_SHOWN,
  decodePresentation,
  type PresentationProgress,
  decodeOutcome,
  requestArguments,
  titlesByKey,
} from "../ui/tool-render-projection.ts";

import { questionnaireArgumentPreparer } from "./arguments.ts";
import { AskUserContractSchema } from "./contract-schema.ts";
import { askUserContract, questionnaireToolResult } from "./contract.ts";

type AskUserToolDetails = AskUserOutcome | PresentationProgress;

// Converted on first registration, so processes that never register the tool skip the cost.
const outputSchema = Fn.memoize(toPiToolOutputSchema);

export function registerAskUserTool(
  pi: ExtensionAPI,
  ask: (
    request: AskUserRequest,
    signal: AbortSignal | undefined,
    shown: () => void,
  ) => Promise<AskUserOutcome>,
  scheduleAnimation?: CompactAnimationScheduler,
  shell: typeof withCodePreviewShell = withCodePreviewShell,
): void {
  const tool = defineTool({
    name: "ask_user",
    label: "Ask user",
    description:
      "Present one structured questionnaire containing one to six questions. Use single/multiple mode with two to six concrete choices and an automatic custom-answer action, or text mode without choices for a required free-text answer. Text answers are trimmed and limited to 4000 code units. All questions support optional notes up to 2000 code units; choices may include markdown previews. Use this only when a decision is needed to proceed safely. Questionnaires open automatically in FIFO order, sharing a session queue of at most 16 pending requests; the tool waits for answers, not merely admission. Local Pi child requests route to the root UI with authenticated run ownership.",
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
      "Native codemode receives structured pi-ask-user/questionnaire version-1 results. Check contract, version, tool, and outcome before branching on answers. Rejected or cancelled scripts do not undo answers; do not blindly retry a questionnaire. Codemode scripts share a small pool of Pi workers, so call ask_user or await an async questionnaire directly rather than from codemode, where a long user wait blocks other scripts.",
    ],
    parameters: AskUserParameters,
    prepareArguments: questionnaireArgumentPreparer("ask_user", AskUserParameters),
    outputSchema: outputSchema(AskUserContractSchema),
    executionMode: "sequential",
    execute(_toolCallId, input, signal, onUpdate) {
      // Progress tells the row the questions are on screen, so it waits on the user, not a spinner.
      const shown = () => onUpdate?.({ content: [], details: QUESTIONS_SHOWN });
      return ask(input, signal, shown).then((outcome) =>
        questionnaireToolResult<AskUserToolDetails>(
          formatAskUserOutcome(outcome),
          outcome,
          askUserContract(outcome),
        ),
      );
    },
    renderCall(args, theme, context) {
      return callBody({ title: "Ask user", subtitle: callTitles(args) }, args, theme, context);
    },
    renderResult(result, options, theme, context) {
      markReported(context);
      if (options.isPartial)
        return new Text(
          decodePresentation(result.details) === "open"
            ? toolStatusLine(theme, "waiting", "Needs your input")
            : toolRunningLine(theme),
          0,
          0,
        );
      const details = decodeOutcome(result.details);
      const cancelled = details?.outcome === "cancelled" && !context.isError;
      if (options.expanded)
        return cancelled
          ? stacked([cancelledLine(theme), expandedContent(result, theme, context)])
          : expandedContent(result, theme, context);
      if (context.isError) return emptyBody();
      if (cancelled) return cancelledLine(theme);
      if (details?.outcome === "submitted") {
        // The heading names the questions, so a lone answer may leave its title to it.
        const state: unknown = context.state;
        return answersBody(
          details.answers,
          titlesByKey(context.args),
          theme,
          context,
          Predicate.isObject(state) ? state : undefined,
        );
      }
      return new Text(contentText(result.content), 0, 0);
    },
  });
  pi.registerTool(
    shell(tool, {
      // Read when the shell is, so the summary names what that style's collapsed row hides.
      compactSummary: askUserCompactSummaryFor(
        captureCodePreviewPresentationPolicy().toolCallCollapsedStyle,
      ),
      expandedContent: {
        renderCall: (args, theme, context) =>
          pendingRequest(theme, requestArguments(args), context),
        renderResult: (result, options, theme, context) =>
          expandedContent(result, theme, context, options.isPartial),
      },
      scheduleAnimation,
    }),
  );
}

function expandedContent<Details>(
  result: AgentToolResult<Details>,
  theme: Theme,
  context: Pick<RenderContext, "args" | "isError" | "state">,
  partial = false,
): Component {
  const details = decodeOutcome(result.details);
  const answers = details?.outcome === "submitted" ? details.answers : undefined;
  return expandedResult(
    {
      raw: contentText(result.content),
      isError: context.isError,
      decoded: details !== undefined,
      answers,
      ...(answers && { answerInHeading: answerInCompactHeading(answers, context) }),
      titles: titlesByKey(context.args),
      // The call still shows the request until the final result arrives.
      ...(!partial && { args: requestArguments(context.args) }),
    },
    theme,
  );
}
