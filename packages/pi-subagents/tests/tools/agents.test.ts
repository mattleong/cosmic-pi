import { issueMessageStyleProblems, renderContextFixture } from "pi-code-previews/testing";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { JsonObject } from "pi-cosmic-core";
import { describe, expect, vi } from "vitest";
import { PROFILE_DEFINITIONS } from "../../src/profiles/definitions.ts";
import type { CustomAgent } from "../../src/profiles/agents.ts";
import type { StartSubagentRequest } from "../../src/run/model.ts";
import { createSubagentCompactSummary } from "../../src/tools/compact-summary.ts";
import {
  SubagentModelsDetailsSchema,
  SubagentStartDetailsSchema,
  type SubagentStartDetails,
} from "../../src/tools/details-schema.ts";
import type { TSchema } from "typebox";
import { declaredCandidate } from "../fixtures/profiles.ts";
import { reviewerContinuation } from "../run/fixtures/service-harness.ts";
import { effectTest } from "../support/effect-test.ts";
import { subagentServiceDouble } from "./fixtures/subagent-service-double.ts";
import {
  captureSubagentTools,
  executeTool,
  invokeOptionalTool,
  profileServiceFor,
  startCapturingService,
  testBackendRegistry,
  view,
  type CaptureOptions,
} from "./fixtures/tool-harness.ts";

const decodeStartDetails = Schema.decodeUnknownSync(SubagentStartDetailsSchema);
const decodeModelsDetails = Schema.decodeUnknownSync(SubagentModelsDetailsSchema);
const decodeStartSchema = Schema.decodeUnknownSync(
  Schema.Struct({
    properties: Schema.Struct({
      agents: Schema.Struct({
        items: Schema.Struct({ properties: Schema.Record(Schema.String, Schema.Unknown) }),
      }),
    }),
  }),
);

const piParent = declaredCandidate("parent", { effort: "default" });
const claudeOpus = declaredCandidate("opus", { runtime: "claude", effort: "high" });

const agentDefinition = (fields: JsonObject = {}): JsonObject => ({
  description: "Reviews auth changes against the threat model.",
  instructions: "Review only authentication code. Cite file and line for every finding.",
  profile: "reviewer",
  ...fields,
});

const servicesWith = (agents: JsonObject, reviewer: JsonObject | JsonObject[] = piParent) =>
  profileServiceFor({ profiles: { reviewer }, agents });

const startWith = (requests: StartSubagentRequest[], options: CaptureOptions) =>
  captureSubagentTools(startCapturingService(requests), options).get("subagent_start");

const compactIssues = (
  tool: "subagent_start" | "subagent_models",
  args: JsonObject,
  details: SubagentStartDetails | typeof SubagentModelsDetailsSchema.Type,
) =>
  createSubagentCompactSummary(tool)({
    phase: "settled",
    args,
    result: { content: [{ type: "text", text: "" }], details },
    context: renderContextFixture({ isError: tool === "subagent_start" }),
  })?.issues ?? [];

const issueStyleProblems = (issues: ReturnType<typeof compactIssues>) =>
  issues.flatMap((issue) => issueMessageStyleProblems(issue.message));

const agentProperty = (parameters: TSchema | undefined) =>
  decodeStartSchema(parameters).properties.agents.items.properties.agent;

const countingRegistry = () => {
  const preflight = vi.fn(testBackendRegistry.preflight);
  return { preflight, registry: { ...testBackendRegistry, preflight } };
};

