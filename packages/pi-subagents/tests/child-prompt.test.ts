import { describe, expect, it } from "vitest";
import { childSystemPrompt, taskPrompt } from "../src/run/tool-policy.ts";
import { request } from "./run/fixtures/service-harness.ts";

const writer = (writes: ReadonlyArray<string>, cwd: string) =>
  request({
    profile: "worker",
    profileGuidance: "Act as a worker.",
    writeIntent: "writer",
    writes,
    workspace: {
      workspaceId: `ws-${cwd}`,
      ownerId: "root",
      sourceCwd: "/repo",
      sourceRoot: "/repo",
      cwd,
    },
  });

describe("child prompts", () => {
  it("keeps per-run paths out of the system prompt so sibling writers share it", () => {
    const first = writer(["src/a.ts"], "/private/ws-1");
    const second = writer(["src/b.ts"], "/private/ws-2");
    expect(childSystemPrompt(first)).toBe(childSystemPrompt(second));
    expect(childSystemPrompt(first)).not.toContain("src/a.ts");
    const task = taskPrompt(first, "No peers.");
    expect(task).toContain("src/a.ts");
    expect(task).toContain("/private/ws-1");
  });

  it("tells a forked child, and only a forked child, how to treat inherited history", () => {
    const fresh = taskPrompt(request({ task: "Assess the plan." }), "No peers.");
    const forked = taskPrompt(request({ task: "Assess the plan.", context: "fork" }), "No peers.");
    expect(forked).not.toBe(fresh);
    expect(forked.endsWith(fresh.slice(fresh.indexOf("Assigned task:")))).toBe(true);
  });
});
