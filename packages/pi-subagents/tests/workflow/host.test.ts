import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { SubagentBackendRegistry } from "../../src/backend/service.ts";
import { makeWorkflowHost } from "../../src/boundary/host-workflow.ts";
import { SubagentProfileService } from "../../src/profiles/service.ts";
import type { WorkflowAgentOptions } from "../../src/workflow/options.ts";
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

const rejection = (options: WorkflowAgentOptions) =>
  host().pipe(
    Effect.flatMap((workflowHost) => workflowHost.checkAgent(options)),
    Effect.flip,
    Effect.map((error) => error.message),
  );

describe("workflow host", () => {
  it.effect("rejects agent() calls no route could admit", () =>
    Effect.gen(function* () {
      const unknown = yield* rejection({ profile: "nonexistent" });
      expect(unknown).toContain("nonexistent");
      expect(unknown).toContain("scout");
      expect(yield* rejection({ profile: "scout", writes: ["a.ts"] })).toContain("writer");
      expect(yield* rejection({ isolation: "worktree" })).toContain("writer");
      expect(yield* rejection({ profile: "worker", writes: ["/etc/passwd"] })).toContain("writes");
    }),
  );

  it.effect("accepts writer options on a writer profile and reports each profile's access", () =>
    Effect.gen(function* () {
      const workflowHost = yield* host();
      const writer = { profile: "worker", writes: ["src/a.ts"], isolation: "worktree" } as const;
      expect(yield* workflowHost.checkAgent(writer)).toBe("writer");
      expect(yield* workflowHost.checkAgent({ profile: "worker" })).toBe("writer");
      expect(yield* workflowHost.checkAgent({})).toBe("read-only");
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
