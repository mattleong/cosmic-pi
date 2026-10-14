import { recordingExtensionHost, extensionContextFixture } from "pi-cosmic-core/testing";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import {
  ACTIVE_RUNS_PROMPT_SECTION,
  activeRunsSection,
  registerActiveRunsPrompt,
} from "../src/boundary/host-active-runs-prompt.ts";
import type { SubagentProjection } from "../src/run/model.ts";
import { beforeAgentStartEvent } from "./fixtures/pi-host.ts";
import { projectionOf, view } from "./fixtures/run-view.ts";

const reviewer = view({
  id: "agent-1",
  name: "auth-review",
  profile: "reviewer",
  state: "running",
});

describe("active subagents prompt section", () => {
  it("lists only active direct children and ignores volatile progress", () => {
    const nested = view({ id: "agent-2", parentRunId: "agent-1", state: "running" });
    const done = view({ id: "agent-3", state: "completed" });
    const section = activeRunsSection(projectionOf([reviewer, nested, done]));
    expect(section).toContain("agent-1 · reviewer · auth-review · running");
    expect(section).not.toContain("agent-2");
    expect(section).not.toContain("agent-3");
    const later = activeRunsSection(
      projectionOf([{ ...reviewer, lastActivityAt: 99, progress: "read 40 files" }, nested, done]),
    );
    expect(later).toBe(section);
    expect(activeRunsSection(projectionOf([done]))).toBeUndefined();
  });

  it.effect("adds the section only while subagent tools are selected and children are active", () =>
    Effect.gen(function* () {
      let projection: SubagentProjection = projectionOf([reviewer]);
      const { pi, emit } = recordingExtensionHost();
      registerActiveRunsPrompt(pi, () => projection);
      const run = (selectedTools: string[]) =>
        Effect.gen(function* () {
          const event = beforeAgentStartEvent("go", { selectedTools });
          yield* Effect.promise(() => emit("before_agent_start", extensionContextFixture(), event));
          return event.systemPromptOptions.sections[ACTIVE_RUNS_PROMPT_SECTION];
        });
      expect(yield* run(["subagent_start"])).toContain("agent-1");
      expect(yield* run(["read"])).toBeUndefined();
      projection = projectionOf([{ ...reviewer, state: "completed" }]);
      expect(yield* run(["subagent_start"])).toBeUndefined();
    }),
  );
});
