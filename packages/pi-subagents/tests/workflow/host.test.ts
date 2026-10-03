import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { SubagentBackendRegistry } from "../../src/backend/service.ts";
import { makeWorkflowHost } from "../../src/boundary/host-workflow.ts";
import { SubagentProfileService } from "../../src/profiles/service.ts";
import type { WorkflowAgentSpec } from "../../src/workflow/agent.ts";
import { extensionApiFixture } from "../fixtures/pi-host.ts";
import { context, profileServiceFor, testBackendRegistry } from "../tools/fixtures/tool-harness.ts";

const host = (profiles = profileServiceFor(undefined)) =>
  makeWorkflowHost(
    extensionApiFixture({ getThinkingLevel: () => "high", getActiveTools: () => ["read"] }),
    context,
    { cwd: "/project", projectTrusted: true },
  ).pipe(
    Effect.provideService(SubagentProfileService, profiles),
    Effect.provideService(SubagentBackendRegistry, testBackendRegistry),
  );

const rejection = (spec: WorkflowAgentSpec) =>
  host().pipe(
    Effect.flatMap((workflowHost) => workflowHost.checkAgent(spec)),
    Effect.flip,
    Effect.map((error) => error.message),
  );

describe("workflow host", () => {
  it.effect("rejects agent() calls no route could admit", () =>
    Effect.gen(function* () {
      expect(yield* rejection({ task: "t", name: "a", profile: "nonexistent" })).toContain(
        "nonexistent",
      );
      expect(
        yield* rejection({ task: "t", name: "a", profile: "scout", writes: ["a.ts"] }),
      ).toContain("writer");
      expect(yield* rejection({ task: "t", name: "a", isolation: "worktree" })).toContain("writer");
      expect(
        yield* rejection({ task: "t", name: "a", profile: "worker", writes: ["/etc/passwd"] }),
      ).toContain("writes");
    }),
  );

  it.effect("accepts writer options on a writer profile", () =>
    Effect.gen(function* () {
      const workflowHost = yield* host();
      yield* workflowHost.checkAgent({
        task: "t",
        name: "a",
        profile: "worker",
        writes: ["src/a.ts"],
        isolation: "worktree",
      });
    }),
  );

  it.effect("resolves launches with the session's nesting policy", () =>
    Effect.gen(function* () {
      const profiles = profileServiceFor({ nesting: { maxDirectChildren: 3, maxDepth: 2 } });
      const workflowHost = yield* host(profiles);
      const request = yield* workflowHost.resolveAgent({ task: "Map the code", name: "mapper" });
      expect(request).toMatchObject({
        task: "Map the code",
        name: "mapper",
        profile: "generalist",
        nestingPolicy: { maxDirectChildren: 3, maxDepth: 2 },
      });
    }),
  );
});
