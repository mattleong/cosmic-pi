import { describe, expect, test } from "vitest";
import * as Arr from "effect/Array";
import { applyGitNumstat, formatGitStatus, parseGitStatus } from "../src/footer/git.ts";

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
    });
  });

  test("totals numstat lines as git's shortstat does, counting replaced lines on both sides", () => {
    const status = parseGitStatus("## main\n M first.ts\n M second.ts\n")!;
    const withLines = applyGitNumstat(
      status,
      Arr.join(["10\t4\tfirst.ts", "2\t7\tsecond.ts", "-\t-\timage.png"], "\n"),
    );

    expect(withLines).toMatchObject({ linesAdded: 12, linesRemoved: 11 });
  });

  test("labels modified files in words, never with a `~` that reads as about", () => {
    const status = parseGitStatus("## main\n M first.ts\n?? new.ts\n")!;

    expect(formatGitStatus(status, true)).not.toContain("~");
  });
});
