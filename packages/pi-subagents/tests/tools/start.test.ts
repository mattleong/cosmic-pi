import {
  initTheme,
  type AgentToolResult,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Match from "effect/Match";
import { beforeAll, describe, expect, vi } from "vitest";
import { effectTest, step } from "../support/effect-test.ts";
import {
  resolveProfileStart,
  type SubagentProfileStartSpec,
} from "../../src/boundary/host-profile-resolution.ts";
import {
  SubagentBackendRegistry,
  type BackendSelection,
  type SubagentBackendRegistryContract,
} from "../../src/backend/service.ts";
import { PROFILE_IDS, type DeclaredProfileCandidate } from "../../src/profiles/model.ts";
import { SubagentProfileService } from "../../src/profiles/service.ts";
import {
  invalidRequest,
  type InvalidSubagentRequestError,
  SubagentProcessError,
} from "../../src/run/errors.ts";
import { decodeSubagentEffort } from "../../src/domain/routing.ts";
import type { StartSubagentRequest } from "../../src/run/model.ts";
import { SubagentService } from "../../src/run/service.ts";
import { executeSubagentActionEffect } from "../../src/tools/execute.ts";
import {
  decodeSubagentProxyResult,
  encodeSubagentProxyPayload,
} from "../../src/tools/proxy-protocol.ts";
import { SubagentStartDetailsSchema } from "../../src/tools/details-schema.ts";
import { subagentServiceDouble } from "./fixtures/subagent-service-double.ts";
import {
  type CaptureOptions,
  captureSubagentTools,
  executeTool,
  invokeOptionalTool,
  context,
  fallbackProfileService,
  profileServiceFor,
  startCapturingService,
  testBackendDriver,
  testBackendRegistry,
  view,
} from "./fixtures/tool-harness.ts";
import { extensionApiFixture, extensionContextFixture, modelFixture } from "pi-cosmic-core/testing";
import { stringContaining } from "../support/matchers.ts";

const route = (overrides: Partial<DeclaredProfileCandidate> = {}): DeclaredProfileCandidate => ({
  host: "local",
  runtime: "pi",
  model: "parent",
  effort: "default",
  context: "fresh",
  writeIntent: "read-only",
  ...overrides,
});

const decodeStartDetails = Schema.decodeUnknownSync(SubagentStartDetailsSchema);

const startTool = (requests: StartSubagentRequest[], options?: CaptureOptions) =>
  captureSubagentTools(startCapturingService(requests), options).get("subagent_start");

const driver = (selection: BackendSelection) => ({
  ...testBackendDriver,
  runtime: selection.runtime,
});

const preflightRegistry = (
  reject: (selection: BackendSelection) => InvalidSubagentRequestError | undefined,
): SubagentBackendRegistryContract => {
  return {
    resolve: (selection) => Effect.succeed(driver(selection)),
    preflight: (selection) => {
      const failure = reject(selection);
      return failure ? Effect.fail(failure) : Effect.succeed(driver(selection));
    },
  };
};

describe("subagent tool", () => {
  beforeAll(() => initTheme("dark", false));

  effectTest(
    "uses short-form defaults and snapshots ordered root tools without write-intent filtering",
    function* () {
      let request: StartSubagentRequest | undefined;
      const service = subagentServiceDouble({
        start: (input) => Effect.sync(() => ((request = input), view())),
      });
      const tool = captureSubagentTools(service, {
        activeTools: [
          "read",
          "grep",
          "edit",
          "write",
          "bash",
          "mcp",
          "read",
          "subagent_start",
          "subagent_future",
          "subagent_await",
          "herdr_agent_start",
          "herdr_agent_future",
          "workflow",
          "workflow_control",
          "workflow_future",
        ],
      }).get("subagent_start");

      const result = yield* invokeOptionalTool(tool, {
        agents: [{ task: "Review auth" }],
      });

      expect(result?.content[0]?.text).toContain("agent-1");
      expect(request).toMatchObject({
        profile: "generalist",
        profileGuidance: stringContaining("Act as a generalist"),
        selection: { source: "profile-parent-candidate", skippedCandidates: [] },
        context: "fresh",
        model: "openai-codex/gpt-5.6-sol",
        effort: "high",
        writeIntent: "read-only",
        parentLeafId: "user-1",
        activeTools: ["read", "grep", "edit", "write", "bash", "mcp"],
      });
    },
  );

  effectTest("resolves authenticated child starts through the caller's session", function* () {
    const callers: Array<readonly [string, string | undefined]> = [];
    const service = subagentServiceDouble({
      startSessionOwnedFrom: (callerRunId, request) =>
        Effect.sync(() => {
          callers.push([callerRunId, request.profile]);
          return view({ id: `child-${callers.length}`, profile: request.profile });
        }),
    });
    const proxied = yield* executeSubagentActionEffect(
      extensionApiFixture({
        getThinkingLevel: () => "high",
        getActiveTools: () => ["read"],
      }),
      { cwd: "/project", projectTrusted: true },
      {
        tool: "subagent_start",
        args: {
          agents: [
            { task: "Map the entry points", profile: "scout" },
            { task: "Assess the finished change for regressions" },
          ],
        },
      },
      undefined,
      context,
      "authenticated-caller",
    ).pipe(
      Effect.provideService(SubagentService, service),
      Effect.provideService(SubagentProfileService, fallbackProfileService),
      Effect.provideService(SubagentBackendRegistry, testBackendRegistry),
      Effect.orDie,
    );
    expect(callers).toEqual([
      ["authenticated-caller", "scout"],
      ["authenticated-caller", "generalist"],
    ]);
    expect(proxied.usage).toBeUndefined();
    expect(decodeSubagentProxyResult(encodeSubagentProxyPayload(proxied) ?? "")).toBeDefined();
  });

  effectTest("releases persistent start presentation after execution settles", function* () {
    const release = vi.fn();
    const presentation = {
      beginStart: vi.fn(() => release),
      beginAwait: vi.fn(() => () => undefined),
      isLiveHierarchyAvailable: vi.fn(() => true),
    };
    const tool = startTool([], { toolPresentation: presentation });

    yield* invokeOptionalTool(tool, { agents: [{ task: "Review auth" }] });

    expect(presentation.beginStart).toHaveBeenCalledWith(1);
    expect(release).toHaveBeenCalledOnce();
  });

  effectTest("includes effective and source workspaces in launch receipts", function* () {
    for (const writerWorkspaceMode of ["worktree", "shared-checkout"] as const) {
      const workspace =
        writerWorkspaceMode === "worktree"
          ? { workspaceId: "workspace-1", cwd: "/private/workspace-1", sourceCwd: "/project" }
          : { cwd: "/project" };
      const service = subagentServiceDouble({
        start: () =>
          Effect.succeed(view({ writeIntent: "writer", writerWorkspaceMode, ...workspace })),
      });
      const tool = captureSubagentTools(service).get("subagent_start");
      const result = yield* invokeOptionalTool(tool, {
        agents: [{ task: "Implement token parsing", profile: "worker" }],
      });
      expect(result?.details).toMatchObject({
        startEntries: [{ status: "started", writerWorkspaceMode, ...workspace }],
      });
      expect(result?.content[0]?.text).toContain(writerWorkspaceMode);
      expect(result?.content[0]?.text).toContain(workspace.cwd);
    }
  });

  effectTest("threads exact writes claims only through writer profiles", function* () {
    const requests: StartSubagentRequest[] = [];
    const start = startTool(requests);

    const result = yield* invokeOptionalTool(start, {
      agents: [
        {
          task: "Implement token parsing",
          profile: "worker",
          writes: ["packages/auth/src/token.ts", "packages/auth/tests/token.test.ts"],
        },
      ],
    });
    expect(result?.content[0]?.text).toContain("agent-1");
    expect(requests[0]).toMatchObject({
      writeIntent: "writer",
      writes: ["packages/auth/src/token.ts", "packages/auth/tests/token.test.ts"],
    });

    const rejected = yield* invokeOptionalTool(start, {
      agents: [{ task: "Inspect auth", profile: "scout", writes: ["packages/auth/src/token.ts"] }],
    });
    expect(rejected?.content[0]?.text).toContain(
      "writes may be supplied only for a writer profile",
    );
    expect(requests).toHaveLength(1);
  });

  effectTest("skips read-only route candidates when exact writes require a writer", function* () {
    const requests: StartSubagentRequest[] = [];
    const profiles = profileServiceFor({
      profiles: { worker: [route(), route({ writeIntent: "writer" })] },
    });
    yield* invokeOptionalTool(startTool(requests, { profiles }), {
      agents: [
        {
          task: "Implement auth",
          profile: "worker",
          writes: ["src/auth.ts"],
        },
      ],
    });
    expect(requests[0]).toMatchObject({
      writeIntent: "writer",
      writes: ["src/auth.ts"],
      selection: {
        candidateIndex: 1,
        skippedCandidates: [{ candidateIndex: 0, code: "write_claims_read_only" }],
      },
    });
  });

  effectTest("shares the parent's prompt cache only with forks on its capable model", function* () {
    const capability = { supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true };
    const parentModel = modelFixture({
      provider: "anthropic",
      id: "claude-parent",
      api: "anthropic-messages",
      compat: capability,
    });
    const otherModel = modelFixture({
      provider: "anthropic",
      id: "claude-other",
      api: "anthropic-messages",
      compat: capability,
    });
    const capableParent = extensionContextFixture({
      ...context,
      model: parentModel,
      modelRegistry: {
        find: (provider: string, id: string) =>
          [parentModel, otherModel].find((model) => model.provider === provider && model.id === id),
        hasConfiguredAuth: () => true,
        getProviderAuthStatus: () => ({ configured: true, source: "stored" }),
        getAvailable: () => [parentModel, otherModel],
      },
    });
    const profiles = profileServiceFor({
      profiles: {
        oracle: [route({ context: "fork" })],
        reviewer: [route({ context: "fork", model: "anthropic/claude-other" })],
        scout: [route()],
      },
    });
    const requests: StartSubagentRequest[] = [];
    yield* invokeOptionalTool(
      startTool(requests, { profiles }),
      {
        agents: [
          { task: "Advise", profile: "oracle" },
          { task: "Review", profile: "reviewer" },
          { task: "Map", profile: "scout" },
        ],
      },
      { context: capableParent },
    );
    expect(
      Object.fromEntries(
        requests.map((request) => [request.profile, request.sharesParentPromptCache === true]),
      ),
    ).toEqual({ oracle: true, reviewer: false, scout: false });

    const codexRequests: StartSubagentRequest[] = [];
    yield* invokeOptionalTool(startTool(codexRequests), {
      agents: [{ task: "Advise", profile: "oracle" }],
    });
    expect(codexRequests[0]?.context).toBe("fork");
    expect(codexRequests[0]?.sharesParentPromptCache).toBeUndefined();
  });

  effectTest("uses one active session override for discovery and launch provenance", function* () {
    const requests: StartSubagentRequest[] = [];
    const profiles = profileServiceFor(undefined, undefined, {
      revision: 1,
      overrides: {
        reviewer: {
          candidates: [
            {
              ...route({ model: "openai-codex/gpt-5.6-sol", effort: "low", openaiFastMode: false }),
              closeOnReport: true,
            },
          ],
        },
      },
    });
    const tools = captureSubagentTools(startCapturingService(requests), { profiles });
    const models = yield* invokeOptionalTool(tools.get("subagent_models"), { profile: "reviewer" });
    expect(models?.content[0]?.text).toContain("source=session");
    expect(models?.content[0]?.text).toContain("openai-codex/gpt-5.6-sol:low");

    yield* invokeOptionalTool(tools.get("subagent_start"), {
      agents: [{ task: "Review auth", profile: "reviewer" }],
    });
    expect(requests[0]).toMatchObject({
      profile: "reviewer",
      model: "openai-codex/gpt-5.6-sol",
      effort: "low",
      selection: {
        routeSource: "session",
      },
    });
  });

  effectTest(
    "routes every built-in profile through the tool boundary with its guidance and context",
    function* () {
      const requests: StartSubagentRequest[] = [];

      yield* invokeOptionalTool(startTool(requests), {
        agents: PROFILE_IDS.map((profile) => ({
          profile,
          task: `Smoke test ${profile}`,
        })),
      });

      expect(requests.map((request) => request.profile)).toEqual(PROFILE_IDS);
      const expectedEffort = {
        scout: "low",
        researcher: "medium",
        planner: "xhigh",
        worker: "high",
        reviewer: "high",
        oracle: "high",
        generalist: "high",
      } as const;
      const expectedIntent = {
        scout: "read-only",
        researcher: "read-only",
        planner: "read-only",
        worker: "writer",
        reviewer: "read-only",
        oracle: "read-only",
        generalist: "read-only",
      } as const;
      for (const request of requests) {
        expect(request.context).toBe(request.profile === "oracle" ? "fork" : "fresh");
        expect(request.effort).toBe(expectedEffort[request.profile ?? "generalist"]);
        expect(request.writeIntent).toBe(expectedIntent[request.profile ?? "generalist"]);
        expect(request.effortWasExplicit).toBe(false);
        expect(request.profileGuidance?.length).toBeGreaterThan(20);
        expect(request.selection).toMatchObject({
          source: "profile-parent-candidate",
          skippedCandidates: [],
        });
      }
    },
  );

  effectTest("never degrades a Pi oracle fork to fresh for an ephemeral parent", function* () {
    const requests: StartSubagentRequest[] = [];
    const tool = startTool(requests);

    const ephemeral = extensionContextFixture({
      ...context,
      sessionManager: {
        ...context.sessionManager,
        getSessionFile: () => undefined,
        getLeafEntry: () => undefined,
      },
    });
    const failed = yield* invokeOptionalTool(
      tool,
      {
        agents: [{ profile: "oracle", task: "Advise" }],
      },
      { context: ephemeral },
    );
    expect(failed?.details).toMatchObject({
      startFailures: [{ code: "fork_context_unavailable" }],
    });
  });

  effectTest(
    "falls back from configured unsupported backends before local Pi service start",
    function* () {
      const requests: StartSubagentRequest[] = [];
      const profiles = profileServiceFor({
        profiles: {
          reviewer: [
            route({
              host: "local",
              runtime: "claude",
              model: "sonnet",
              effort: "high",
              closeOnReport: true,
            }),
            route(),
          ],
        },
      });

      yield* invokeOptionalTool(startTool(requests, { profiles }), {
        agents: [{ profile: "reviewer", task: "Review" }],
      });

      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        host: "local",
        runtime: "pi",
        closeOnReport: true,
        selection: {
          candidateIndex: 1,
          skippedCandidates: [{ candidateIndex: 0, code: "backend_not_implemented" }],
        },
        routeContinuation: {
          profile: "reviewer",
          selectedCandidateIndex: 1,
          candidates: [{ runtime: "claude" }, { runtime: "pi" }],
        },
      });
    },
  );

  effectTest(
    "falls back across local auth and effort preflight skips before service ownership",
    function* () {
      const requests: StartSubagentRequest[] = [];
      const profiles = profileServiceFor({
        profiles: {
          reviewer: [
            route({ runtime: "claude", model: "sonnet", effort: "xhigh" }),
            route({ runtime: "codex", model: "gpt-5.6-sol", effort: "max" }),
            route({ effort: "high" }),
          ],
        },
      });
      const registry = preflightRegistry((selection) =>
        Match.value(selection.runtime).pipe(
          Match.when("claude", () =>
            invalidRequest("claude_unauthenticated", "Claude fixture auth unavailable."),
          ),
          Match.when("codex", () =>
            invalidRequest("codex_effort_unsupported", "Codex fixture effort unavailable."),
          ),
          Match.orElse(() => undefined),
        ),
      );
      yield* invokeOptionalTool(startTool(requests, { profiles, registry }), {
        agents: [{ profile: "reviewer", task: "Review" }],
      });
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        host: "local",
        runtime: "pi",
        selection: {
          candidateIndex: 2,
          skippedCandidates: [
            { candidateIndex: 0, code: "claude_unauthenticated" },
            { candidateIndex: 1, code: "codex_effort_unsupported" },
          ],
        },
      });
    },
  );

  for (const code of ["claude_preflight_cleanup_unconfirmed", "claude_preflight_outcome_uncertain"])
    effectTest(`does not advance the local route after ${code}`, function* () {
      const requests: StartSubagentRequest[] = [];
      const profiles = profileServiceFor({
        profiles: {
          reviewer: [
            route({ runtime: "claude", model: "sonnet", effort: "xhigh" }),
            route({ effort: "high" }),
          ],
        },
      });
      const attempted: string[] = [];
      const registry = preflightRegistry((selection) => {
        attempted.push(selection.runtime);
        return selection.runtime === "claude"
          ? invalidRequest(code, "Fixture readiness execution or cleanup is uncertain.")
          : undefined;
      });
      const result = yield* invokeOptionalTool(startTool(requests, { profiles, registry }), {
        agents: [{ profile: "reviewer", task: "Review" }],
      });
      expect(requests).toEqual([]);
      expect(attempted).toEqual(["claude"]);
      expect(result?.details).toMatchObject({ startFailures: [{ code }] });
    });

  effectTest("rejects remote configuration before readiness or service start", function* () {
    const requests: StartSubagentRequest[] = [];
    const profiles = profileServiceFor({
      profiles: {
        reviewer: {
          host: "herdr",
          runtime: "codex",
          model: "gpt-5.4",
          effort: "high",
          context: "fresh",
          writeIntent: "read-only",
        },
      },
    });
    const preflight = vi.fn(() => Effect.succeed(testBackendDriver));
    const registry = { ...testBackendRegistry, preflight };
    const result = yield* invokeOptionalTool(startTool(requests, { profiles, registry }), {
      agents: [{ profile: "reviewer", task: "Review" }],
    });
    expect(requests).toEqual([]);
    expect(preflight).not.toHaveBeenCalled();
    expect(result?.details).toMatchObject({
      startFailures: [{ code: "profile_no_eligible_model" }],
    });
  });

  effectTest(
    "does not fall through to another candidate after the selected start reaches the service",
    function* () {
      const profiles = profileServiceFor({
        profiles: { reviewer: [route({ model: "openai-codex/gpt-5.6-sol" }), route()] },
      });
      let starts = 0;
      const failStart = () => {
        starts += 1;
        return Effect.fail(
          new SubagentProcessError({
            operation: "spawn",
            code: "post_selection_start_failed",
            message: "Selected candidate failed after start ownership began.",
          }),
        );
      };
      const service = subagentServiceDouble({ start: failStart, startSessionOwned: failStart });
      const result = yield* invokeOptionalTool(
        captureSubagentTools(service, { profiles }).get("subagent_start"),
        { agents: [{ profile: "reviewer", task: "Review" }] },
      );
      expect(starts).toBe(1);
      expect(result?.details).toMatchObject({
        startFailures: [{ code: "post_selection_start_failed" }],
      });
    },
  );

  effectTest(
    "forwards host thinking levels to children and rejects unknown effort names",
    function* () {
      expect(decodeSubagentEffort("xhigh")).toBe("xhigh");
      expect(decodeSubagentEffort(" MAX ")).toBe("max");
      expect(decodeSubagentEffort("ultra")).toBeUndefined();
      expect(decodeSubagentEffort(42)).toBeUndefined();
      expect(decodeSubagentEffort(undefined)).toBeUndefined();

      const startWithLevel = (thinkingLevel: ReturnType<ExtensionAPI["getThinkingLevel"]>) =>
        Effect.gen(function* () {
          const requests: StartSubagentRequest[] = [];
          yield* invokeOptionalTool(
            startTool(requests, { thinkingLevel }),
            { agents: [{ profile: "generalist", task: "Probe" }] },
            { callID: "automatic" },
          );
          return requests.map((request) => request.effort);
        });

      expect(yield* startWithLevel("low")).toEqual(["low"]);
      expect(yield* startWithLevel("xhigh")).toEqual(["xhigh"]);
    },
  );

  effectTest(
    "returns model-visible profile_unknown and profile_no_eligible_model codes",
    function* () {
      const requests: StartSubagentRequest[] = [];
      const emptyRoute = profileServiceFor({ profiles: { reviewer: "disabled" } });
      const result = yield* invokeOptionalTool(startTool(requests, { profiles: emptyRoute }), {
        agents: [
          { profile: "future", task: "Unknown" },
          { profile: "reviewer", task: "Review" },
        ],
      });
      expect(requests).toEqual([]);
      expect(result?.details).toMatchObject({
        startEntries: [
          {
            index: 0,
            profile: "future",
            status: "failed",
            routeStatus: "unavailable",
          },
          {
            index: 1,
            profile: "reviewer",
            status: "failed",
            routeStatus: "unavailable",
          },
        ],
        startFailures: [
          { index: 0, code: "profile_unknown" },
          { index: 1, code: "profile_no_eligible_model" },
        ],
      });
      const text = result?.content[0]?.text ?? "";
      expect(text).toContain("[profile_unknown]");
      expect(text).toContain("[profile_no_eligible_model]");
      const nextSteps = text.split("\n").filter((line) => line.trim().startsWith("Next:"));
      expect(nextSteps).toHaveLength(1);
      expect(nextSteps[0]).toContain("/subagents doctor");
      expect(nextSteps[0]).toContain("/subagents profiles");
    },
  );

  effectTest("keeps request-ordered receipts for a mixed 32-agent batch", function* () {
    const failureIndex = 16;
    const agents = Array.from({ length: 32 }, (_, index) => ({
      task: index === failureIndex ? "Fail launch" : `Review area ${index + 1}`,
      name: `launch-${index + 1}`,
    }));
    const requests: StartSubagentRequest[] = [];
    const service = subagentServiceDouble({
      start: (input) =>
        Effect.sync(() => requests.push(input)).pipe(
          Effect.flatMap((requestCount) =>
            input.task === "Fail launch"
              ? Effect.fail(
                  new SubagentProcessError({
                    operation: "start",
                    message: "simulated launch failure",
                  }),
                )
              : Effect.succeed(
                  view({
                    id: `agent-${requestCount}`,
                    name: input.name ?? `agent-${requestCount}`,
                    task: input.task,
                    model: input.model,
                  }),
                ),
          ),
        ),
    });
    const tool = captureSubagentTools(service, { activeTools: ["read", "grep"] }).get(
      "subagent_start",
    );

    const result = yield* invokeOptionalTool(tool, { agents });

    expect(requests.map((request) => request.task)).toEqual(agents.map((agent) => agent.task));
    expect(requests).toHaveLength(32);
    expect(requests[0]).toMatchObject({
      host: "local",
      runtime: "pi",
      model: "openai-codex/gpt-5.6-sol",
      effort: "high",
    });
    const details = decodeStartDetails(result?.details);
    expect(details?.startEntries).toHaveLength(32);
    expect(details?.startEntries?.map((entry) => entry.index)).toEqual(
      Array.from({ length: 32 }, (_, index) => index),
    );
    expect(details?.startEntries?.map((entry) => entry.name)).toEqual(
      agents.map((agent) => agent.name),
    );
    expect(details?.startEntries?.[0]).toMatchObject({
      index: 0,
      profile: "generalist",
      status: "started",
      routeStatus: "selected",
      host: "local",
      runtime: "pi",
      model: "openai-codex/gpt-5.6-sol",
      effort: "high",
      openaiFastMode: false,
      runId: "agent-1",
    });
    const failedEntry = details?.startEntries?.[failureIndex];
    expect(failedEntry).toMatchObject({
      index: failureIndex,
      name: "launch-17",
      status: "failed",
      routeStatus: "selected",
    });
    expect(details?.startFailures).toEqual([
      {
        index: failureIndex,
        name: "launch-17",
        message: "simulated launch failure",
        code: "SubagentProcessError",
      },
    ]);
    expect(details?.startEntries?.at(-1)).toMatchObject({
      index: 31,
      status: "started",
      runId: "agent-32",
    });
    expect(details).not.toHaveProperty("cards");
  });

  effectTest("rejects per-launch routing overrides before side effects", function* () {
    const requests: StartSubagentRequest[] = [];
    const tool = startTool(requests)!;

    for (const fields of [
      { execution: "foreground" },
      { context: "fresh" },
      { writeIntent: "writer" },
      { effort: "high" },
    ])
      yield* step(() =>
        expect(
          executeTool(tool, { agents: [{ task: "Review auth", ...fields }] }),
        ).rejects.toMatchObject({ code: "launch_override_not_allowed" }),
      );
    expect(requests).toEqual([]);
  });

  effectTest(
    "does not let a failed partial renderer turn a successful launch into failure",
    function* () {
      const requests: StartSubagentRequest[] = [];

      const result = yield* invokeOptionalTool(
        startTool(requests),
        { agents: [{ task: "Review auth" }] },
        {
          update: () => {
            throw new Error("stale renderer");
          },
        },
      );

      expect(requests).toHaveLength(1);
      expect(result?.content[0]?.text).toContain("agent-1");
      expect(result?.details).not.toHaveProperty("startFailures");
    },
  );

  effectTest("launches through the cancellation-safe session owner", function* () {
    let sessionOwnedStarts = 0;
    const service = subagentServiceDouble({
      start: () => Effect.die("interruptible start must not be used by the public tool"),
      startSessionOwned: (input: StartSubagentRequest) =>
        Effect.sync(() => {
          sessionOwnedStarts += 1;
          return view({ task: input.task });
        }),
    });
    const tool = captureSubagentTools(service).get("subagent_start");

    const result = yield* invokeOptionalTool(tool, { agents: [{ task: "Review auth" }] });

    expect(sessionOwnedStarts).toBe(1);
    expect(result?.content[0]?.text).toContain("agent-1");
  });

  effectTest("captures one profile snapshot for an entire concurrent start batch", function* () {
    const requests: StartSubagentRequest[] = [];
    const base = profileServiceFor(undefined);
    let captures = 0;
    const profiles = {
      ...base,
      capture: Effect.sync(() => {
        captures += 1;
      }).pipe(Effect.flatMap(() => base.capture)),
    };
    yield* invokeOptionalTool(startTool(requests, { profiles }), {
      agents: [
        { task: "One", profile: "scout" },
        { task: "Two", profile: "reviewer" },
      ],
    });

    expect(captures).toBe(1);
    expect(requests).toHaveLength(2);
  });

  effectTest("rejects forged routing fields again at the host profile boundary", function* () {
    const pi = extensionApiFixture({
      getThinkingLevel: () => "high",
      getActiveTools: () => ["read"],
    });
    const reject = (input: SubagentProfileStartSpec) =>
      Effect.runPromise(
        resolveProfileStart(pi, input, context, {
          cwd: "/project",
          projectTrusted: true,
        }).pipe(
          Effect.provideService(SubagentProfileService, fallbackProfileService),
          Effect.provideService(SubagentBackendRegistry, testBackendRegistry),
        ),
      );

    for (const forged of [
      { model: "pi/openai/other" },
      { backend: "claude-cli" },
      { routeContinuation: {} },
      { supersedes: {} },
    ]) {
      const spec = { task: "Probe", ...forged };
      yield* step(() =>
        expect(reject(spec)).rejects.toMatchObject({ code: "launch_override_not_allowed" }),
      );
    }
  });

  effectTest("publishes request-ordered partial receipts for out-of-order launches", function* () {
    const slowLaunch = Deferred.makeUnsafe<void>();
    const updates: Array<{ readonly text: string; readonly details: unknown }> = [];
    const recordUpdate = <Details>(update: AgentToolResult<Details>) => {
      const first = update.content[0];
      updates.push({ text: first?.type === "text" ? first.text : "", details: update.details });
    };
    const service = subagentServiceDouble({
      startSessionOwned: (input: StartSubagentRequest) =>
        Match.value(input.name).pipe(
          Match.when("launch-1", () =>
            Deferred.await(slowLaunch).pipe(
              Effect.as(view({ id: "agent-slow", name: "launch-1" })),
            ),
          ),
          Match.when("launch-2", () =>
            Effect.fail(
              new SubagentProcessError({ operation: "start", message: "simulated failure" }),
            ),
          ),
          Match.orElse(() => Effect.sync(() => view({ id: "agent-fast", name: "launch-3" }))),
        ),
    });
    const tool = captureSubagentTools(service).get("subagent_start")!;
    const agents = ["launch-1", "launch-2", "launch-3"].map((name) => ({ task: "Review", name }));

    const execution = executeTool(tool, { agents }, { update: recordUpdate });
    yield* step(() =>
      vi.waitFor(() => {
        if (!updates.some((update) => update.text.includes("Processed 1 of 3")))
          throw new Error("Waiting for the first partial receipt.");
      }),
    );
    Deferred.doneUnsafe(slowLaunch, Effect.void);
    const result = yield* step(() => execution);

    const partial = updates[0]!;
    expect(partial.text).toContain("Processed 1 of 3 launches");
    expect(partial.text).toContain("0 started");
    expect(partial.text).toContain("1 failed");
    expect(partial.text).toContain("2 pending (#1 launch-1, #3 launch-3)");

    const receipt = (update: (typeof updates)[number]) => decodeStartDetails(update.details);
    for (const update of updates)
      expect(receipt(update).startEntries.map((entry) => entry.index)).toEqual([0, 1, 2]);
    const partialReceipt = receipt(partial);
    expect(partialReceipt.startEntries[0]).toMatchObject({ status: "pending" });
    expect(partialReceipt.startEntries[1]).toMatchObject({
      status: "failed",
      routeStatus: "selected",
    });
    expect(partialReceipt.startEntries[2]).toMatchObject({ status: "pending" });

    const final = receipt(updates.at(-1)!);
    expect(final.startEntries.map((entry) => ("runId" in entry ? entry.runId : undefined))).toEqual(
      ["agent-slow", undefined, "agent-fast"],
    );
    expect(final.startFailures?.map((failure) => failure.index)).toEqual([1]);
    expect(result.content[0]?.text).toContain("agent-slow");
    expect(result.content[0]?.text).toContain("agent-fast");
  });
});
