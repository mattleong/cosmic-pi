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
import { countLabel } from "pi-cosmic-core/display";

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

/** What Pi's find and ls return when nothing matched or the directory is empty. */
export const PATH_LIST_EMPTY_OUTPUT = {
  find: "No files found matching pattern",
  ls: "(empty directory)",
} as const;

const PATH_LIST_RESULTS = {
  find: { limit: "resultLimitReached", empty: PATH_LIST_EMPTY_OUTPUT.find, unit: "match" },
  ls: { limit: "entryLimitReached", empty: PATH_LIST_EMPTY_OUTPUT.ls, unit: "entry" },
} as const;

const PATH_LIST_PLURALS = { match: "matches", entry: "entries" } as const;

/** How many paths a complete find or ls listing returned; clipped listings state their limit. */
export function pathListResultDetail(
  tool: "find" | "ls",
  output: string,
  details: HostObject | undefined,
): string | undefined {
  const { limit, empty, unit } = PATH_LIST_RESULTS[tool];
  if (isTruncated(details) || ownField(details, limit) !== undefined) return undefined;
  if (Str.trim(output) === empty) return tool === "ls" ? "empty" : `0 ${PATH_LIST_PLURALS[unit]}`;
  const lines = Arr.filter(Str.split(output, "\n"), (line) => Str.trim(line) !== "");
  // A trailing bracketed notice means the listing is incomplete, so its count would mislead.
  if (lines.length === 0 || /^\[[^\]]*\]$/u.test(Str.trim(lines.at(-1) ?? ""))) return undefined;
  return countLabel(lines.length, unit, PATH_LIST_PLURALS[unit]);
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
  const counts = { additions: count("added"), removals: count("removed") };
  // The collapsed preview says the same when a write leaves the file as it was.
  return counts.additions === 0 && counts.removals === 0 ? "no changes" : diffCountLabel(counts);
}

/** Added and removed line counts as `+4 −2`, with the Unicode minus. */
export function diffCountLabel(counts: { additions: number; removals: number }): string {
  return `+${counts.additions} −${counts.removals}`;
}
