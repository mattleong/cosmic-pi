import { describe, expect, it } from "vitest";
import { revisionReviewText } from "../../src/run/workspace-review.ts";
import { diffStatTotals, patchDiffStat } from "../../src/workspace/diffstat.ts";

const patch = [
  "diff --git a/src/main.ts b/src/main.ts",
  "index 1111111..2222222 100644",
  "--- a/src/main.ts",
  "+++ b/src/main.ts",
  "@@ -1,2 +1,3 @@",
  " keep",
  "-old",
  "+new",
  "+-- a line that starts like a header",
  "diff --git a/src/new.ts b/src/new.ts",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/src/new.ts",
  "@@ -0,0 +1 @@",
  "+added",
  "diff --git a/old.txt b/old.txt",
  "deleted file mode 100644",
  "--- a/old.txt",
  "+++ /dev/null",
  "@@ -1 +0,0 @@",
  "-gone",
  "diff --git a/image.bin b/image.bin",
  "index 3333333..4444444 100644",
  "GIT binary patch",
  "literal 4",
  "LcmZQzWMT#Y01f~L",
  "",
  "diff --git a/run.sh b/run.sh",
  "old mode 100644",
  "new mode 100755",
  "",
].join("\n");
const changedPaths = ["src/main.ts", "src/new.ts", "old.txt", "image.bin", "run.sh"];

describe("revision diffstat", () => {
  it("counts each file's lines and change kind from its patch section", () => {
    const stats = patchDiffStat(patch, changedPaths);
    expect(stats).toEqual([
      { path: "src/main.ts", change: "modified", binary: false, addedLines: 2, deletedLines: 1 },
      { path: "src/new.ts", change: "added", binary: false, addedLines: 1, deletedLines: 0 },
      { path: "old.txt", change: "deleted", binary: false, addedLines: 0, deletedLines: 1 },
      { path: "image.bin", change: "modified", binary: true, addedLines: 0, deletedLines: 0 },
      {
        path: "run.sh",
        change: "modified",
        binary: false,
        addedLines: 0,
        deletedLines: 0,
        modeChange: { from: "100644", to: "100755" },
      },
    ]);
    expect(diffStatTotals(stats ?? [])).toEqual({ addedLines: 3, deletedLines: 2 });
  });

  it("names no per-file counts when the sections don't match the changed paths", () => {
    expect(patchDiffStat(patch, ["src/main.ts"])).toBeUndefined();
  });

  it("leads the review text with every changed and left-out credential path before the diff", () => {
    const text = revisionReviewText({
      revisionId: "rev",
      changedPaths,
      uncapturedPaths: [".env", "keys/deploy.pem"],
      diff: patch,
    });
    const diffStart = text.indexOf("diff --git ");
    expect(text.endsWith(patch)).toBe(true);
    for (const path of [...changedPaths, ".env", "keys/deploy.pem"]) {
      const at = text.indexOf(path);
      expect(at, path).toBeGreaterThanOrEqual(0);
      expect(at, path).toBeLessThan(diffStart);
    }
  });
});
