import { describe, expect, test } from "vitest";
import * as Arr from "effect/Array";
import { applyGitNumstat, parseGitStatus } from "../src/footer/git.ts";

describe("git footer status", () => {
  test("summarizes staged, modified, untracked, conflicted, and diverged files", () => {
    const status = parseGitStatus(
      Arr.join(
        [
          "## main...origin/main [ahead 2, behind 1]",
          "M  staged.ts",
          " M modified.ts",
          "?? new.ts",
          "UU conflict.ts",
        ],
        "\n",
      ),
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
  });

  test("classifies numstat replacements separately from pure additions and removals", () => {
    const status = parseGitStatus("## main\n M first.ts\n M second.ts\n")!;
    const withLines = applyGitNumstat(
      status,
      Arr.join(["10\t4\tfirst.ts", "2\t7\tsecond.ts", "-\t-\timage.png"], "\n"),
    );

    expect(withLines).toMatchObject({ linesAdded: 6, linesRemoved: 5, linesChanged: 6 });
  });
});