describe("custom agent launches", () => {
  effectTest(
    "replaces the profile's guidance with the agent's instructions and applies its overrides",
    function* () {
      const requests: StartSubagentRequest[] = [];
      const profiles = servicesWith({
        "auth-reviewer": agentDefinition({
          effort: "low",
          writeIntent: "writer",
          isolation: "worktree",
        }),
      });
      const result = yield* invokeOptionalTool(startWith(requests, { profiles }), {
        agents: [{ task: "Review the login flow", agent: "auth-reviewer" }],
      });

      expect(requests).toHaveLength(1);
      const [request] = requests;
      expect(request).toMatchObject({
        agent: "auth-reviewer",
        profile: "reviewer",
        profileGuidance: "Review only authentication code. Cite file and line for every finding.",
        effort: "low",
        effortWasExplicit: true,
        writeIntent: "writer",
        writerWorkspaceModeOverride: "worktree",
        routeContinuation: {
          profile: "reviewer",
          agent: { name: "auth-reviewer", profile: "reviewer", effort: "low" },
        },
      });
      expect(request?.profileGuidance).not.toContain(PROFILE_DEFINITIONS.reviewer.guidance);
      expect(decodeStartDetails(result?.details).startEntries[0]).toMatchObject({
        status: "started",
        agent: "auth-reviewer",
        profile: "reviewer",
      });
      expect(result?.structuredContent).toMatchObject({
        launches: [{ status: "started", agent: "auth-reviewer", profile: "reviewer" }],
      });
    },
  );

  effectTest("skips candidates the agent's overrides don't fit, with a typed reason", function* () {
    const requests: StartSubagentRequest[] = [];
    const { preflight, registry } = countingRegistry();
    const profiles = servicesWith({ forked: agentDefinition({ context: "fork" }) }, [
      claudeOpus,
      piParent,
    ]);
    yield* invokeOptionalTool(startWith(requests, { profiles, registry }), {
      agents: [{ task: "Recheck the decision", agent: "forked" }],
    });

    expect(preflight.mock.calls.map(([selection]) => selection.runtime)).toEqual(["pi"]);
    expect(requests[0]).toMatchObject({
      runtime: "pi",
      context: "fork",
      selection: {
        candidateIndex: 1,
        skippedCandidates: [{ candidateIndex: 0, code: "agent_candidate_incompatible" }],
      },
    });
  });

  effectTest(
    "rejects isolation from an item or agent whose route resolves read-only",
    function* () {
      const requests: StartSubagentRequest[] = [];
      const profiles = profileServiceFor({
        profiles: {
          reviewer: piParent,
          worker: declaredCandidate("parent", { writeIntent: "writer" }),
        },
        agents: {
          isolated: agentDefinition({ isolation: "worktree" }),
          plain: agentDefinition(),
          "isolated-worker": agentDefinition({ profile: "worker", isolation: "worktree" }),
        },
      });
      const result = yield* invokeOptionalTool(startWith(requests, { profiles }), {
        agents: [
          { task: "Review", agent: "isolated" },
          { task: "Review", agent: "plain", isolation: "worktree" },
          { task: "Implement", agent: "isolated-worker" },
        ],
      });

      expect(decodeStartDetails(result?.details).startFailures).toMatchObject([
        { index: 0, code: "isolation_requires_writer" },
        { index: 1, code: "isolation_requires_writer" },
      ]);
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        agent: "isolated-worker",
        writeIntent: "writer",
        writerWorkspaceModeOverride: "worktree",
      });
    },
  );

  effectTest("skips Claude and Codex candidates when the agent sets tool lists", function* () {
    const requests: StartSubagentRequest[] = [];
    const { preflight, registry } = countingRegistry();
    const profiles = profileServiceFor({
      profiles: {
        reviewer: [claudeOpus, piParent],
        scout: claudeOpus,
      },
      agents: {
        restricted: agentDefinition({ tools: { deny: ["bash"] } }),
        "claude-only": agentDefinition({ profile: "scout", tools: { allow: ["read"] } }),
      },
    });
    const result = yield* invokeOptionalTool(startWith(requests, { profiles, registry }), {
      agents: [
        { task: "Review", agent: "restricted" },
        { task: "Map", agent: "claude-only" },
      ],
    });

    expect(preflight.mock.calls.map(([selection]) => selection.runtime)).toEqual(["pi"]);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      runtime: "pi",
      selection: { skippedCandidates: [{ code: "agent_tools_unsupported" }] },
    });
    expect(decodeStartDetails(result?.details).startFailures).toMatchObject([
      { index: 1, code: "profile_no_eligible_model" },
    ]);
  });

  effectTest(
    "filters the Pi child's inherited tools but keeps its supervision tools",
    function* () {
      const requests: StartSubagentRequest[] = [];
      const profiles = servicesWith({
        denied: agentDefinition({ tools: { deny: ["bash", "contact_parent"] } }),
        allowed: agentDefinition({ tools: { allow: ["read"] } }),
      });
      yield* invokeOptionalTool(
        startWith(requests, {
          profiles,
          activeTools: ["read", "bash", "grep", "contact_parent", "subagent_start"],
        }),
        {
          agents: [
            { task: "Review", agent: "denied" },
            { task: "Review", agent: "allowed" },
          ],
        },
      );
      const toolsFor = (agent: string) =>
        requests.find((request) => request.agent === agent)?.activeTools;
      expect(toolsFor("denied")).toEqual(["read", "grep", "contact_parent"]);
      expect(toolsFor("allowed")).toEqual(["read", "contact_parent"]);
    },
  );

  effectTest(
    "rejects an agent combined with a profile, an unknown agent, and an invalid one",
    function* () {
      const requests: StartSubagentRequest[] = [];
      const profiles = profileServiceFor({
        agents: { ok: agentDefinition(), broken: agentDefinition({ model: "opus" }) },
      });
      const tool = startWith(requests, { profiles });
      const conflicting = { agents: [{ task: "Review", agent: "ok", profile: "reviewer" }] };
      expect(() => tool?.prepareArguments?.(conflicting)).toThrow(/agent_profile_conflict/u);

      const args = {
        agents: [
          { task: "Review", agent: "ok", profile: "reviewer" },
          { task: "Review", agent: "missing" },
          { task: "Review", agent: "broken" },
        ],
      };
      const result = yield* invokeOptionalTool(tool, args);
      expect(requests).toEqual([]);
      const issues = compactIssues("subagent_start", args, decodeStartDetails(result?.details));
      expect(issues.length).toBeGreaterThan(0);
      expect(issueStyleProblems(issues)).toEqual([]);
      expect(result?.details).toMatchObject({
        startFailures: [
          { index: 0, code: "agent_profile_conflict" },
          { index: 1, code: "agent_unknown" },
          { index: 2, code: "agent_invalid" },
        ],
      });
    },
  );

  effectTest("lets a model override take the agent's defaults", function* () {
    const requests: StartSubagentRequest[] = [];
    const profiles = servicesWith({
      writer: agentDefinition({ effort: "medium", writeIntent: "writer" }),
      tooled: agentDefinition({ tools: { allow: ["read"] } }),
    });
    const result = yield* invokeOptionalTool(startWith(requests, { profiles }), {
      agents: [
        {
          task: "Implement",
          agent: "writer",
          model: { runtime: "pi", model: "openai-codex/gpt-5.6-sol" },
        },
        { task: "Review", agent: "tooled", model: { runtime: "claude", model: "opus" } },
      ],
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      agent: "writer",
      effort: "medium",
      writeIntent: "writer",
      selection: { routeSource: "override" },
    });
    expect(result?.details).toMatchObject({
      startFailures: [{ index: 1, code: "model_override_invalid" }],
    });
  });

  effectTest(
    "lists configured agents in the root start schema only when there are some",
    function* () {
      const withAgents = startWith([], {
        profiles: servicesWith({ "auth-reviewer": agentDefinition() }),
      });
      const withoutAgents = startWith([], {});
      expect(agentProperty(withAgents?.parameters)).toMatchObject({ enum: ["auth-reviewer"] });
      expect(agentProperty(withoutAgents?.parameters)).toBeUndefined();
      yield* Effect.void;
    },
  );
});

