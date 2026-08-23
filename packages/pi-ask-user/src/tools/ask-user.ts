// Pi tool execution is a Promise-shaped host boundary.
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import * as Effect from "effect/Effect";
import { withCodePreviewShell } from "pi-code-previews";
import type { AskUserOutcome } from "../questionnaire/model.ts";
import { AskUserService } from "../questionnaire/service.ts";
import { safeText } from "../ui/render.ts";
import { AskUserParameters } from "./schema.ts";
import { formatAskUserOutcome } from "./response.ts";

export interface AskUserToolRunner {
  readonly run: <A, E>(
    effect: Effect.Effect<A, E, AskUserService>,
    signal?: AbortSignal,
  ) => Promise<A>;
}

export type AskUserToolDetails = AskUserOutcome;

export function registerAskUserTool(pi: ExtensionAPI, runner: AskUserToolRunner): void {
  const tool = defineTool({
    name: "ask_user",
    label: "Ask User",
    description:
      "Present one structured questionnaire containing one to four questions. Each question has two to four concrete choices, an automatic custom-answer action, optional answer notes, and optional markdown previews. Use this only when a decision is needed to proceed safely.",
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
      return runner
        .run(
          AskUserService.use((service) => service.ask(input)),
          signal,
        )
        .then((outcome) => ({
          content: [{ type: "text" as const, text: formatAskUserOutcome(outcome) }],
          details: outcome satisfies AskUserToolDetails,
        }));
    },
    renderCall(args, theme) {
      const questions = Array.isArray(args.questions) ? args.questions : [];
      const titles = questions.map((question) => safeText(question.title)).join(", ");
      return new Text(
        `${theme.fg("toolTitle", theme.bold("ask_user"))} ${theme.fg("muted", `${questions.length} question${questions.length === 1 ? "" : "s"}`)}${titles ? ` ${theme.fg("dim", `(${titles})`)}` : ""}`,
        0,
        0,
      );
    },
    renderResult(result, _options, theme) {
      // SAFETY: The value is constructed by the typed owner on this path and satisfies the asserted domain contract.
      const details = result.details as AskUserOutcome | undefined;
      if (details?.outcome === "cancelled")
        return new Text(theme.fg("warning", "Questionnaire cancelled"), 0, 0);
      if (details?.outcome === "submitted") {
        const lines = details.answers.map((answer) => {
          const value = answer.kind === "choices" ? answer.labels.join(", ") : answer.text;
          return `${theme.fg("success", "✓")} ${theme.fg("accent", safeText(answer.key))}: ${safeText(value)}`;
        });
        return new Text(lines.join("\n"), 0, 0);
      }
      const text = result.content
        .filter((part) => part.type === "text")
        .map((part) => safeText(part.text))
        .join("\n");
      return new Text(text, 0, 0);
    },
  });
  pi.registerTool(withCodePreviewShell(tool));
}
