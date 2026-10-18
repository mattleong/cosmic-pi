import { initTheme, type AgentToolResult } from "@earendil-works/pi-coding-agent";
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
import { SubagentBackendRegistry } from "../../src/backend/service.ts";
import { type ProfileCandidate } from "../../src/profiles/model.ts";
import { SubagentProfileService } from "../../src/profiles/service.ts";
import { SubagentProcessError } from "../../src/run/errors.ts";
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
import { extensionApiFixture } from "pi-cosmic-core/testing";

const route = (overrides: Partial<ProfileCandidate> = {}): ProfileCandidate => ({
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

describe("subagent tool", () => {
  beforeAll(() => initTheme("dark", false));

  effectTest("resolves authenticated child starts through the caller's session", function* () {
    const callers: Array<readonly [string, string | undefined]> = [];
    const requests: StartSubagentRequest[] = [];
    const service = subagentServiceDouble({
      captureLaunchParent: () =>
        Effect.succeed({
          cwd: "/child-project",
          parentContext: {
            sessionId: "child-session",
            model: "openai-codex/gpt-5.6-sol",
            effort: "medium",
          },
        }),
      startSessionOwnedFrom: (callerRunId, request) =>
        Effect.sync(() => {
          callers.push([callerRunId, request.profile]);
          requests.push(request);
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
    expect(requests[1]).toMatchObject({
      cwd: "/child-project",
      effort: "medium",
      parentSessionId: "child-session",
    });
    expect(proxied.usage).toBeUndefined();
    expect(decodeSubagentProxyResult(encodeSubagentProxyPayload(proxied) ?? "")).toBeDefined();
  });

  effectTest("threads isolation to writer launches and ignores it for readers", function* () {
    const requests: StartSubagentRequest[] = [];
    const result = yield* invokeOptionalTool(startTool(requests), {
      agents: [
        { task: "Implement token parsing", profile: "worker", isolation: "worktree" },
        { task: "Implement the docs", profile: "worker" },
        { task: "Map the auth flow", profile: "scout", isolation: "worktree" },
      ],
    });
    expect(result?.details).not.toHaveProperty("startFailures");
    expect(requests.map((request) => request.writerWorkspaceModeOverride)).toEqual([
      "worktree",
      undefined,
      undefined,
    ]);
    expect(requests.map((request) => request.writeIntent)).toEqual([
      "writer",
      "writer",
      "read-only",
    ]);
  });

  effectTest("rejects an invalid route before readiness or service start", function* () {
    const requests: StartSubagentRequest[] = [];
    const profiles = profileServiceFor({
      profiles: {
        reviewer: {
          host: "local",
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
      { effort: "high" },
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
