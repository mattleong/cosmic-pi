// Pi tool execution and synchronous rendering are host boundaries.
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { withCodePreviewShell, type CompactAnimationScheduler } from "pi-code-previews";
import { stripTerminalControls } from "pi-cosmic-core";
import { renderToolHeader, toolStatusLine } from "pi-cosmic-ui/tool";
import { formatAskUserOutcome } from "../questionnaire/format.ts";
import type { AskUserOutcome } from "../questionnaire/model.ts";
import { AskUserParameters, type AskUserRequest } from "../questionnaire/schema.ts";
import {
  answerLine,
  decodeCallTitles,
  fallbackText,
  outcomeProjection,
  projection,
} from "../ui/tool-render-projection.ts";

import { askUserCompactSummary } from "../ui/compact-summary.ts";

const decodeOutcomeDetails = projection(outcomeProjection({}));

export function registerAskUserTool(
  pi: ExtensionAPI,
  ask: (request: AskUserRequest, signal: AbortSignal | undefined) => Promise<AskUserOutcome>,
  scheduleAnimation?: CompactAnimationScheduler,
): void {
  const tool = defineTool({
    name: "ask_user",
    label: "Ask User",
    description:
      "Present one structured questionnaire containing one to four questions. Use single/multiple mode with two to four concrete choices and an automatic custom-answer action, or text mode without choices for a required free-text answer. Text answers are trimmed and limited to 4000 code units. All questions support optional notes up to 2000 code units; choices may include markdown previews. Use this only when a decision is needed to proceed safely. Questionnaires open automatically in FIFO order, sharing a session queue of at most 16 pending requests; the tool waits for answers, not merely admission. Local and Herdr Pi child requests route to the root UI with authenticated run ownership.",
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
    renderCall(args, theme) {
      const questions = decodeCallTitles(args)?.questions ?? [];
      const titles = questions.map((question) => stripTerminalControls(question.title)).join(", ");
      const count = `${questions.length} question${questions.length === 1 ? "" : "s"}`;
      return new Text(
        renderToolHeader(
          { title: "ask_user", subtitle: `${count}${titles ? ` (${titles})` : ""}` },
          theme,
        ),
        0,
        0,
      );
    },
    renderResult(result, _options, theme) {
      const details = decodeOutcomeDetails(result.details);
      if (details?.outcome === "cancelled")
        return new Text(toolStatusLine(theme, "warning", "Questionnaire cancelled"), 0, 0);
      if (details?.outcome === "submitted") {
        const lines = details.answers.map((answer) => answerLine(answer, theme));
        return new Text(lines.join("\n"), 0, 0);
      }
      return new Text(fallbackText(result.content), 0, 0);
    },
  });
  pi.registerTool(
    withCodePreviewShell(tool, {
      compactSummary: askUserCompactSummary,
      expandedContent: {
        renderCall: (args) => new Text(stripTerminalControls(JSON.stringify(args, null, 2)), 0, 0),
        renderResult(result, _options, theme) {
          const details = decodeOutcomeDetails(result.details);
          return new Text(
            details?.outcome === "submitted"
              ? [
                  ...details.answers.map((answer) => answerLine(answer, theme)),
                  ...(fallbackText(result.content)
                    ? ["Raw result", fallbackText(result.content)]
                    : []),
                ].join("\n")
              : details?.outcome === "cancelled"
                ? "Do not immediately ask the same questions again."
                : fallbackText(result.content),
            0,
            0,
          );
        },
      },
      scheduleAnimation,
    }),
  );
}
