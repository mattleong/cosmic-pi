import { countLabel } from "pi-cosmic-core";
import type { WorkspaceRevision } from "./model.ts";
import { blockingUncapturedPath, leftOutReason } from "./policy.ts";

/** One changed file of a proposal with Git's line counts; binary files count no lines. */
export interface WorkspaceDiffStatFile {
  readonly path: string;
  readonly change: "added" | "deleted" | "modified";
  readonly binary: boolean;
  readonly addedLines: number;
  readonly deletedLines: number;
  /** Old and new Git modes when the file's mode changed. */
  readonly modeChange?: { readonly from: string; readonly to: string } | undefined;
}

export const diffStatTotals = (files: ReadonlyArray<WorkspaceDiffStatFile>) => ({
  addedLines: files.reduce((total, file) => total + file.addedLines, 0),
  deletedLines: files.reduce((total, file) => total + file.deletedLines, 0),
});

// `git diff` sections start with this header at a line start; content lines never do, because
// each starts with a space, "+", "-", "\\", or (in binary patches) base85, which has no space.
const SECTION = "diff --git ";

const patchSections = (patch: string) => {
  const starts: number[] = [];
  for (let at = patch.indexOf(SECTION); at !== -1; at = patch.indexOf(SECTION, at + 1))
    if (at === 0 || patch[at - 1] === "\n") starts.push(at);
  return starts.map((start, index) => patch.slice(start, starts[index + 1] ?? patch.length));
};

const sectionStat = (path: string, section: string): WorkspaceDiffStatFile => {
  let change: WorkspaceDiffStatFile["change"] = "modified";
  let binary = false;
  let addedLines = 0;
  let deletedLines = 0;
  let from: string | undefined;
  let to: string | undefined;
  let header = true;
  for (const line of section.split("\n")) {
    if (header) {
      if (line.startsWith("@@")) header = false;
      else if (line.startsWith("new file mode ")) change = "added";
      else if (line.startsWith("deleted file mode ")) change = "deleted";
      else if (line.startsWith("old mode ")) from = line.slice("old mode ".length);
      else if (line.startsWith("new mode ")) to = line.slice("new mode ".length);
      else if (line === "GIT binary patch" || /^Binary files .* differ$/u.test(line)) binary = true;
    } else if (line.startsWith("+")) addedLines += 1;
    else if (line.startsWith("-")) deletedLines += 1;
  }
  return {
    path,
    change,
    binary,
    addedLines,
    deletedLines,
    ...(from !== undefined && to !== undefined && { modeChange: { from, to } }),
  };
};

/**
 * Per-file stats of a revision's patch, in `changedPaths` order, which `git diff` shares with
 * `git diff --name-only`; undefined when the patch's sections don't line up with those paths.
 */
export const patchDiffStat = (
  patch: string,
  changedPaths: ReadonlyArray<string>,
): ReadonlyArray<WorkspaceDiffStatFile> | undefined => {
  const sections = patchSections(patch);
  if (sections.length !== changedPaths.length) return undefined;
  return changedPaths.map((path, index) => sectionStat(path, sections[index] ?? ""));
};

const statLine = (file: WorkspaceDiffStatFile) => {
  const counts = file.binary ? "binary" : `+${file.addedLines} -${file.deletedLines}`;
  const mode = file.modeChange ? ` (mode ${file.modeChange.from} -> ${file.modeChange.to})` : "";
  return `  ${file.change} ${counts} ${file.path}${mode}`;
};

const MAX_SUMMARY_LEFT_OUT_PATHS = 20;

const pathList = (paths: ReadonlyArray<string>, limit = paths.length) =>
  `${paths.slice(0, limit).join(", ")}${paths.length > limit ? `, and ${paths.length - limit} more` : ""}`;

/**
 * The deterministic summary that leads a revision's review text: its diffstat and changed files,
 * then the worker files it can't carry. Paging covers the summary and patch as one text.
 */
export const revisionSummary = (revision: WorkspaceRevision): string => {
  const stats = patchDiffStat(revision.diff, revision.changedPaths);
  const files = countLabel(revision.changedPaths.length, "file");
  const totals = stats && diffStatTotals(stats);
  const uncaptured = revision.uncapturedPaths ?? [];
  const blocking = uncaptured.filter(blockingUncapturedPath);
  const leftOut = uncaptured.filter((path) => leftOutReason(path) === "dependency");
  const credentials = uncaptured.filter((path) => leftOutReason(path) === "credential");
  return [
    `SUMMARY: ${files} changed${totals ? `, +${totals.addedLines} -${totals.deletedLines}` : ""}`,
    ...(stats?.map(statLine) ?? revision.changedPaths.map((path) => `  changed ${path}`)),
    ...(blocking.length > 0
      ? [
          `Uncaptured worker files, absent from the diff (prepare and apply refuse until a revision leaves none): ${pathList(blocking)}`,
        ]
      : []),
    ...(leftOut.length > 0
      ? [
          `Left out on purpose (dependency, build, or Pi state directories; not part of the proposal): ${pathList(leftOut, MAX_SUMMARY_LEFT_OUT_PATHS)}`,
        ]
      : []),
    ...(credentials.length > 0
      ? [
          `Left out on purpose (credential files the worker created; not part of the proposal): ${pathList(credentials, MAX_SUMMARY_LEFT_OUT_PATHS)}`,
        ]
      : []),
    "END SUMMARY",
    "",
  ].join("\n");
};
