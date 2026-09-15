import { diffLines } from "diff";
import * as Predicate from "effect/Predicate";
import { getObjectValue } from "../shared/helpers";
import { shouldSkipWriteDiffBytes, shouldSkipWriteDiffComplexity } from "../write/diff";
import { isTruncated } from "./data/results";

const writeCounts = new WeakMap<object, { content: string; detail: string | undefined }>();

/** Never turn partially validated operations into a successful operation total. */
export function editResultDetail<Args>(args: Args): string | undefined {
  const edits = getObjectValue(args, "edits");
  const operations = Array.isArray(edits) ? edits : [args];
  if (!operations.length || operations.length > 64) return undefined;
  for (const operation of operations) {
    const oldText = getObjectValue(operation, "oldText") ?? getObjectValue(operation, "old_text");
    const newText = getObjectValue(operation, "newText") ?? getObjectValue(operation, "new_text");
    if (
      !Predicate.isString(oldText) ||
      !oldText ||
      !Predicate.isString(newText) ||
      oldText === newText
    )
      return undefined;
  }
  return `${operations.length} ${operations.length === 1 ? "edit" : "edits"}`;
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
  return count ? `${count} matching ${count === 1 ? "line" : "lines"}` : undefined;
}

/** Snapshot-keyed, bounded diff work is reused across redraws. */
export function writeResultDetail<Before>(before: Before, content: string): string | undefined {
  if (!Predicate.isObject(before) || getObjectValue(before, "kind") !== "content") return undefined;
  const previous = getObjectValue(before, "content");
  if (!Predicate.isString(previous)) return undefined;
  const cached = writeCounts.get(before);
  if (cached?.content === content) return cached.detail;
  let detail: string | undefined;
  if (
    previous.length <= 64_000 &&
    content.length <= 64_000 &&
    !shouldSkipWriteDiffBytes(previous, content) &&
    !shouldSkipWriteDiffComplexity(previous, content)
  ) {
    const changes = diffLines(previous, content, { maxEditLength: 256 });
    if (changes) {
      let added = 0;
      let removed = 0;
      for (const change of changes) {
        if (change.added) added += change.count ?? 0;
        if (change.removed) removed += change.count ?? 0;
      }
      detail = `+${added}/-${removed} lines`;
    }
  }
  writeCounts.set(before, { content, detail });
  return detail;
}
