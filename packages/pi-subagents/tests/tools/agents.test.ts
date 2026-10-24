import { issueMessageStyleProblems, renderContextFixture } from "pi-code-previews/testing";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as Schema from "effect/Schema";
import type { JsonObject } from "pi-cosmic-core";
import { describe, expect, vi } from "vitest";
import { childToolPolicy } from "../../src/boundary/child-process.ts";
import { PROFILE_DEFINITIONS } from "../../src/profiles/definitions.ts";
import { PROFILE_IDS } from "../../src/profiles/model.ts";
import type { StartSubagentRequest } from "../../src/run/model.ts";
import { AGENT_TOOL_NAMES } from "../../src/run/tool-policy.ts";
import { createSubagentCompactSummary } from "../../src/tools/compact-summary.ts";
import { decodeSubagentContract } from "../../src/tools/contract-schema.ts";
import {
  SubagentModelsDetailsSchema,
  SubagentStartDetailsSchema,
  type SubagentStartDetails,
} from "../../src/tools/details-schema.ts";
import type { TSchema } from "typebox";
import { declaredCandidate } from "../fixtures/profiles.ts";
import { effectTest } from "../support/effect-test.ts";
import { objectContaining, stringContaining } from "../support/matchers.ts";
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
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import * as Rec from "effect/Record";

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
  captureSubagentTools(startCapturingService(requests), options).get("agent_start");

const compactIssues = (
  tool: "agent_start" | "agent_profiles",
  args: JsonObject,
  details: SubagentStartDetails | typeof SubagentModelsDetailsSchema.Type,
) =>
  createSubagentCompactSummary(tool)({
    phase: "settled",
    args,
    result: { content: [{ type: "text", text: "" }], details },
    context: renderContextFixture({ isError: tool === "agent_start" }),
  })?.issues ?? [];

