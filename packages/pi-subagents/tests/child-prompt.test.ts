import { describe, expect, it } from "vitest";
import type { StartSubagentRequest } from "../src/run/model.ts";
import { childSystemPrompt, taskPrompt } from "../src/run/tool-policy.ts";
import { request } from "./run/fixtures/service-harness.ts";

const workspace = (cwd: string) => ({
  workspaceId: `ws-${cwd}`,
  ownerId: "root",
  sourceCwd: "/repo",
  sourceRoot: "/repo",
  cwd,
});

const writer = (task: string, cwd: string) =>
  request({
    task,
    profile: "worker",
    profileGuidance: "Act as a worker.",
    writeIntent: "writer",
    writerWorkspaceMode: "worktree",
    workspace: workspace(cwd),
  });

const ownsChildWorkspaces = (overrides: Partial<StartSubagentRequest>) =>
  childSystemPrompt(request(overrides)).includes("subagent_workspace");

describe("child prompts", () => {
  it("keeps per-run paths out of the system prompt so sibling writers share it", () => {
    const first = writer("Edit src/a.ts", "/private/ws-1");
    const second = writer("Edit src/b.ts", "/private/ws-2");
    expect(childSystemPrompt(first)).toBe(childSystemPrompt(second));
    expect(childSystemPrompt(first)).not.toContain("src/a.ts");
    const task = taskPrompt(first, "No peers.");
    expect(task).toContain("src/a.ts");
    expect(task).toContain("/private/ws-1");
  });

  it("tells only admitted Pi worktree writers that they own child workspaces", () => {
    const worktree = {
      writeIntent: "writer",
      writerWorkspaceMode: "worktree",
      workspace: workspace("/private/ws-1"),
    } as const;
    expect(ownsChildWorkspaces(worktree)).toBe(true);
    expect(ownsChildWorkspaces({})).toBe(false);
    expect(
      ownsChildWorkspaces({ writeIntent: "writer", writerWorkspaceMode: "shared-checkout" }),
    ).toBe(false);
    expect(ownsChildWorkspaces({ ...worktree, workspace: undefined })).toBe(false);
    expect(ownsChildWorkspaces({ ...worktree, runtime: "claude" })).toBe(false);
    expect(ownsChildWorkspaces({ ...worktree, runtime: "codex" })).toBe(false);
  });
});
