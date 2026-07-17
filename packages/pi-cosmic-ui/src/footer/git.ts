export interface FooterGitStatus {
  staged: number;
  modified: number;
  untracked: number;
  conflicts: number;
  ahead: number;
  behind: number;
}

const CONFLICT_CODES = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

export function parseGitStatus(output: string): FooterGitStatus | undefined {
  const lines = output.split(/\r?\n/).filter(Boolean);
  if (!lines.some((line) => line.startsWith("## "))) return undefined;

  const status: FooterGitStatus = {
    staged: 0,
    modified: 0,
    untracked: 0,
    conflicts: 0,
    ahead: 0,
    behind: 0,
  };

  const header = lines.find((line) => line.startsWith("## ")) ?? "";
  status.ahead = Number(header.match(/\bahead (\d+)/)?.[1] ?? 0);
  status.behind = Number(header.match(/\bbehind (\d+)/)?.[1] ?? 0);

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

export function formatGitStatus(status: FooterGitStatus): string {
  const parts: string[] = [];
  if (status.conflicts) parts.push(`!${status.conflicts}`);
  if (status.staged) parts.push(`+${status.staged}`);
  if (status.modified) parts.push(`~${status.modified}`);
  if (status.untracked) parts.push(`?${status.untracked}`);
  if (status.ahead) parts.push(`↑${status.ahead}`);
  if (status.behind) parts.push(`↓${status.behind}`);
  return parts.length ? parts.join(" ") : "clean";
}
