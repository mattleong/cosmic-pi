import type { Theme } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Result from "effect/Result";
import * as Str from "effect/String";
import * as Struct from "effect/Struct";
import { clipProse, countLabel } from "pi-cosmic-core/display";
import { layoutTaggedCompactRow, compactSingleLine, type CompactRowInput } from "./compact-row";
import { renderCompactChildren, selectCompactChildren } from "./compact-children";
import { renderCompactIssues, repeatsIssueMessage } from "./compact-issues";
import { mergeCompactIssues, type CompactIssue } from "../tools/compact-issues";
import type { CompactChild, CompactSummary } from "../tools/compact-summary";

// A lifted problem names its call in at most this many characters of the call's subject.
const CHILD_SUBJECT_LIMIT = 40;
// A settled row lifts at most this many of its hidden calls' problems; one line counts the rest.
const MAX_CHILD_PROBLEMS = 5;

const CHILD_FAILED = "child-failed";

const problemsOf = (child: CompactChild): readonly CompactIssue[] => {
  // Errors, warnings, and questions: the issues a collapsed row shows.
  const problems = Arr.filter(child.issues ?? [], (issue) => issue.severity !== "info");
  if (problems.length > 0 || child.status !== "error") return problems;
  return [{ severity: "error", code: CHILD_FAILED, message: "failed" }];
};

const childName = (child: CompactChild): string => {
  const subject = compactSingleLine(child.compactSubject ?? child.subject ?? "");
  const label = compactSingleLine(child.label);
  return Str.isNonEmpty(subject) ? `${label} ${clipProse(subject, CHILD_SUBJECT_LIMIT)}` : label;
};

/**
 * The problems of a settled row's nested calls, which its collapsed row lifts beneath itself once
 * the call tree is hidden: each names its call, so a failed call never disappears with the tree.
 * A problem the row's own issues already state isn't lifted again.
 */
function childProblemIssues(summary: CompactSummary): CompactIssue[] {
  const { children, issues } = summary;
  if (!children) return [];
  const troubled = Arr.filter(children.entries, (child) =>
    Arr.some(problemsOf(child), (issue) => !repeatsIssueMessage(issue.message, issues)),
  );
  const { entries } = selectCompactChildren(
    { entries: troubled, total: troubled.length },
    MAX_CHILD_PROBLEMS,
  );
  const shown = new Set(entries);
  const lifted = Arr.flatMap(entries, (child) =>
    Arr.filterMap(
      problemsOf(child),
      (issue): Result.Result<CompactIssue, void> =>
        repeatsIssueMessage(issue.message, issues)
          ? Result.failVoid
          : Result.succeed({
              severity: issue.severity,
              code: issue.code,
              message:
                issue.code === CHILD_FAILED
                  ? `${childName(child)} failed`
                  : `${childName(child)}: ${issue.message}`,
            }),
    ),
  );
  const rest = Arr.filter(troubled, (child) => !shown.has(child));
  if (rest.length === 0) return mergeCompactIssues(lifted);
  const more = countLabel(rest.length, "more call");
  return mergeCompactIssues(lifted, [
    Arr.every(rest, (child) => child.status === "error")
      ? { severity: "error", code: "child-problems-omitted", message: `${more} failed` }
      : {
          severity: Arr.some(rest, (child) => child.status === "error") ? "error" : "warning",
          code: "child-problems-omitted",
          message: `${more} with problems`,
        },
  ]);
}

/**
 * A collapsed compact call: its one heading row, then one line per problem or pending question.
 * Everything else waits for expansion. While the call is pending or running its live call tree
 * (`children`) shows beneath the row; once it settles the tree hides, and the problems of its
 * calls are lifted beneath the row instead. The row ends in its tag, `▸ label` or a bare `▸`, when
 * expansion reveals more (`expandLabel`), unless the tag would reveal only a subject the row shows
 * whole (`expandsSubjectOnly`) and nothing else is hidden.
 */
export function renderCompactToolCall(
  input: CompactRowInput & { readonly expandLabel?: string | undefined },
  theme: Theme,
  width: number,
): string[] {
  if (width <= 0) return [];
  const { summary } = input;
  const live = input.phase !== "settled";
  const hiddenTree = !live && (summary.children?.total ?? 0) > 0;
  // A hidden call tree is more than the subject, so the tag stays.
  const row = hiddenTree
    ? { ...input, summary: Struct.omit(summary, ["expandsSubjectOnly"]) }
    : input;
  const layout = layoutTaggedCompactRow(row, theme, width, input.expandLabel);
  return [
    layout.row,
    ...renderCompactIssues(summary.issues, theme, width),
    ...(live
      ? renderCompactChildren(summary.children, theme, width, {
          animationFrame: input.animationFrame,
          timingEnabled: input.timingEnabled,
        })
      : renderCompactIssues(childProblemIssues(summary), theme, width)),
  ];
}