const issueStyleProblems = (issues: ReturnType<typeof compactIssues>) =>
  Arr.flatMap(issues, (issue) => issueMessageStyleProblems(issue.message));

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

    expect(Arr.map(preflight.mock.calls, ([selection]) => selection.runtime)).toEqual(["pi"]);
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
    "refuses a worktree for a read-only route and ignores a shared checkout, with a warning",
    function* () {
      const requests: StartSubagentRequest[] = [];
      const profiles = profileServiceFor({
        profiles: {
          reviewer: piParent,
          worker: declaredCandidate("parent", { writeIntent: "writer" }),
        },
        agents: {
          isolated: agentDefinition({ isolation: "worktree" }),
          shared: agentDefinition({ isolation: "shared-checkout" }),
          plain: agentDefinition(),
          "isolated-worker": agentDefinition({ profile: "worker", isolation: "worktree" }),
        },
      });
      const result = yield* invokeOptionalTool(startWith(requests, { profiles }), {
        agents: [
          { task: "Review", agent: "isolated" },
          { task: "Review", agent: "plain", isolation: "worktree" },
          { task: "Review", agent: "shared" },
          { task: "Review", agent: "plain", isolation: "shared-checkout" },
          { task: "Implement", agent: "isolated-worker" },
        ],
      });

      expect(decodeStartDetails(result?.details).startFailures).toMatchObject([
        { index: 0, code: "isolation_requires_writer" },
        { index: 1, code: "isolation_requires_writer" },
      ]);
      expect(requests).toHaveLength(3);
      for (const request of requests.slice(0, 2)) {
        expect(request.writeIntent).toBe("read-only");
        expect(request).not.toHaveProperty("writerWorkspaceModeOverride");
        expect(request.selection?.warning).toContain("isolation");
      }
      expect(requests[2]).toMatchObject({
        agent: "isolated-worker",
        writeIntent: "writer",
        writerWorkspaceModeOverride: "worktree",
      });
      expect(requests[2]?.selection?.warning).toBeUndefined();
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

    expect(Arr.map(preflight.mock.calls, ([selection]) => selection.runtime)).toEqual(["pi"]);
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
        denied: agentDefinition({
          tools: { deny: ["bash", "agent_contact_parent", ...AGENT_TOOL_NAMES] },
        }),
        allowed: agentDefinition({ tools: { allow: ["read", "session_send"] } }),
      });
      yield* invokeOptionalTool(
        startWith(requests, {
          profiles,
          activeTools: [
            "read",
            "bash",
            "grep",
            "agent_contact_parent",
            "agent_start",
            "agent_send",
            "session_send",
          ],
        }),
        {
          agents: [
            { task: "Review", agent: "denied" },
            { task: "Review", agent: "allowed" },
          ],
        },
      );
      const toolsFor = (agent: string) =>
        Option.getOrUndefined(Arr.findFirst(requests, (request) => request.agent === agent))
          ?.activeTools;
      expect(toolsFor("denied")).toEqual(["read", "grep"]);
      expect(toolsFor("allowed")).toEqual(["read"]);
      // The child launch always enables parent contact and agent coordination, and never
      // cross-session messaging.
      for (const agent of ["denied", "allowed"]) {
        const policy = childToolPolicy(toolsFor(agent) ?? [], "read-only");
        expect(policy.enabled).toEqual(
          expect.arrayContaining(["agent_contact_parent", ...AGENT_TOOL_NAMES]),
        );
        expect(policy.enabled).not.toContain("session_send");
        expect(Str.split(policy.excluded, ",")).toContain("session_send");
      }
    },
  );

  effectTest(
    "withholds file-mutation tools from a read-only agent even when its allow list names them",
    function* () {
      const requests: StartSubagentRequest[] = [];
      const allow = ["read", "bash", "edit", "write"];
      const profiles = servicesWith({
        reader: agentDefinition({ tools: { allow } }),
        writer: agentDefinition({ writeIntent: "writer", tools: { allow } }),
        plain: agentDefinition(),
      });
      const args = {
        agents: [
          { task: "Review", agent: "reader" },
          { task: "Fix", agent: "writer" },
          { task: "Review", agent: "plain" },
        ],
      };
      const result = yield* invokeOptionalTool(
        startWith(requests, { profiles, activeTools: [...allow, "grep"] }),
        args,
      );
      const requestFor = (agent: string) =>
        Option.getOrUndefined(Arr.findFirst(requests, (request) => request.agent === agent));
      expect(requestFor("reader")).toMatchObject({
        writeIntent: "read-only",
        activeTools: ["read", "bash"],
      });
      // Read-only intent wins over the allow list, and the start entry says so.
      expect(requestFor("reader")?.selection?.warning).toBeDefined();
      expect(requestFor("writer")).toMatchObject({ writeIntent: "writer", activeTools: allow });
      expect(requestFor("writer")?.selection?.warning).toBeUndefined();
      // Without an allow list a reader loses them silently, as every read-only run does.
      expect(requestFor("plain")).toMatchObject({ activeTools: ["read", "bash", "grep"] });
      expect(requestFor("plain")?.selection?.warning).toBeUndefined();
      for (const agent of ["reader", "plain"]) {
        const policy = childToolPolicy(requestFor(agent)?.activeTools ?? [], "read-only");
        expect(policy.enabled).not.toContain("edit");
        expect(policy.enabled).not.toContain("write");
      }
      const details = decodeStartDetails(result?.details);
      expect(details.startEntries[0]).toMatchObject({ warning: stringContaining("edit") });
      expect(issueStyleProblems(compactIssues("agent_start", args, details))).toEqual([]);
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
      // An omitted selector sent as null doesn't conflict.
      for (const agents of [
        [{ task: "Review", agent: null, profile: "reviewer" }],
        [{ task: "Review", agent: "ok", profile: null }],
      ])
        expect(() => tool?.prepareArguments?.({ agents })).not.toThrow();

      const args = {
        agents: [
          { task: "Review", agent: "ok", profile: "reviewer" },
          { task: "Review", agent: "missing" },
          { task: "Review", agent: "broken" },
        ],
      };
      const result = yield* invokeOptionalTool(tool, args);
      expect(requests).toEqual([]);
      const issues = compactIssues("agent_start", args, decodeStartDetails(result?.details));
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
        agentRead: () =>
          Effect.succeed({
            agents: [
              {
                kind: "run",
                id: run.id,
                name: run.name,
                state: run.state,
                textStatus: "none",
                truncated: false,
                reportGeneration: 0,
                run,
              },
            ],
            missingIds: [],
          }),
      });
      const result = yield* invokeOptionalTool(captureSubagentTools(service).get("agent_read"), {
        agentIds: [run.id],
      });
      expect(result?.content[0]?.text).toContain("auth-reviewer (reviewer)");
      expect(result?.structuredContent).toMatchObject({
        agents: [{ id: run.id, status: { agent: "auth-reviewer", profile: "reviewer" } }],
      });
    },
  );
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
      captureSubagentTools(subagentServiceDouble({}), { profiles }).get("agent_profiles"),
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
    const issues = compactIssues("agent_profiles", {}, details);
    expect(Arr.map(issues, (issue) => issue.code)).toEqual([
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

const discover = (profiles: ReturnType<typeof profileServiceFor>) =>
  invokeOptionalTool(
    captureSubagentTools(subagentServiceDouble({}), { profiles }).get("agent_profiles"),
    {},
  );

const longModel = (index: number) => `provider/${Fn.pipe("m", Str.repeat(230))}-${index}`;

describe("route discovery bounds", () => {
  effectTest("lists every agent the global and project layers resolve", function* () {
    const layer = (scope: string) =>
      Rec.fromEntries(
        Array.from({ length: 32 }, (_, index) => [`${scope}-${index}`, agentDefinition()]),
      );
    const profiles = profileServiceFor(
      { profiles: { reviewer: piParent }, agents: layer("global") },
      { agents: layer("project") },
    );
    const result = yield* discover(profiles);
    const contract = decodeSubagentContract("agent_profiles")(result?.structuredContent);
    expect(contract?.agents).toHaveLength(64);
  });

  effectTest("keeps routes too large for bounded details as plain text", function* () {
    const route = Array.from({ length: 32 }, (_, index) => declaredCandidate(longModel(index)));
    const profiles = profileServiceFor({
      profiles: Rec.fromEntries(Arr.map(PROFILE_IDS, (id) => [id, route])),
    });
    const result = yield* discover(profiles);
    expect(result?.details).toBeUndefined();
    expect(result?.content).toEqual([objectContaining({ text: stringContaining(longModel(31)) })]);
    expect(decodeSubagentContract("agent_profiles")(result?.structuredContent)).toBeDefined();
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
    }).get("agent_worktree");
    if (!tool) return Effect.die("agent_worktree is not registered");
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
