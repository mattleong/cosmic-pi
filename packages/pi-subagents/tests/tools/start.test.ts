import { initTheme, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as Schema from "effect/Schema";
import * as Match from "effect/Match";
import { assert, beforeAll, describe, expect, vi } from "vitest";
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
import { MAX_NAME_CHARS } from "../../src/run/state.ts";
import { SubagentService } from "../../src/run/service.ts";
import { executeSubagentActionEffect } from "../../src/tools/execute.ts";
import {
  decodeSubagentProxyResult,
  encodeSubagentProxyPayload,
} from "../../src/tools/proxy-protocol.ts";
import { decodeSubagentContract } from "../../src/tools/contract-schema.ts";
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
import * as Arr from "effect/Array";
import * as Str from "effect/String";

const route = (overrides: Partial<ProfileCandidate> = {}): ProfileCandidate => ({
  model: "parent",
  effort: "default",
  context: "fresh",
  writeIntent: "read-only",
  ...overrides,
});

const decodeStartDetails = Schema.decodeUnknownSync(SubagentStartDetailsSchema);

const startTool = (requests: StartSubagentRequest[], options?: CaptureOptions) =>
  captureSubagentTools(startCapturingService(requests), options).get("agent_start");

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
        tool: "agent_start",
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

  effectTest("threads isolation to writers and refuses a worktree for readers", function* () {
    const requests: StartSubagentRequest[] = [];
    const result = yield* invokeOptionalTool(startTool(requests), {
      agents: [
        { task: "Implement token parsing", profile: "worker", isolation: "worktree" },
        { task: "Implement the docs", profile: "worker" },
        { task: "Map the auth flow", profile: "scout", isolation: "worktree" },
        { task: "Map billing", profile: "scout", isolation: "shared-checkout" },
      ],
    });
    // A read-only run still holds write-capable tools, so a requested worktree fails closed.
    expect(result?.details).toMatchObject({
      startFailures: [{ index: 2, code: "isolation_requires_writer" }],
    });
    expect(Arr.map(requests, (request) => request.writerWorkspaceModeOverride)).toEqual([
      "worktree",
      undefined,
      undefined,
    ]);
    expect(Arr.map(requests, (request) => request.writeIntent)).toEqual([
      "writer",
      "writer",
      "read-only",
    ]);
    expect(Arr.map(requests, (request) => request.selection?.warning)).toEqual([
      undefined,
      undefined,
      expect.stringContaining("isolation"),
    ]);
  });

  effectTest("rejects an invalid route before readiness or service start", function* () {
    const requests: StartSubagentRequest[] = [];
    const profiles = profileServiceFor({
      profiles: {
        reviewer: {
          host: "local",
          model: "openai/opus",
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
          SubagentProcessError.make({
            operation: "spawn",
            code: "post_selection_start_failed",
            message: "Selected candidate failed after start ownership began.",
          }),
        );
      };
      const service = subagentServiceDouble({ start: failStart, startSessionOwned: failStart });
      const result = yield* invokeOptionalTool(
        captureSubagentTools(service, { profiles }).get("agent_start"),
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
    const tool = captureSubagentTools(service).get("agent_start");

    const result = yield* invokeOptionalTool(tool, { agents: [{ task: "Review auth" }] });

    expect(sessionOwnedStarts).toBe(1);
    expect(result?.content[0]?.text).toContain("agent-1");
  });

  effectTest("launches entries with a blank name under their default names", function* () {
    const requests: StartSubagentRequest[] = [];
    const tool = startTool(requests)!;
    const prepared = tool.prepareArguments?.({
      agents: [
        { task: "Map auth", name: "" },
        { task: "Map billing", name: " \n " },
      ],
    });

    const result = yield* invokeOptionalTool(tool, prepared);

    // An unnamed request gets the service's default name.
    expect(Arr.map(requests, (request) => [request.task, request.name])).toEqual([
      ["Map auth", undefined],
      ["Map billing", undefined],
    ]);
    expect(result?.structuredContent).toMatchObject({
      launches: [{ status: "started" }, { status: "started" }],
    });
  });

  effectTest("cuts a long display name instead of rejecting the launch", function* () {
    const requests: StartSubagentRequest[] = [];
    const tool = startTool(requests)!;
    const name = `${Fn.pipe("long-name-", Str.repeat(30))}end`;
    const prepared = tool.prepareArguments?.({ agents: [{ task: "Map auth", name }] });

    const result = yield* invokeOptionalTool(tool, prepared);

    expect(requests).toHaveLength(1);
    // The request carries the cut name, so a worktree's recorded launch keeps the bound too.
    expect(requests[0]?.name?.length).toBeLessThanOrEqual(MAX_NAME_CHARS);
    assert(requests[0]?.name !== undefined);
    expect(Fn.pipe(requests[0].name, Str.startsWith("long-name-"))).toBe(true);
    const launch = decodeStartDetails(result?.details).startEntries?.[0];
    expect(launch?.status).toBe("started");
    expect(launch?.name.length).toBeLessThanOrEqual(MAX_NAME_CHARS);
    const contract = decodeSubagentContract("agent_start")(result?.structuredContent);
    expect(contract?.launches[0]).toMatchObject({ status: "started" });
    assert(contract?.launches[0]?.name !== undefined);
    expect(Fn.pipe(contract.launches[0].name, Str.startsWith("long-name-"))).toBe(true);
  });

  effectTest("rejects forged routing fields again at the host profile boundary", function* () {
    const pi = extensionApiFixture({
      getThinkingLevel: () => "high",
      getActiveTools: () => ["read"],
    });
    const reject = (input: SubagentProfileStartSpec) =>
      resolveProfileStart(pi, input, context, {
        cwd: "/project",
        projectTrusted: true,
      }).pipe(
        Effect.provideService(SubagentProfileService, fallbackProfileService),
        Effect.provideService(SubagentBackendRegistry, testBackendRegistry),
        Effect.flip,
        Effect.orDie,
      );

    for (const forged of [
      { effort: "high" },
      { backend: "local-cli" },
      { routeContinuation: {} },
      { supersedes: {} },
    ]) {
      const spec = { task: "Probe", ...forged };
      expect(yield* reject(spec)).toMatchObject({ code: "launch_override_not_allowed" });
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
              SubagentProcessError.make({ operation: "start", message: "simulated failure" }),
            ),
          ),
          Match.orElse(() => Effect.sync(() => view({ id: "agent-fast", name: "launch-3" }))),
        ),
    });
    const tool = captureSubagentTools(service).get("agent_start")!;
    const agents = Arr.map(["launch-1", "launch-2", "launch-3"], (name) => ({
      task: "Review",
      name,
    }));

    const execution = executeTool(tool, { agents }, { update: recordUpdate });
    yield* step(() =>
      vi.waitFor(() => {
        if (!Arr.some(updates, (update) => Fn.pipe(update.text, Str.includes("Processed 1 of 3"))))
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
      expect(Arr.map(receipt(update).startEntries, (entry) => entry.index)).toEqual([0, 1, 2]);
    const partialReceipt = receipt(partial);
    expect(partialReceipt.startEntries[0]).toMatchObject({ status: "pending" });
    expect(partialReceipt.startEntries[1]).toMatchObject({
      status: "failed",
      routeStatus: "selected",
    });
    expect(partialReceipt.startEntries[2]).toMatchObject({ status: "pending" });

    const final = receipt(updates.at(-1)!);
    expect(
      Arr.map(final.startEntries, (entry) => ("runId" in entry ? entry.runId : undefined)),
    ).toEqual(["agent-slow", undefined, "agent-fast"]);
    assert(final.startFailures !== undefined);
    expect(Arr.map(final.startFailures, (failure) => failure.index)).toEqual([1]);
    expect(result.content[0]?.text).toContain("agent-slow");
    expect(result.content[0]?.text).toContain("agent-fast");
  });
});
