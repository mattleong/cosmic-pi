import { diffLines } from "diff";
import * as Predicate from "effect/Predicate";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Str from "effect/String";
import { ownField, type HostObject } from "../shared/untrusted-value";
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

export function editResultDetail(args: HostObject | undefined): string | undefined {
  const edits = ownField(args, "edits");
  const count = Arr.isArray(edits) ? edits.length : 1;
  if (!count || count > 64) return undefined;
  const operations = getEditPreviewOperations(args);
  if (operations.length !== count || Arr.some(operations, (operation) => !operation.oldText))
    return undefined;
  return countLabel(count, "edit");
}

export function grepResultDetail(
  output: string,
  details: HostObject | undefined,
): string | undefined {
  if (
    isTruncated(details) ||
    ownField(details, "linesTruncated") === true ||
    ownField(details, "matchLimitReached") !== undefined
  )
    return undefined;
  if (Str.trim(output) === "No matches found") return "0 matching lines";
  const lines = Str.split(Fn.pipe(output, Str.replace(/\n$/u, "")), "\n");
  let count = 0;
  for (const line of lines) {
    if (line === "--") continue;
    const match = /^.+:[1-9]\d*: .*/u.test(line);
    const context = /^.+-[1-9]\d*- .*/u.test(line);
    if (match && context) return undefined;
    if (match) count++;
    else if (!context) return undefined;
  }
  return count ? countLabel(count, "matching line") : undefined;
}

export function writeResultDetail(
  before: HostObject | undefined,
  content: string,
): string | undefined {
  if (!before) return undefined;
  const cached = writeCounts.get(before);
  const previous = ownField(before, "content");
  const policy = codePreviewPerformanceConfig;
  if (cached?.content === content && cached.previous === previous && cached.policy === policy)
    return cached.detail;
  const detail = projectWriteResultDetail(before, content, policy);
  writeCounts.set(before, { content, previous, policy, detail });
  return detail;
}

export function projectWriteResultDetail(
  before: HostObject | undefined,
  content: string,
  policy: { maxWriteDiffBytes: number; maxWriteDiffChangedLineCells: number },
): string | undefined {
  if (ownField(before, "kind") !== "content") return undefined;
  const previous = ownField(before, "content");
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
    Arr.reduce(changes, 0, (total, change) => total + (change[side] ? (change.count ?? 0) : 0));
  return `+${count("added")} −${count("removed")}`;
}
