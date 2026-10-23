import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Str from "effect/String";

export interface FooterGitStatus {
  staged: number;
  modified: number;
  untracked: number;
  conflicts: number;
  ahead: number;
  behind: number;
  linesAdded: number;
  linesRemoved: number;
  linesChanged: number;
}

const CONFLICT_CODES = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

export function parseGitStatus(output: string): FooterGitStatus | undefined {
  const lines = Arr.filter(Str.split(output, /\r?\n/), Str.isNonEmpty);
  const header = Option.getOrUndefined(
    Arr.findFirst(lines, (line) => Fn.pipe(line, Str.startsWith("## "))),
  );
  if (header === undefined) return undefined;

  const status: FooterGitStatus = {
    staged: 0,
    modified: 0,
    untracked: 0,
    conflicts: 0,
    ahead: Number(Option.getOrUndefined(Fn.pipe(header, Str.match(/\bahead (\d+)/)))?.[1] ?? 0),
    behind: Number(Option.getOrUndefined(Fn.pipe(header, Str.match(/\bbehind (\d+)/)))?.[1] ?? 0),
    linesAdded: 0,
    linesRemoved: 0,
    linesChanged: 0,
  };

  for (const line of lines) {
    if (Fn.pipe(line, Str.startsWith("## ")) || line.length < 2) continue;
    const code = Fn.pipe(line, Str.slice(0, 2));
    if (code === "??") {
      status.untracked++;
      continue;
    }
    if (code === "!!") continue;
    if (CONFLICT_CODES.has(code) || Fn.pipe(code, Str.includes("U"))) {
      status.conflicts++;
      continue;
    }
    if (!Fn.pipe(code, Str.startsWith(" "))) status.staged++;
    if (code[1] !== " ") status.modified++;
  }

  return status;
}

export function applyGitNumstat(status: FooterGitStatus, output: string): FooterGitStatus {
  let linesAdded = 0;
  let linesRemoved = 0;
  let linesChanged = 0;
  for (const line of Str.split(output, /\r?\n/)) {
    if (!line) continue;
    const [rawAdded, rawRemoved] = Str.split(line, "\t");
    if (!rawAdded || !rawRemoved || rawAdded === "-" || rawRemoved === "-") continue;
    const added = Number(rawAdded);
    const removed = Number(rawRemoved);
    if (!Number.isFinite(added) || !Number.isFinite(removed)) continue;
    const changed = Math.min(added, removed);
    linesChanged += changed;
    linesAdded += added - changed;
    linesRemoved += removed - changed;
  }
  return { ...status, linesAdded, linesRemoved, linesChanged };
}

export function formatGitStatus(status: FooterGitStatus): string {
  const parts: string[] = [];
  if (status.conflicts) parts.push(`!${status.conflicts}`);
  if (status.staged) parts.push(`+${status.staged}`);
  if (status.modified) parts.push(`~${status.modified}`);
  if (status.untracked) parts.push(`?${status.untracked}`);
  if (status.ahead) parts.push(`↑${status.ahead}`);
  if (status.behind) parts.push(`↓${status.behind}`);
  return Arr.join(parts, " ");
}
