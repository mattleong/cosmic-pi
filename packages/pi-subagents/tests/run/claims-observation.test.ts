import { describe, expect, it } from "vitest";
import {
  bashCommandMayMutate,
  classifyObservedWrite,
  observeFileWrite,
  systemTemporaryRoots,
} from "../../src/run/claims-observation.ts";

const classify = (cwd: string, path: string) => classifyObservedWrite(cwd, path, []);
const workspace = (path: string) => ({ kind: "workspace", path });

describe("write-claim tool observation", () => {
  it("extracts Pi and Claude native file-tool paths", () => {
    expect(observeFileWrite("write", { path: "src/pi.ts", content: "" })).toEqual(["src/pi.ts"]);
    expect(observeFileWrite("Edit", { file_path: "/project/src/claude.ts" })).toEqual([
      "/project/src/claude.ts",
    ]);
  });

  it("classifies workspace paths under any lexical or cwd-alias spelling", () => {
    for (const path of [
      "src/a.ts",
      "./src/a.ts",
      "src/../src/a.ts",
      "/project/src//a.ts",
      "/tmp/../project/src/a.ts",
      "/Project/SRC/a.ts",
    ])
      expect(classify("/project", path)).toEqual(
        workspace(path === "/Project/SRC/a.ts" ? "SRC/a.ts" : "src/a.ts"),
      );
    expect(classify("/", "/src/a.ts")).toEqual(workspace("src/a.ts"));
    expect(classify("/private/tmp/work", "/tmp/work/src/a.ts")).toEqual(workspace("src/a.ts"));
    expect(classify("/tmp/work", "/private/tmp/work/src/a.ts")).toEqual(workspace("src/a.ts"));
    expect(classify("/project", "/other/src/a.ts")).toEqual({ kind: "outside" });
    for (const path of ["/project", "src\\a.ts", "<outside workspace>", ""])
      expect(classify("/project", path)).toEqual({ kind: "unresolved" });
    expect(classify("/", "/<native-file-change-set-exceeded-observation-bound>")).toEqual({
      kind: "unresolved",
    });
  });

  it("exempts system temporary directories without exempting the workspace", () => {
    const roots = systemTemporaryRoots("/var/folders/xy/T");
    const temporaryKind = (cwd: string, path: string) =>
      classifyObservedWrite(cwd, path, roots).kind;
    expect(temporaryKind("/project", "/tmp/scratch.py")).toBe("temporary");
    expect(temporaryKind("/project", "/private/var/folders/xy/T/run/out.json")).toBe("temporary");
    expect(temporaryKind("/project", "../../tmp/scratch.py")).toBe("temporary");
    expect(temporaryKind("/project", "../elsewhere/notes.md")).toBe("outside");
    expect(temporaryKind("/project", "/tmp/../etc/hosts")).toBe("outside");
    expect(temporaryKind("/project", "/tmpfiles/a.ts")).toBe("outside");
    expect(temporaryKind("/project", "/tmp")).toBe("outside");
    expect(temporaryKind("/project", "/<native-file-change-set-exceeded-observation-bound>")).toBe(
      "unresolved",
    );
    // Roots at or above the cwd are ignored for that run, including a TMPDIR of $HOME or `/`.
    expect(temporaryKind("/private/tmp/work", "/private/tmp/other/scratch.py")).toBe("outside");
    expect(temporaryKind("/private/tmp/work", "/var/folders/xy/T/out.json")).toBe("temporary");
    expect(classifyObservedWrite("/Users/me/project", "/Users/me/notes.md", ["/Users/me"])).toEqual(
      { kind: "outside" },
    );
    expect(classifyObservedWrite("/project", "/etc/hosts", ["/"])).toEqual({ kind: "outside" });
  });

  it("recognizes Git mutations behind global options", () => {
    for (const command of [
      "git -C packages/app checkout -- src/a.ts",
      'git -C "my dir" stash',
      "git -c core.autocrlf=false stash pop",
      "git --git-dir=.git --work-tree . reset --hard",
      "git --no-pager cherry-pick abc123",
      "git revert HEAD",
      "git pull --rebase",
      "git am < fix.patch",
    ])
      expect(bashCommandMayMutate("bash", { command })).toBe(true);
    for (const command of [
      "git -C packages/app status",
      "git -c color.ui=never log --oneline",
      "git --no-pager diff HEAD",
      "git show HEAD:src/checkout.ts",
    ])
      expect(bashCommandMayMutate("bash", { command })).toBe(false);
  });
});
