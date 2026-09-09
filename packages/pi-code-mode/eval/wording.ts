import { evaluationError } from "./errors.ts";

/** Frozen before/after wording, independent of the older adoption/output candidates. */
export const previousSelectionGuideline =
  "Use code_mode when one task needs several dependent or parallel Pi built-in calls whose " +
  "intermediate results you would otherwise echo through the transcript; write one small " +
  "program and return only the distilled result.";

export const experimentalSelectionGuideline =
  "Use code_mode to keep predictable read/search/filter sequences in one program. " +
  "Parallelize independent calls and keep dependent steps ordered. Skip a separate " +
  "inspection turn when the schema and next steps are already known. Stop before steps " +
  "requiring model judgment or user approval; use direct tools for one simple operation.";

const sharedGuidelines = [
  "Always pass the optional code_mode intent parameter: a short human-readable phrase " +
    'describing what the program is for (e.g. "Inspect the extension"); the UI shows it ' +
    "in place of the raw program source.",
  "Prefer a concise distilled string when structure is unnecessary; otherwise return a " +
    "small object containing only the requested fields, never raw nested tool results or " +
    "whole files.",
] as const;

export const frozenWordingGuidelines = {
  baseline: [previousSelectionGuideline, ...sharedGuidelines],
  candidate: [experimentalSelectionGuideline, ...sharedGuidelines],
} as const;

/** Replays remain isolated after rollback, while unrelated production guidance drift fails closed. */
export function wordingGuidelines(
  current: readonly string[],
  variant: "baseline" | "candidate",
): string[] {
  const knownProduction = Object.values(frozenWordingGuidelines).some(
    (known) =>
      current.length === known.length && known.every((guide, index) => current[index] === guide),
  );
  if (!knownProduction) {
    throw evaluationError(
      "preflight",
      "Production guidance differs from the frozen benchmark snapshots.",
    );
  }
  return [...frozenWordingGuidelines[variant]];
}
