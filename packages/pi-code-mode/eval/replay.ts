import * as Schema from "effect/Schema";
import type { CodeModeToolDefinition } from "../src/tools/controller.ts";
import { measuredFormatter, type FormatterMeasurements } from "./formatter.ts";
import type { RunRecord } from "./score.ts";
import { wordingGuidelines } from "./wording.ts";

/** Execution entries decode this schema before acquiring fixtures, sessions, or model state. */
export const ReplayExperimentSchema = Schema.Literals(["wording", "formatter"]);
export type ReplayExperiment = typeof ReplayExperimentSchema.Type;
export const replayRefusal =
  "Choose an explicit wording or formatter experiment for an approved regression replay. " +
  "Archived adoption/output model-backed execution is disabled; use their offline fixtures and reports.";

/** Evaluation-only interventions; production definitions and defaults remain unchanged. */
export function replayToolOverrides(
  experiment: ReplayExperiment,
  variant: RunRecord["variant"],
  measurements: FormatterMeasurements,
) {
  return {
    formatSuccess:
      experiment === "formatter" ? measuredFormatter(variant, measurements) : undefined,
    wrapTool: (tool: CodeModeToolDefinition): CodeModeToolDefinition => ({
      ...tool,
      promptGuidelines: wordingGuidelines(
        tool.promptGuidelines ?? [],
        experiment === "formatter" ? "candidate" : variant,
      ),
    }),
  };
}
