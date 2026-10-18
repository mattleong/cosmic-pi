import { issueMessageStyleProblems, renderContextFixture } from "pi-code-previews/testing";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe, expect, vi } from "vitest";
import { effectTest } from "../support/effect-test.ts";
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

const decodeStartDetails = Schema.decodeUnknownSync(SubagentStartDetailsSchema);

const startWith = (requests: StartSubagentRequest[], options: CaptureOptions = {}) =>
  captureSubagentTools(startCapturingService(requests), options).get("subagent_start");

const startIssueStyleProblems = (args: SubagentStartInput, details: SubagentStartDetails) =>
  (
    createSubagentCompactSummary("subagent_start")({
      phase: "settled",
      args,
      result: { content: [{ type: "text", text: "" }], details },
      context: renderContextFixture({ isError: true }),
    })?.issues ?? []
  ).flatMap((issue) => issueMessageStyleProblems(issue.message));

const countingRegistry = () => {
  const preflight = vi.fn(testBackendRegistry.preflight);
  return { preflight, registry: { ...testBackendRegistry, preflight } };
};

describe("per-launch model override", () => {
  effectTest(
    "launches exactly the override with the profile's context and write intent",
    function* () {
      const requests: StartSubagentRequest[] = [];
      const modelOverride = {
        runtime: "pi",
        model: "openai-codex/gpt-5.6-sol",
        effort: "medium",
      } as const;
      const result = yield* invokeOptionalTool(startWith(requests), {
        agents: [{ task: "Implement parsing", profile: "worker", model: modelOverride }],
      });

      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        runtime: "pi",
        model: "openai-codex/gpt-5.6-sol",
        effort: "medium",
        effortWasExplicit: true,
        context: "fresh",
        writeIntent: "writer",
        openaiFastMode: false,
        modelOverride,
        selection: { routeSource: "override", candidateIndex: 0 },
        routeContinuation: {
          profile: "worker",
          routeSource: "override",
          selectedCandidateIndex: 0,
          candidates: [
            {
              runtime: "pi",
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
      agents: [{ task: "Map auth", profile: "scout", model: { runtime: "pi", model: "parent" } }],
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
            model: { runtime: "claude", model: "opus" },
          },
          {
            task: "Review docs",
            profile: "reviewer",
            model: { runtime: "pi", model: "nobody/unknown-model" },
          },
        ],
      };
      const result = yield* invokeOptionalTool(startWith(requests, { registry }), args);

      expect(requests).toEqual([]);
      expect(preflight.mock.calls.map(([selection]) => selection.runtime)).toEqual(["claude"]);
      expect(result?.details).toMatchObject({
        startFailures: [
          { index: 0, code: "model_override_unavailable" },
          { index: 1, code: "model_override_unavailable" },
        ],
      });
      expect(startIssueStyleProblems(args, decodeStartDetails(result?.details))).toEqual([]);
    },
  );

  effectTest("rejects malformed or runtime-incompatible overrides before readiness", function* () {
    const invalid: ReadonlyArray<Pick<SubagentStartSpec, "profile" | "model">> = [
      { profile: "reviewer", model: { runtime: "pi", model: "../escape" } },
      { profile: "reviewer", model: { runtime: "claude", model: "opus;rm" } },
      { profile: "reviewer", model: { runtime: "claude", model: "parent" } },
      // The oracle profile forks its parent's context, which only local Pi can do.
      { profile: "oracle", model: { runtime: "claude", model: "opus" } },
      { profile: "reviewer", model: { runtime: "claude", model: "opus", effort: "minimal" } },
    ];
    const requests: StartSubagentRequest[] = [];
    const { preflight, registry } = countingRegistry();
    const args: SubagentStartInput = {
      agents: invalid.map((agent) => ({ task: "Review", ...agent })),
    };
    const result = yield* invokeOptionalTool(startWith(requests, { registry }), args);

    expect(requests).toEqual([]);
    expect(preflight).not.toHaveBeenCalled();
    expect(result?.details).toMatchObject({
      startFailures: invalid.map((_, index) => ({ index, code: "model_override_invalid" })),
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
    const modelOverride = { runtime: "codex", model: "gpt-5.5" } as const;
    const run = view({
      id: "agent-7",
      runtime: "codex",
      model: "gpt-5.5",
      modelOverride,
      selection: {
        source: "profile-candidate",
        routeSource: "override",
        candidateIndex: 0,
        reason: "Profile reviewer selected model override candidate 1 (local/codex).",
        skippedCandidates: [],
      },
    });
    const service = subagentServiceDouble({
      withStatusObservations: (_ids, use) => use({ observations: [{ run }], missingIds: [] }),
    });
    const result = yield* invokeOptionalTool(captureSubagentTools(service).get("subagent_status"), {
      runIds: [run.id],
    });
    expect(result?.details).toMatchObject({ cards: [{ id: run.id, modelOverride }] });
    expect(result?.structuredContent).toMatchObject({
      targets: [{ runId: run.id, modelOverride }],
    });
  });
});
