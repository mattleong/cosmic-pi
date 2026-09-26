import type { Theme } from "@earendil-works/pi-coding-agent";
import { countLabel } from "../shared/helpers";
import { forEachRawTextLine } from "../shared/text-lines";

export type DiffSummary = {
  additions: number;
  removals: number;
  replacements: number;
  insertions: number;
  deletions: number;
  totalLines: number;
  hunks: number;
};

export function diffSummarySeparator(theme: Theme): string {
  return theme.fg("muted", " · ");
}

export function describeDiffContract(summary: DiffSummary): string {
  const parts: string[] = [];
  if (summary.replacements > 0) parts.push(countLabel(summary.replacements, "replacement"));
  if (summary.insertions > 0) parts.push(countLabel(summary.insertions, "insertion"));
  if (summary.deletions > 0) parts.push(countLabel(summary.deletions, "deletion"));
  return parts.length ? parts.join(", ") : "changes";
}

export function summarizeDiff(diff: string): DiffSummary {
  const summary: DiffSummary = {
    additions: 0,
    removals: 0,
    replacements: 0,
    insertions: 0,
    deletions: 0,
    totalLines: 0,
    hunks: 0,
  };
  let groupAdditions = 0;
  let groupRemovals = 0;

  function flushChangeGroup() {
    if (groupAdditions === 0 && groupRemovals === 0) return;
    summary.hunks++;
    if (groupAdditions > 0 && groupRemovals > 0) {
      summary.replacements++;
      summary.insertions += Math.max(0, groupAdditions - groupRemovals);
      summary.deletions += Math.max(0, groupRemovals - groupAdditions);
    } else if (groupAdditions > 0) {
      summary.insertions += groupAdditions;
    } else {
      summary.deletions += groupRemovals;
    }
    groupAdditions = 0;
    groupRemovals = 0;
  }

  forEachRawTextLine(diff, (line) => {
    summary.totalLines++;
    const isAddition = line.startsWith("+") && !line.startsWith("+++");
    const isRemoval = line.startsWith("-") && !line.startsWith("---");

    if (isAddition) {
      summary.additions++;
      groupAdditions++;
    } else if (isRemoval) {
      summary.removals++;
      groupRemovals++;
    } else {
      flushChangeGroup();
    }
  });
  flushChangeGroup();
  return summary;
}