describe("custom agent status", () => {
  effectTest(
    "status cards and contract targets show the agent and its routed profile",
    function* () {
      const run = view({ id: "agent-7", profile: "reviewer", agent: "auth-reviewer" });
      const service = subagentServiceDouble({
        withStatusObservations: (_ids, use) => use({ observations: [{ run }], missingIds: [] }),
      });
      const result = yield* invokeOptionalTool(
        captureSubagentTools(service).get("subagent_status"),
        {
          runIds: [run.id],
        },
      );
      expect(result?.details).toMatchObject({
        cards: [{ id: run.id, agent: "auth-reviewer", profile: "reviewer" }],
      });
      expect(result?.structuredContent).toMatchObject({
        targets: [{ runId: run.id, agent: "auth-reviewer", profile: "reviewer" }],
      });
    },
  );
});

describe("custom agent retry", () => {
  effectTest("keeps the frozen agent snapshot after the configuration changes", function* () {
    const frozen: CustomAgent = {
      name: "auth-reviewer",
      source: "global",
      description: "Frozen reviewer.",
      instructions: "Frozen launch-time instructions.",
      profile: "reviewer",
      effort: "low",
      tools: { deny: ["bash"] },
    };
    const retried: StartSubagentRequest[] = [];
    const service = subagentServiceDouble({
      claimRetryContinuation: () =>
        Effect.succeed({
          source: view({ state: "failed", profile: "reviewer", agent: "auth-reviewer" }),
          continuation: { ...reviewerContinuation(0), agent: frozen },
          claimToken: "claim",
        }),
      startRetrySessionOwned: (request, onOwned) =>
        Effect.sync(() => {
          retried.push(request);
          onOwned?.();
          return view({ id: "successor", agent: request.agent });
        }),
    });
    // The current configuration no longer declares the agent at all.
    const tools = captureSubagentTools(service, {
      profiles: profileServiceFor(undefined),
      activeTools: ["read", "bash"],
    });
    yield* invokeOptionalTool(tools.get("subagent_lifecycle"), {
      action: "retry",
      runIds: ["agent-1"],
    });

    expect(retried).toHaveLength(1);
    expect(retried[0]).toMatchObject({
      agent: "auth-reviewer",
      profile: "reviewer",
      profileGuidance: "Frozen launch-time instructions.",
      effort: "low",
      activeTools: ["read"],
      routeContinuation: { agent: frozen, selectedCandidateIndex: 1 },
    });
  });
});

