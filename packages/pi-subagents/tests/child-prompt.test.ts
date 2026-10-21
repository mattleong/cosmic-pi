import { describe, expect, it } from "vitest";
import type { StartSubagentRequest } from "../src/run/model.ts";
import { childSystemPrompt, taskPrompt } from "../src/run/tool-policy.ts";
import { request } from "./run/fixtures/service-harness.ts";

const workspace = (cwd: string) => ({
  workspaceId: `ws-${cwd}`,
  ownerId: "root",
  sourceCwd: "/repo",
  sourceRoot: "/repo",
  artifactRoot: cwd,
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

const offersWorktrees = (overrides: Partial<StartSubagentRequest>) =>
  childSystemPrompt(request(overrides)).includes("agent_worktree");

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

  it("offers no child, not even a worktree writer, worktrees of its own", () => {
    const worktree = {
      writeIntent: "writer",
      writerWorkspaceMode: "worktree",
      workspace: workspace("/private/ws-1"),
    } as const;
    expect(offersWorktrees(worktree)).toBe(false);
    expect(offersWorktrees({})).toBe(false);
    expect(offersWorktrees({ writeIntent: "writer", writerWorkspaceMode: "shared-checkout" })).toBe(
      false,
    );
  });
});
