import { diffLines } from "diff";
import * as Predicate from "effect/Predicate";
import { getObjectValue } from "../shared/helpers";
import { exceedsWriteDiffBytes, shouldSkipWriteDiffComplexity } from "../write/diff";
import { codePreviewPerformanceConfig } from "../config/state";
import { getEditPreviewOperations } from "./data/args";
import { isTruncated } from "./data/results";
import { countLabel } from "pi-cosmic-core";

const writeCounts = new WeakMap<
  object,
  {
    content: string;
    previous: unknown;
    policy: typeof codePreviewPerformanceConfig;
    detail: string | undefined;
  }
>();

/** Never turn partially validated operations into a successful operation total. */
export function editResultDetail<Args>(args: Args): string | undefined {
  const edits = getObjectValue(args, "edits");
  const count = Array.isArray(edits) ? edits.length : 1;
  if (!count || count > 64) return undefined;
  const operations = getEditPreviewOperations(args);
  if (operations.length !== count || operations.some((operation) => !operation.oldText))
    return undefined;
  return countLabel(count, "edit");
}

/** Count matching lines, not occurrences; unfamiliar or incomplete output has no total. */
export function grepResultDetail<Details>(output: string, details: Details): string | undefined {
  if (
    isTruncated(details) ||
    getObjectValue(details, "linesTruncated") === true ||
    getObjectValue(details, "matchLimitReached") !== undefined
  )
    return undefined;
  if (output.trim() === "No matches found") return "0 matching lines";
  const lines = output.replace(/\n$/u, "").split("\n");
  let count = 0;
  for (const line of lines) {
    if (line === "--") continue;
    const match = /^.+:[1-9]\d*: .*/u.test(line);
    const context = /^.+-[1-9]\d*- .*/u.test(line);
    // A delimiter in a path or payload can make both interpretations valid.
    // Without structured records, omit the total rather than count context as a match.
    if (match && context) return undefined;
    if (match) count++;
    else if (!context) return undefined;
  }
  return count ? countLabel(count, "matching line") : undefined;
}

/** Snapshot-keyed, bounded diff work is reused across redraws. */
export function writeResultDetail<Before>(before: Before, content: string): string | undefined {
  if (!Predicate.isObject(before)) return undefined;
  const cached = writeCounts.get(before);
  const previous = getObjectValue(before, "content");
  // Published performance configs are frozen and replaced, never mutated in place.
  const policy = codePreviewPerformanceConfig;
  if (cached?.content === content && cached.previous === previous && cached.policy === policy)
    return cached.detail;
  const detail = projectWriteResultDetail(before, content, policy);
  writeCounts.set(before, { content, previous, policy, detail });
  return detail;
}

/** Stateless variant for transient projections with explicit work limits. */
export function projectWriteResultDetail<Before>(
  before: Before,
  content: string,
  policy: { maxWriteDiffBytes: number; maxWriteDiffChangedLineCells: number },
): string | undefined {
  if (!Predicate.isObject(before) || getObjectValue(before, "kind") !== "content") return undefined;
  const previous = getObjectValue(before, "content");
  if (
    !Predicate.isString(previous) ||
    previous.length > 64_000 ||
    content.length > 64_000 ||
    exceedsWriteDiffBytes([previous, content], policy.maxWriteDiffBytes) ||
    shouldSkipWriteDiffComplexity(previous, content, policy.maxWriteDiffChangedLineCells)
  )
    return undefined;
  const changes = diffLines(previous, content, { maxEditLength: 256 });
  if (!changes) return undefined;
  const count = (side: "added" | "removed") =>
    changes.reduce((total, change) => total + (change[side] ? (change.count ?? 0) : 0), 0);
  return `+${count("added")} −${count("removed")}`;
}
