// Promise assertions are test-runner boundaries.
import { initTheme } from "@earendil-works/pi-coding-agent";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
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
import type { SubagentStartDetails } from "../../src/tools/details-schema.ts";
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
import { extensionContextFixture } from "pi-cosmic-core/testing";
import { extensionApiFixture } from "../fixtures/pi-host.ts";

const route = (overrides: Partial<DeclaredProfileCandidate> = {}): DeclaredProfileCandidate => ({
  host: "local",
  runtime: "pi",
  model: "parent",
  effort: "default",
  context: "fresh",
  writeIntent: "read-only",
  ...overrides,
});

const startTool = (requests: StartSubagentRequest[], options?: CaptureOptions) =>
  captureSubagentTools(startCapturingService(requests), options).get("subagent_start");

/** Resolves every selection to its own runtime and fails preflight when `reject` names a failure. */
const preflightRegistry = (
  reject: (selection: BackendSelection) => InvalidSubagentRequestError | undefined,
): SubagentBackendRegistryContract => {
  const driver = (selection: BackendSelection) => ({
    ...testBackendDriver,
    runtime: selection.runtime,
  });
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
        profileGuidance: expect.stringContaining("Act as a generalist"),
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

  effectTest("does not request confirmation when launches use profile routing", function* () {
    const confirm = vi.fn(() => Promise.resolve(true));
    const requests: StartSubagentRequest[] = [];

    yield* invokeOptionalTool(
      startTool(requests),
      { agents: [{ task: "Inspect auth", profile: "scout" }] },
      {
        context: extensionContextFixture({
          ...context,
          ui: { confirm },
        }),
      },
    );

    expect(confirm).not.toHaveBeenCalled();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.selection?.source).toBe("profile-parent-candidate");
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
        reason: "Profile reviewer selected session override candidate 1 (local/pi).",
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
        // Built-in profile effort defaults are soft preferences, never hard requirements.
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
        selection.runtime === "claude"
          ? invalidRequest("claude_unauthenticated", "Claude fixture auth unavailable.")
          : selection.runtime === "codex"
            ? invalidRequest("codex_effort_unsupported", "Codex fixture effort unavailable.")
            : undefined,
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
          ...route({ runtime: "codex", model: "gpt-5.4", effort: "high" }),
          host: "herdr",
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
    "clamps unknown host thinking levels to high instead of forwarding them to children",
    function* () {
      expect(decodeSubagentEffort("xhigh")).toBe("xhigh");
      expect(decodeSubagentEffort(" MAX ")).toBe("max");
      expect(decodeSubagentEffort("ultra")).toBeUndefined();
      expect(decodeSubagentEffort(42)).toBeUndefined();
      expect(decodeSubagentEffort(undefined)).toBeUndefined();

      const startWithLevel = (thinkingLevel: string | number) =>
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
      // Future or malformed host levels clamp to the shared "high" inheritance default.
      expect(yield* startWithLevel("ultra")).toEqual(["high"]);
      expect(yield* startWithLevel(42)).toEqual(["high"]);
      expect(yield* startWithLevel(" MEDIUM ")).toEqual(["medium"]);
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
      expect(result?.content[0]?.text).toContain("[profile_unknown]");
      expect(result?.content[0]?.text).toContain("[profile_no_eligible_model]");
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
    // SAFETY: The public start tool persists SubagentStartDetails on this path.
    const details = result?.details as SubagentStartDetails | undefined;
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
    expect(details?.startFailures?.[0]?.index).toBe(failedEntry?.index);
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
    ])
      yield* step(() =>
        expect(
          // SAFETY: These hostile shapes prove forged routing fields and internal continuation capabilities cannot enter public start.
          reject({ task: "Probe", ...forged } as SubagentProfileStartSpec),
        ).rejects.toMatchObject({ code: "launch_override_not_allowed" }),
      );
  });

  effectTest("publishes request-ordered partial receipts for out-of-order launches", function* () {
    const slowLaunch = Deferred.makeUnsafe<void>();
    const updates: Array<{ readonly text: string; readonly details: unknown }> = [];
    const recordUpdate = (update: { content?: unknown; details?: unknown }) => {
      // SAFETY: The tool's update contract is a content array of text blocks plus a details payload.
      const text =
        (update.content as ReadonlyArray<{ readonly text?: string }> | undefined)?.[0]?.text ?? "";
      updates.push({ text, details: update.details });
    };
    const service = subagentServiceDouble({
      startSessionOwned: (input: StartSubagentRequest) =>
        input.name === "launch-1"
          ? Deferred.await(slowLaunch).pipe(Effect.as(view({ id: "agent-slow", name: "launch-1" })))
          : input.name === "launch-2"
            ? Effect.fail(
                new SubagentProcessError({ operation: "start", message: "simulated failure" }),
              )
            : Effect.sync(() => view({ id: "agent-fast", name: "launch-3" })),
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

    // The first partial receipt names the two unresolved launches in request order.
    const partial = updates[0]!;
    expect(partial.text).toContain("Processed 1 of 3 launches");
    expect(partial.text).toContain("0 started");
    expect(partial.text).toContain("1 failed");
    expect(partial.text).toContain("2 pending (#1 launch-1, #3 launch-3)");

    // Every published receipt stays request-ordered, and pending entries stay resolving.
    const receipt = (update: (typeof updates)[number]) =>
      // SAFETY: The tool constructs these persisted details on this public path.
      update.details as SubagentStartDetails;
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
