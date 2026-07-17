import { describe, expect, test } from "vitest";
import { applyGitNumstat, formatGitStatus, parseGitStatus } from "../src/footer/git.ts";

describe("git footer status", () => {
  test("summarizes staged, modified, untracked, conflicted, and diverged files", () => {
    const status = parseGitStatus(
      [
        "## main...origin/main [ahead 2, behind 1]",
        "M  staged.ts",
        " M modified.ts",
        "?? new.ts",
        "UU conflict.ts",
      ].join("\n"),
    );

    expect(status).toEqual({
      staged: 1,
      modified: 1,
      untracked: 1,
      conflicts: 1,
      ahead: 2,
      behind: 1,
      linesAdded: 0,
      linesRemoved: 0,
      linesChanged: 0,
    });
    expect(formatGitStatus(status!)).toBe("!1 +1 ~1 ?1 ↑2 ↓1");
  });

  test("classifies numstat replacements separately from pure additions and removals", () => {
    const status = parseGitStatus("## main\n M first.ts\n M second.ts\n")!;
    const withLines = applyGitNumstat(
      status,
      ["10\t4\tfirst.ts", "2\t7\tsecond.ts", "-\t-\timage.png"].join("\n"),
    );

    expect(withLines).toMatchObject({ linesAdded: 6, linesRemoved: 5, linesChanged: 6 });
  });

  test("hides clean repository status and ignores non-repository output", () => {
    expect(formatGitStatus(parseGitStatus("## main...origin/main\n")!)).toBe("");
    expect(parseGitStatus("fatal: not a git repository")).toBeUndefined();
  });
});
