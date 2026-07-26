import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import {
  requestCooperativeAbort,
  safeSubagentDirectorySegment,
  type ChildLaunchRequest,
} from "../src/boundary/child-process.ts";
import { buildClaudeCliArgs } from "../src/boundary/claude-process.ts";

describe("subagent child process boundary", () => {
  it("keeps untrusted session identifiers inside one directory segment", () => {
    expect(safeSubagentDirectorySegment("session-123")).toBe("session-123");
    const escaped = safeSubagentDirectorySegment("../../../../tmp/owned");
    expect(escaped).toMatch(/^id-[a-f0-9]{32}$/);
    expect(escaped).not.toContain("/");
    expect(safeSubagentDirectorySegment("../../../../tmp/owned")).toBe(escaped);
  });

  it("builds a subscription-compatible, explicitly restricted Claude command", () => {
    const request: ChildLaunchRequest = {
      runId: "agent-1",
      name: "claude-reviewer",
      backend: "claude-cli",
      cwd: "/project",
      context: "fresh",
      writeIntent: "read-only",
      model: "sonnet",
      effort: "high",
      activeTools: [],
      projectTrusted: true,
      parentSessionId: "parent",
      systemPrompt: "Supervised child prompt.",
    };
    const args = buildClaudeCliArgs(request, "550e8400-e29b-41d4-a716-446655440000");
    expect(args).toContain("-p");
    expect(args).toContain("stream-json");
    expect(args).toContain("--safe-mode");
    expect(args).not.toContain("--bare");
    expect(args).toContain("dontAsk");
    const readOnlyTools = args[args.indexOf("--tools") + 1]?.split(",") ?? [];
    const readOnlyDenied = args[args.indexOf("--disallowedTools") + 1]?.split(",") ?? [];
    expect(readOnlyTools).toEqual(["Read", "Glob", "Grep", "WebFetch", "WebSearch"]);
    expect(readOnlyTools).not.toEqual(expect.arrayContaining(["Edit", "Write", "Bash"]));
    expect(readOnlyDenied).toEqual(
      expect.arrayContaining(["Agent", "Task", "Workflow", "Edit", "Write", "Bash"]),
    );

    const writerArgs = buildClaudeCliArgs(
      { ...request, writeIntent: "writer" },
      "550e8400-e29b-41d4-a716-446655440000",
    );
    const writerTools = writerArgs[writerArgs.indexOf("--tools") + 1]?.split(",") ?? [];
    expect(writerTools).toEqual(expect.arrayContaining(["Read", "Edit", "Write", "Bash"]));

    const resumeArgs = buildClaudeCliArgs(
      { ...request, resumeSessionId: "550e8400-e29b-41d4-a716-446655440000" },
      "ignored-fresh-session-id",
    );
    expect(resumeArgs).toContain("--resume");
    expect(resumeArgs).not.toContain("--session-id");
  });

  it.effect("bounds a cooperative abort when stdin never drains", () =>
    Effect.gen(function* () {
      const abort = yield* requestCooperativeAbort(() => Effect.never).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* TestClock.adjust("250 millis");
      yield* Fiber.join(abort);
    }).pipe(Effect.scoped),
  );
});
