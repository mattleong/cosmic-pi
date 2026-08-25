import { describe, expect, it } from "vitest";
import {
  bashCommandMayMutate,
  observeFileWrite,
  workspaceRelativeObservedPath,
} from "../../src/run/claims-observation.ts";

describe("write-claim tool observation", () => {
  it("extracts Pi and Claude native file-tool paths", () => {
    expect(observeFileWrite("write", { path: "src/pi.ts", content: "" })).toEqual({
      toolName: "write",
      paths: ["src/pi.ts"],
    });
    expect(observeFileWrite("Edit", { file_path: "/project/src/claude.ts" })).toEqual({
      toolName: "Edit",
      paths: ["/project/src/claude.ts"],
    });
  });

  it("extracts bounded known paths from a Codex ApplyPatch change list", () => {
    expect(
      observeFileWrite("ApplyPatch", {
        changes: [
          { path: "src/a.ts", kind: { type: "update", move_path: "src/moved.ts" } },
          { filePath: "src/b.ts" },
          { ignored: "secret" },
        ],
      }),
    ).toEqual({
      toolName: "ApplyPatch",
      paths: ["src/a.ts", "src/moved.ts", "src/b.ts"],
    });
  });

  it("classifies workspace-relative and outside-workspace observations", () => {
    expect(workspaceRelativeObservedPath("/project", "/project/src/a.ts")).toBe("src/a.ts");
    expect(workspaceRelativeObservedPath("/", "/src/a.ts")).toBe("src/a.ts");
    expect(workspaceRelativeObservedPath("/project", "/other/src/a.ts")).toBeUndefined();
    expect(workspaceRelativeObservedPath("/project", "src/a.ts")).toBe("src/a.ts");
  });

  it("warns only for likely mutating Bash commands", () => {
    expect(bashCommandMayMutate("Bash", { command: "pnpm install" })).toBe(true);
    expect(bashCommandMayMutate("bash", { command: "git status --short" })).toBe(false);
    expect(bashCommandMayMutate("bash", { command: "pnpm test" })).toBe(false);
  });
});
