import { describe, expect, it } from "vitest";
import { withHerdrSupervisorInstructions } from "../src/backend/herdr.ts";
import type { BackendLaunchRequest } from "../src/backend/model.ts";

const request = (writeIntent: "read-only" | "writer" = "read-only"): BackendLaunchRequest => ({
  runId: "agent-r1-1",
  name: "nested-policy",
  closeOnReport: true,
  cwd: "/project",
  context: "fresh",
  writeIntent,
  fastMode: false,
  model: "openai-codex/gpt-5.6-sol",
  effort: "high",
  activeTools: ["subagent_start", "code_mode"],
  projectTrusted: true,
  parentSessionId: "root-session",
  systemPrompt: "Complete the assignment.",
});

describe("Herdr backend policy", () => {
  it.each(["pi", "claude", "codex"] as const)(
    "permits owned delegation surfaces while rejecting competing ones for %s",
    (runtime) => {
      const systemPrompt = withHerdrSupervisorInstructions(runtime, request()).systemPrompt;

      expect(systemPrompt).toContain("package-owned authenticated subagent proxies");
      expect(systemPrompt).toContain("native agent controls explicitly enabled by this runtime");
      expect(systemPrompt).toContain("competing orchestration tools");
      expect(systemPrompt).not.toContain("Never delegate");
    },
  );
});