describe("custom agent discovery", () => {
  effectTest("shows each agent with its overridden candidates and invalid entries", function* () {
    const profiles = profileServiceFor({
      profiles: { reviewer: [claudeOpus, piParent], scout: claudeOpus },
      agents: {
        restricted: agentDefinition({ effort: "low", tools: { deny: ["bash"] } }),
        "claude-only": agentDefinition({ profile: "scout", tools: { allow: ["read"] } }),
        broken: agentDefinition({ unknown: true }),
      },
    });
    const result = yield* invokeOptionalTool(
      captureSubagentTools(subagentServiceDouble({}), { profiles }).get("subagent_models"),
      {},
    );
    const details = decodeModelsDetails(result?.details);
    expect(details.agents).toEqual([
      expect.objectContaining({
        name: "restricted",
        profile: "reviewer",
        source: "global",
        effort: "low",
        deniedToolCount: 1,
        candidates: [
          expect.objectContaining({ runtime: "claude", status: "skipped" }),
          expect.objectContaining({ runtime: "pi", effort: "low", status: "eligible" }),
        ],
      }),
      expect.objectContaining({
        name: "claude-only",
        candidates: [expect.objectContaining({ runtime: "claude", status: "skipped" })],
      }),
    ]);
    const issues = compactIssues("subagent_models", {}, details);
    expect(issues.map((issue) => issue.code)).toEqual([
      "agent:claude-only:unavailable",
      "agents:invalid",
    ]);
    expect(issueStyleProblems(issues)).toEqual([]);
    expect(details.invalidAgents).toEqual([{ scope: "global", name: "broken" }]);
    expect(result?.structuredContent).toMatchObject({
      agents: [{ name: "restricted", tools: { deny: ["bash"] } }, { name: "claude-only" }],
      invalidAgents: [{ scope: "global", name: "broken" }],
    });
  });
});

// Stands in for the run service, which resolves an adopted workspace's recorded launch for its
// first revision and starts the successor from the resolved request.
const adoptedRevision = (requests: StartSubagentRequest[]) =>
  subagentServiceDouble({
    workspaceRevise: (workspaceId, message, _caller, options) =>
      Effect.gen(function* () {
        const resolveLaunch = options?.resolveLaunch;
        if (!resolveLaunch) return yield* Effect.die("the root revision resolves launches");
        const request = yield* resolveLaunch({ agent: "auth-fixer", name: "fixer" }, message);
        requests.push(request);
        return { run: view({ id: "successor", workspaceId, task: request.task }) };
      }),
  });

describe("adopted workspaces launched as custom agents", () => {
  const fixer = agentDefinition({ profile: "worker", writeIntent: "writer", effort: "low" });
  const revise = (requests: StartSubagentRequest[], agents: JsonObject) => {
    const tool = captureSubagentTools(adoptedRevision(requests), {
      profiles: profileServiceFor({ profiles: { worker: piParent }, agents }),
    }).get("subagent_workspace");
    if (!tool) return Effect.die("subagent_workspace is not registered");
    const args = { action: "revise", workspaceId: "orphan", message: "Fix the failing test" };
    return Effect.tryPromise(() => executeTool(tool, args));
  };

  effectTest("relaunches the recorded agent with its route and instructions", function* () {
    const requests: StartSubagentRequest[] = [];
    yield* revise(requests, { "auth-fixer": fixer }).pipe(Effect.orDie);

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      agent: "auth-fixer",
      profile: "worker",
      name: "fixer",
      task: "Fix the failing test",
      runtime: "pi",
      effort: "low",
      writeIntent: "writer",
      writerWorkspaceModeOverride: "worktree",
      profileGuidance: "Review only authentication code. Cite file and line for every finding.",
    });
  });

  effectTest("refuses when the recorded agent was removed", function* () {
    const requests: StartSubagentRequest[] = [];
    const failure = yield* revise(requests, { other: fixer }).pipe(Effect.flip, Effect.orDie);

    expect(requests).toEqual([]);
    expect(failure.cause).toMatchObject({ code: "workspace_launch_unavailable" });
  });
});
