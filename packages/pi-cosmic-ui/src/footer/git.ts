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
  const lines = output.split(/\r?\n/).filter(Boolean);
  const header = lines.find((line) => line.startsWith("## "));
  if (header === undefined) return undefined;

  const status: FooterGitStatus = {
    staged: 0,
    modified: 0,
    untracked: 0,
    conflicts: 0,
    ahead: Number(header.match(/\bahead (\d+)/)?.[1] ?? 0),
    behind: Number(header.match(/\bbehind (\d+)/)?.[1] ?? 0),
    linesAdded: 0,
    linesRemoved: 0,
    linesChanged: 0,
  };

  for (const line of lines) {
    if (line.startsWith("## ") || line.length < 2) continue;
    const code = line.slice(0, 2);
    if (code === "??") {
      status.untracked++;
      continue;
    }
    if (code === "!!") continue;
    if (CONFLICT_CODES.has(code) || code.includes("U")) {
      status.conflicts++;
      continue;
    }
    if (code[0] !== " ") status.staged++;
    if (code[1] !== " ") status.modified++;
  }

  return status;
}

export function applyGitNumstat(status: FooterGitStatus, output: string): FooterGitStatus {
  let linesAdded = 0;
  let linesRemoved = 0;
  let linesChanged = 0;
  for (const line of output.split(/\r?\n/)) {
    if (!line) continue;
    const [rawAdded, rawRemoved] = line.split("\t", 3);
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
  return parts.join(" ");
}
