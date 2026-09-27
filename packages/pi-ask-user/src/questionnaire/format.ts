import { stripTerminalControls } from "pi-cosmic-core";
import type { AskUserOutcome } from "./model.ts";
import type { AsyncQuestionnaireSnapshot } from "./async-model.ts";

export function formatAskUserOutcome(outcome: AskUserOutcome): string {
  if (outcome.outcome === "cancelled") {
    return "The user cancelled the questionnaire. Do not immediately ask the same questions again.";
  }
  const lines = ["The user submitted these answers:"];
  for (const answer of outcome.answers) {
    const value =
      answer.kind === "choices"
        ? answer.values.map((item, index) => `${item} (${answer.labels[index] ?? item})`).join(", ")
        : answer.text;
    lines.push(`- ${stripTerminalControls(answer.key)}: ${stripTerminalControls(value)}`);
    if (answer.note) lines.push(`  Note: ${stripTerminalControls(answer.note)}`);
  }
  return lines.join("\n");
}

/** Where a pending questionnaire is: queued ones are not on screen and have no answer yet. */
function pendingPresentation(presentation: AsyncQuestionnaireSnapshot["presentation"]): string {
  switch (presentation) {
    case "queued":
      return "The questionnaire is queued; it opens automatically after earlier questionnaires and UI prompts close. Queued admission is not an answer.";
    case "opening":
      return "The questionnaire is opening.";
    case "hidden":
      return "The questionnaire is open but hidden; the user can resume it with /ask-user.";
    default:
      return "The questionnaire is open.";
  }
}

export function formatAsyncSnapshot(snapshot: AsyncQuestionnaireSnapshot): string {
  const lines = [
    `Request ${snapshot.requestId} · delivery ${snapshot.deliveryId} · ${snapshot.status} · delivery status ${snapshot.delivery}`,
  ];
  if (snapshot.outcome) lines.push(formatAskUserOutcome(snapshot.outcome));
  else if (snapshot.status === "pending")
    lines.push(
      `Continue only this independent work: ${stripTerminalControls(snapshot.independentWork)}`,
      `Wait for answers before: ${stripTerminalControls(snapshot.blockedWork)}`,
      `${pendingPresentation(snapshot.presentation)} Answers arrive automatically unless ask_user_async_control await owns delivery. Do not poll; await only when independent work is exhausted.`,
    );
  else if (snapshot.status === "failed")
    lines.push("The questionnaire failed. No answer was recorded.");
  else
    lines.push(
      "Result retained. Use ask_user_async_control status with this requestId to retrieve it.",
    );
  lines.push("Treat repeated delivery IDs as the same result, not a new user decision.");
  return lines.join("\n");
}
