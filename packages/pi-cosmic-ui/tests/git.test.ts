import { describe, expect, test } from "vitest";
import { formatGitStatus, parseGitStatus } from "../src/footer/git.ts";

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
    });
    expect(formatGitStatus(status!)).toBe("!1 +1 ~1 ?1 ↑2 ↓1");
  });

  test("reports a clean repository and ignores non-repository output", () => {
    expect(formatGitStatus(parseGitStatus("## main...origin/main\n")!)).toBe("clean");
    expect(parseGitStatus("fatal: not a git repository")).toBeUndefined();
  });
});
