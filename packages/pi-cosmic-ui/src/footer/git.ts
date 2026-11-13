import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import { findOrUndefined } from "pi-cosmic-core/array";

export interface FooterGitStatus {
  staged: number;
  modified: number;
  untracked: number;
  conflicts: number;
  ahead: number;
  behind: number;
  linesAdded: number;
  linesRemoved: number;
}

const CONFLICT_CODES = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

export function parseGitStatus(output: string): FooterGitStatus | undefined {
  const lines = Arr.filter(Str.split(output, /\r?\n/), Str.isNonEmpty);
  const header = findOrUndefined(lines, (line) => Fn.pipe(line, Str.startsWith("## ")));
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

/** Totals lines added and removed as `git diff --shortstat` does; binary files count no lines. */
export function applyGitNumstat(status: FooterGitStatus, output: string): FooterGitStatus {
  let linesAdded = 0;
  let linesRemoved = 0;
  for (const line of Str.split(output, /\r?\n/)) {
    if (!line) continue;
    const [rawAdded, rawRemoved] = Str.split(line, "\t");
    if (!rawAdded || !rawRemoved || rawAdded === "-" || rawRemoved === "-") continue;
    const added = Number(rawAdded);
    const removed = Number(rawRemoved);
    if (!Number.isFinite(added) || !Number.isFinite(removed)) continue;
    linesAdded += added;
    linesRemoved += removed;
  }
  return { ...status, linesAdded, linesRemoved };
}

// Git-prompt signs: `!` modified and `=` conflicted keep `~` meaning "about", and `⇡`/`⇣` keep
// `↑`/`↓` for token direction.
const GIT_STATUS_PARTS = [
  ["conflicts", "=", "conflicted"],
  ["staged", "+", "staged"],
  ["modified", "!", "modified"],
  ["untracked", "?", "untracked"],
  ["ahead", "⇡", "ahead"],
  ["behind", "⇣", "behind"],
] as const satisfies ReadonlyArray<readonly [keyof FooterGitStatus, string, string]>;

/**
 * `!1 ?1 ⇡2` compactly, or `1 modified · 1 untracked · 2 ahead` when labeled: a label replaces its
 * sign rather than following it.
 */
export function formatGitStatus(status: FooterGitStatus, labeled = false): string {
  return Arr.join(
    Arr.flatMap(GIT_STATUS_PARTS, ([key, sign, label]) =>
      status[key] ? [labeled ? `${status[key]} ${label}` : `${sign}${status[key]}`] : [],
    ),
    labeled ? " · " : " ",
  );
}
