import type { Theme } from "@earendil-works/pi-coding-agent";
import { type CompactPhase, type CompactSummary } from "../tools/compact-summary";
import { renderCompactRow } from "./compact-row";
import { renderCompactChildren } from "./compact-children";
import { renderCompactIssues } from "./compact-issues";

interface CompactToolCallInput {
  name: string;
  phase: CompactPhase;
  summary: CompactSummary;
  duration?: string | undefined;
  elapsedMs?: number | undefined;
  timingEnabled?: boolean;
  animationFrame?: number | undefined;
}

/** Heading, the call's own issues, then its call tree with each child's reason on its row. */
export function renderCompactToolCall(
  input: CompactToolCallInput,
  theme: Theme,
  width: number,
): string[] {
  if (width <= 0) return [];
  return [
    renderCompactRow(input, theme, width),
    ...renderCompactIssues(input.summary.issues, theme, width),
    ...renderCompactChildren(input.summary.children, theme, width, {
      ...(input.animationFrame !== undefined && { animationFrame: input.animationFrame }),
      ...(input.timingEnabled !== undefined && { timingEnabled: input.timingEnabled }),
    }),
  ];
}
