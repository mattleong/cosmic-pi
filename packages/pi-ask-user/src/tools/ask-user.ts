// Pi tool execution and synchronous rendering are host boundaries.
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { withCodePreviewShell } from "pi-code-previews";
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

const decodeOutcomeDetails = projection(outcomeProjection({}));

export function registerAskUserTool(
  pi: ExtensionAPI,
  ask: (request: AskUserRequest, signal: AbortSignal | undefined) => Promise<AskUserOutcome>,
): void {
  const tool = defineTool({
    name: "ask_user",
    label: "Ask User",
    description:
      "Present one structured questionnaire containing one to four questions. Each question has two to four concrete choices, an automatic custom-answer action, optional answer notes, and optional markdown previews. Use this only when a decision is needed to proceed safely. Questionnaires open automatically in FIFO order, sharing a session queue of at most 16 pending requests; the tool waits for answers, not merely admission. Local and Herdr Pi child requests route to the root UI with authenticated run ownership.",
    promptSnippet:
      "Ask one structured batch of questions when concrete user decisions are required",
    promptGuidelines: [
      "Use ask_user when the request is materially ambiguous and proceeding would commit to a user preference, requirement, or trade-off that cannot be inferred safely.",
      "Do not use ask_user for rhetorical questions, routine confirmations, information already present in context, or decisions that can be reversed cheaply.",
      "Batch related decisions into one ask_user invocation and do not call ask_user repeatedly after the user cancels.",
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
  pi.registerTool(withCodePreviewShell(tool));
}
