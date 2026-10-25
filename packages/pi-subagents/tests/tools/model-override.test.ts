import { issueMessageStyleProblems, renderContextFixture } from "pi-code-previews/testing";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe, expect, vi } from "vitest";
import { effectTest } from "../support/effect-test.ts";
import { InvalidSubagentRequestError } from "../../src/run/errors.ts";
import type { StartSubagentRequest } from "../../src/run/model.ts";
import { createSubagentCompactSummary } from "../../src/tools/compact-summary.ts";
import {
  SubagentStartDetailsSchema,
  type SubagentStartDetails,
} from "../../src/tools/details-schema.ts";
import type { SubagentStartInput, SubagentStartSpec } from "../../src/tools/schema.ts";
import { subagentServiceDouble } from "./fixtures/subagent-service-double.ts";
import {
  captureSubagentTools,
  executeTool,
  invokeOptionalTool,
  startCapturingService,
  testBackendRegistry,
  view,
  type CaptureOptions,
} from "./fixtures/tool-harness.ts";
import * as Arr from "effect/Array";

const decodeStartDetails = Schema.decodeUnknownSync(SubagentStartDetailsSchema);

const startWith = (requests: StartSubagentRequest[], options: CaptureOptions = {}) =>
  captureSubagentTools(startCapturingService(requests), options).get("agent_start");

const startIssueStyleProblems = (args: SubagentStartInput, details: SubagentStartDetails) =>
  Arr.flatMap(
    createSubagentCompactSummary("agent_start")({
      phase: "settled",
      args,
      result: { content: [{ type: "text", text: "" }], details },
      context: renderContextFixture({ isError: true }),
    })?.issues ?? [],
    (issue) => issueMessageStyleProblems(issue.message),
  );

// The parent's model is the only one the session offers, so the override's readiness probe fails.
const SIGNED_OUT = "openai-codex/gpt-5.6-sol";

const countingRegistry = () => {
  const preflight = vi.fn<typeof testBackendRegistry.preflight>((selection, request) =>
    request.model === SIGNED_OUT
      ? Effect.fail(
          InvalidSubagentRequestError.make({
            code: "provider_unauthenticated",
            message: "The provider is not signed in.",
          }),
        )
      : testBackendRegistry.preflight(selection, request),
  );
  return { preflight, registry: { ...testBackendRegistry, preflight } };
};

describe("per-launch model override", () => {
  effectTest(
    "launches exactly the override with the profile's context and write intent",
    function* () {
      const requests: StartSubagentRequest[] = [];
      const modelOverride = {
        model: "openai-codex/gpt-5.6-sol",
        effort: "medium",
      } as const;
      const result = yield* invokeOptionalTool(startWith(requests), {
        agents: [{ task: "Implement parsing", profile: "worker", model: modelOverride }],
      });

      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        model: "openai-codex/gpt-5.6-sol",
        effort: "medium",
        effortWasExplicit: true,
        context: "fresh",
        writeIntent: "writer",
        openaiFastMode: false,
        modelOverride,
        selection: { routeSource: "override", candidateIndex: 0 },
        routeContinuation: {
          selectedCandidateIndex: 0,
          candidates: [
            {
              model: "openai-codex/gpt-5.6-sol",
              effort: "medium",
              context: "fresh",
              writeIntent: "writer",
            },
          ],
        },
      });
      expect(decodeStartDetails(result?.details).startEntries[0]).toMatchObject({
        status: "started",
        modelOverride,
      });
      expect(result?.structuredContent).toMatchObject({
        launches: [{ status: "started", modelOverride }],
      });
    },
  );

  effectTest("an omitted override effort takes the profile default", function* () {
    const requests: StartSubagentRequest[] = [];
    yield* invokeOptionalTool(startWith(requests), {
      agents: [{ task: "Map auth", profile: "scout", model: { model: "parent" } }],
    });
    expect(requests[0]).toMatchObject({ effort: "low", effortWasExplicit: false });
  });

  effectTest(
    "an unavailable override fails without falling back to the profile route",
    function* () {
      const requests: StartSubagentRequest[] = [];
      const { preflight, registry } = countingRegistry();
      const args: SubagentStartInput = {
        agents: [
          {
            task: "Review auth",
            profile: "reviewer",
            model: { model: SIGNED_OUT },
          },
          {
            task: "Review docs",
            profile: "reviewer",
            model: { model: "nobody/unknown-model" },
          },
        ],
      };
      const result = yield* invokeOptionalTool(startWith(requests, { registry }), args);

      expect(requests).toEqual([]);
      expect(Arr.map(preflight.mock.calls, ([, request]) => request.model)).toEqual([SIGNED_OUT]);
      expect(result?.details).toMatchObject({
        startFailures: [
          { index: 0, code: "model_override_unavailable" },
          { index: 1, code: "model_override_unavailable" },
        ],
      });
      expect(startIssueStyleProblems(args, decodeStartDetails(result?.details))).toEqual([]);
    },
  );

  effectTest("rejects malformed overrides before readiness", function* () {
    const invalid: ReadonlyArray<Pick<SubagentStartSpec, "profile" | "model">> = [
      { profile: "reviewer", model: { model: "../escape" } },
      { profile: "reviewer", model: { model: "openai/opus;rm" } },
      // A bare model name needs its provider.
      { profile: "oracle", model: { model: "opus" } },
    ];
    const requests: StartSubagentRequest[] = [];
    const { preflight, registry } = countingRegistry();
    const args: SubagentStartInput = {
      agents: Arr.map(invalid, (agent) => ({ task: "Review", ...agent })),
    };
    const result = yield* invokeOptionalTool(startWith(requests, { registry }), args);

    expect(requests).toEqual([]);
    expect(preflight).not.toHaveBeenCalled();
    expect(result?.details).toMatchObject({
      startFailures: Arr.map(invalid, (_, index) => ({ index, code: "model_override_invalid" })),
    });
    expect(startIssueStyleProblems(args, decodeStartDetails(result?.details))).toEqual([]);
  });

  effectTest("still rejects a top-level effort override", function* () {
    const requests: StartSubagentRequest[] = [];
    yield* Effect.promise(() =>
      expect(
        executeTool(startWith(requests)!, { agents: [{ task: "Review", effort: "high" }] }),
      ).rejects.toMatchObject({ code: "launch_override_not_allowed" }),
    );
    expect(requests).toEqual([]);
  });

  effectTest("status cards and contract targets report the override", function* () {
    const modelOverride = { model: "claude-bridge/claude-sonnet-5-5" } as const;
    const run = view({
      id: "agent-7",
      model: "claude-bridge/claude-sonnet-5-5",
      modelOverride,
      selection: {
        source: "profile-candidate",
        routeSource: "override",
        candidateIndex: 0,
        reason: "Profile reviewer selected model override candidate 1.",
        skippedCandidates: [],
      },
    });
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
      verbose: true,
    });
    expect(result?.content[0]?.text).toContain("claude-bridge/claude-sonnet-5-5");
    expect(result?.structuredContent).toMatchObject({
      agents: [{ id: run.id, status: { runId: run.id, modelOverride } }],
    });
  });
});
