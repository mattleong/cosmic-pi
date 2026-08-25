import { stripTerminalControls } from "pi-cosmic-core";
import type { AskUserOutcome } from "../questionnaire/model.ts";

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
