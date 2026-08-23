// Promise assertions are test-runner boundaries.
import { initTheme } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import { beforeAll, describe, expect, vi } from "vitest";
import { effectTest, maybe, step } from "../support/effect-test.ts";
import {
  resolveProfileStart,
  type SubagentProfileStartSpec,
} from "../../src/boundary/host-profile-resolution.ts";
import {
  SubagentBackendRegistry,
  type SubagentBackendRegistryContract,
} from "../../src/backend/service.ts";
import { PROFILE_IDS } from "../../src/profiles/model.ts";
import { SubagentProfileService } from "../../src/profiles/service.ts";
import { InvalidSubagentRequestError, SubagentProcessError } from "../../src/run/errors.ts";
import { decodeSubagentEffort } from "../../src/domain/routing.ts";
import { type StartSubagentRequest, type SubagentRunView } from "../../src/run/model.ts";
import { type SubagentServiceContract } from "../../src/run/service.ts";
import { subagentServiceDouble } from "./fixtures/subagent-service-double.ts";
import {
  captureSubagentTools,
  context,
  fallbackProfileService,
  profileServiceFor,
  startCapturingService,
  testBackendDriver,
  testBackendRegistry,
  view,
} from "./fixtures/tool-harness.ts";
import {
  extensionContextFixture,
  subagentServiceFixture,
  extensionApiFixture,
} from "../fixtures/pi-host.ts";

describe("subagent tool", () => {
  beforeAll(() => initTheme("dark", false));

  effectTest(
    "uses short-form profile defaults, inherits model effort, and strips recursive tools",
    function* () {
      let request: StartSubagentRequest | undefined;
      const service = subagentServiceDouble({
        start: (input) => Effect.sync(() => ((request = input), view())),
        awaitTerminal: () => Effect.succeed([view()]),
        list: Effect.succeed([]),
        status: () => Effect.succeed(view()),
        send: () => Effect.succeed(view()),
        reply: () => Effect.succeed(view()),
        interrupt: () => Effect.succeed(view()),
        resume: () => Effect.succeed(view()),
        rename: () => Effect.succeed(view()),
        stop: () => Effect.succeed(view()),
        projection: Effect.succeed({ revision: 0, runs: [] }),
      });
      const tool = captureSubagentTools(service, [
        "read",
        "grep",
        "edit",
        "write",
        "bash",
        "mcp",
        "subagent_start",
        "subagent_await",
        "workflow",
      ]).get("subagent_start");

      const result = yield* maybe(() =>
        tool?.execute(
          "call",
          {
            agents: [{ task: "Review auth" }],
          },
          undefined,
          undefined,
          context,
        ),
      );

      expect(tool?.name).toBe("subagent_start");
      expect(tool?.renderShell).toBe("default");
      expect(tool?.renderCall).toBeTypeOf("function");
      expect(tool?.renderResult).toBeTypeOf("function");
      expect(tool?.promptGuidelines?.join(" ")).toContain("one writer");
      expect(tool?.promptGuidelines?.join(" ")).toContain(
        "Each agent item accepts task, optional profile, and optional name",
      );
      expect(result?.content[0]?.text).toContain("agent-1");
      expect(request).toMatchObject({
        context: "fresh",
        model: "openai-codex/gpt-5.6-sol",
        effort: "high",
        writeIntent: "read-only",
        parentLeafId: "user-1",
        activeTools: ["read", "grep", "bash"],
      });
    },
  );

  effectTest("does not request confirmation when launches use profile routing", function* () {
    const confirm = vi.fn(() => Promise.resolve(true));
    const requests: StartSubagentRequest[] = [];
    const tool = captureSubagentTools(startCapturingService(requests)).get("subagent_start");

    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    yield* maybe(() =>
      tool?.execute(
        "call",
        { agents: [{ task: "Inspect auth", profile: "scout" }] },
        undefined,
        undefined,
        extensionContextFixture({
          ...context,
          ui: { confirm },
        }),
      ),
    );

    expect(confirm).not.toHaveBeenCalled();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.selection?.source).toBe("profile-parent-candidate");
  });

  effectTest(
    "routes the short form through the neutral generalist profile and records provenance",
    function* () {
      const requests: StartSubagentRequest[] = [];
      const tool = captureSubagentTools(startCapturingService(requests), ["read"]).get(
        "subagent_start",
      );

      yield* maybe(() =>
        tool?.execute(
          "call",
          { agents: [{ task: "Inspect auth" }] },
          undefined,
          undefined,
          context,
        ),
      );

      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        profile: "generalist",
        context: "fresh",
        model: "openai-codex/gpt-5.6-sol",
        selection: {
          source: "profile-parent-candidate",
          reason: "Profile generalist selected built-in route candidate 1 (local/pi).",
          skippedCandidates: [],
        },
      });
      expect(requests[0]?.profileGuidance).toContain("Act as a generalist");
    },
  );

  effectTest("uses one active session override for discovery and launch provenance", function* () {
    const requests: StartSubagentRequest[] = [];
    const profiles = profileServiceFor(undefined, undefined, {
      revision: 1,
      overrides: {
        reviewer: {
          candidates: [
            {
              host: "local",
              runtime: "pi",
              model: "openai-codex/gpt-5.6-sol",
              effort: "low",
              context: "fresh",
              writeIntent: "read-only",
              fastMode: false,
              closeOnReport: true,
            },
          ],
        },
      },
    });
    const tools = captureSubagentTools(startCapturingService(requests), ["read"], profiles);
    const models = yield* maybe(() =>
      tools
        .get("subagent_models")
        ?.execute("call", { profile: "reviewer" }, undefined, undefined, context),
    );
    expect(models?.content[0]?.text).toContain("source=session");
    expect(models?.content[0]?.text).toContain("openai-codex/gpt-5.6-sol:low");

    yield* maybe(() =>
      tools
        .get("subagent_start")
        ?.execute(
          "call",
          { agents: [{ task: "Review auth", profile: "reviewer" }] },
          undefined,
          undefined,
          context,
        ),
    );
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
      const tool = captureSubagentTools(startCapturingService(requests)).get("subagent_start");

      yield* maybe(() =>
        tool?.execute(
          "call",
          {
            agents: PROFILE_IDS.map((profile) => ({
              profile,
              task: `Smoke test ${profile}`,
            })),
          },
          undefined,
          undefined,
          context,
        ),
      );

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

  effectTest(
    "uses profile context defaults and never degrades a Pi oracle fork to fresh",
    function* () {
      const requests: StartSubagentRequest[] = [];
      const tool = captureSubagentTools(startCapturingService(requests)).get("subagent_start");

      yield* maybe(() =>
        tool?.execute(
          "call",
          {
            agents: [
              { profile: "reviewer", task: "Review" },
              { profile: "oracle", task: "Advise" },
            ],
          },
          undefined,
          undefined,
          context,
        ),
      );

      expect(requests.map((request) => [request.profile, request.context])).toEqual([
        ["reviewer", "fresh"],
        ["oracle", "fork"],
      ]);

      // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
      const ephemeral = extensionContextFixture({
        ...context,
        sessionManager: {
          ...context.sessionManager,
          getSessionFile: () => undefined,
          getLeafEntry: () => undefined,
        },
      });
      const failed = yield* maybe(() =>
        tool?.execute(
          "call",
          {
            agents: [{ profile: "oracle", task: "Advise" }],
          },
          undefined,
          undefined,
          ephemeral,
        ),
      );
      expect(failed?.details).toMatchObject({
        startFailures: [{ code: "fork_context_unavailable" }],
      });
    },
  );

  effectTest(
    "falls back from configured unsupported backends before local Pi service start",
    function* () {
      const requests: StartSubagentRequest[] = [];
      const profiles = profileServiceFor({
        profiles: {
          reviewer: [
            {
              host: "herdr",
              runtime: "claude",
              model: "sonnet",
              effort: "high",
              context: "fresh",
              writeIntent: "read-only",
              closeOnReport: false,
            },
            {
              host: "local",
              runtime: "pi",
              model: "parent",
              effort: "default",
              context: "fresh",
              writeIntent: "read-only",
            },
          ],
        },
      });
      const tool = captureSubagentTools(startCapturingService(requests), ["read"], profiles).get(
        "subagent_start",
      );

      yield* maybe(() =>
        tool?.execute(
          "call",
          { agents: [{ profile: "reviewer", task: "Review" }] },
          undefined,
          undefined,
          context,
        ),
      );

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
            {
              host: "local",
              runtime: "claude",
              model: "sonnet",
              effort: "xhigh",
              context: "fresh",
              writeIntent: "read-only",
            },
            {
              host: "local",
              runtime: "codex",
              model: "gpt-5.6-sol",
              effort: "max",
              context: "fresh",
              writeIntent: "read-only",
            },
            {
              host: "local",
              runtime: "pi",
              model: "parent",
              effort: "high",
              context: "fresh",
              writeIntent: "read-only",
            },
          ],
        },
      });
      const registry: SubagentBackendRegistryContract = {
        resolve: () => Effect.succeed(testBackendDriver),
        preflight: (selection) =>
          selection.runtime === "claude"
            ? Effect.fail(
                new InvalidSubagentRequestError({
                  code: "claude_unauthenticated",
                  message: "Claude fixture auth unavailable.",
                }),
              )
            : selection.runtime === "codex"
              ? Effect.fail(
                  new InvalidSubagentRequestError({
                    code: "codex_effort_unsupported",
                    message: "Codex fixture effort unavailable.",
                  }),
                )
              : Effect.succeed(testBackendDriver),
      };
      yield* maybe(() =>
        captureSubagentTools(startCapturingService(requests), ["read"], profiles, registry)
          .get("subagent_start")
          ?.execute(
            "call",
            { agents: [{ profile: "reviewer", task: "Review" }] },
            undefined,
            undefined,
            context,
          ),
      );
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

  effectTest("does not fall through after uncertain readiness-process cleanup", function* () {
    const requests: StartSubagentRequest[] = [];
    const profiles = profileServiceFor({
      profiles: {
        reviewer: [
          {
            host: "local",
            runtime: "claude",
            model: "sonnet",
            effort: "xhigh",
            context: "fresh",
            writeIntent: "read-only",
          },
          {
            host: "local",
            runtime: "pi",
            model: "parent",
            effort: "high",
            context: "fresh",
            writeIntent: "read-only",
          },
        ],
      },
    });
    const registry: SubagentBackendRegistryContract = {
      resolve: () => Effect.succeed(testBackendDriver),
      preflight: (selection) =>
        selection.runtime === "claude"
          ? Effect.fail(
              new InvalidSubagentRequestError({
                code: "claude_preflight_cleanup_unconfirmed",
                message: "Fixture readiness process cleanup is uncertain.",
              }),
            )
          : Effect.succeed(testBackendDriver),
    };
    const result = yield* maybe(() =>
      captureSubagentTools(startCapturingService(requests), ["read"], profiles, registry)
        .get("subagent_start")
        ?.execute(
          "call",
          { agents: [{ profile: "reviewer", task: "Review" }] },
          undefined,
          undefined,
          context,
        ),
    );
    expect(requests).toEqual([]);
    expect(result?.details).toMatchObject({
      startFailures: [{ code: "claude_preflight_cleanup_unconfirmed" }],
    });
  });

  effectTest("fails an unsupported-only route before service start", function* () {
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
          closeOnReport: false,
        },
      },
    });
    const result = yield* maybe(() =>
      captureSubagentTools(startCapturingService(requests), ["read"], profiles)
        .get("subagent_start")
        ?.execute(
          "call",
          { agents: [{ profile: "reviewer", task: "Review" }] },
          undefined,
          undefined,
          context,
        ),
    );
    expect(requests).toEqual([]);
    expect(result?.details).toMatchObject({
      startFailures: [{ code: "backend_not_implemented" }],
    });
  });

  effectTest(
    "does not fall through to another candidate after the selected start reaches the service",
    function* () {
      const profiles = profileServiceFor({
        profiles: {
          reviewer: [
            {
              host: "local",
              runtime: "pi",
              model: "openai-codex/gpt-5.6-sol",
              effort: "default",
              context: "fresh",
              writeIntent: "read-only",
            },
            {
              host: "local",
              runtime: "pi",
              model: "parent",
              effort: "default",
              context: "fresh",
              writeIntent: "read-only",
            },
          ],
        },
      });
      let starts = 0;
      const base = startCapturingService([]);
      const failStart: SubagentServiceContract["start"] = () => {
        starts += 1;
        return Effect.fail(
          new SubagentProcessError({
            operation: "spawn",
            code: "post_selection_start_failed",
            message: "Selected candidate failed after start ownership began.",
          }),
        );
      };
      const service = subagentServiceDouble({
        ...base,
        start: failStart,
        startSessionOwned: failStart,
      });
      const result = yield* maybe(() =>
        captureSubagentTools(service, ["read"], profiles)
          .get("subagent_start")
          ?.execute(
            "call",
            {
              agents: [{ profile: "reviewer", task: "Review" }],
            },
            undefined,
            undefined,
            context,
          ),
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

      const startWithLevel = (thinkingLevel: string | number) => {
        const requests: StartSubagentRequest[] = [];
        const tools = captureSubagentTools(
          startCapturingService(requests),
          ["read"],
          fallbackProfileService,
          undefined,
          { cwd: "/project", projectTrusted: true },
          thinkingLevel,
        );
        return Promise.resolve(
          tools
            .get("subagent_start")
            ?.execute(
              "automatic",
              { agents: [{ profile: "generalist", task: "Probe" }] },
              undefined,
              undefined,
              context,
            ),
        ).then(() => requests.map((request) => request.effort));
      };

      expect(yield* step(() => startWithLevel("low"))).toEqual(["low"]);
      // Future or malformed host levels clamp to the shared "high" inheritance default.
      expect(yield* step(() => startWithLevel("ultra"))).toEqual(["high"]);
      expect(yield* step(() => startWithLevel(42))).toEqual(["high"]);
      expect(yield* step(() => startWithLevel(" MEDIUM "))).toEqual(["medium"]);
    },
  );

  effectTest(
    "returns model-visible profile_unknown and profile_no_eligible_model codes",
    function* () {
      const requests: StartSubagentRequest[] = [];
      const emptyRoute = profileServiceFor({ profiles: { reviewer: "disabled" } });
      const tool = captureSubagentTools(startCapturingService(requests), ["read"], emptyRoute).get(
        "subagent_start",
      );
      const result = yield* maybe(() =>
        tool?.execute(
          "call",
          {
            agents: [
              { profile: "future", task: "Unknown" },
              { profile: "reviewer", task: "Review" },
            ],
          },
          undefined,
          undefined,
          context,
        ),
      );
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

  effectTest("starts a per-agent batch and keeps successful launches when one fails", function* () {
    const requests: StartSubagentRequest[] = [];
    const service = subagentServiceDouble({
      start: (input) =>
        Effect.sync(() => requests.push(input)).pipe(
          Effect.flatMap((index) =>
            input.task === "Fail launch"
              ? Effect.fail(
                  new SubagentProcessError({
                    operation: "start",
                    message: "simulated launch failure",
                  }),
                )
              : Effect.succeed(
                  view({
                    id: `agent-${index}`,
                    name: input.name ?? `agent-${index}`,
                    task: input.task,
                    model: input.model,
                  }),
                ),
          ),
        ),
      awaitTerminal: () => Effect.succeed([]),
      list: Effect.succeed([]),
      status: () => Effect.succeed(view()),
      send: () => Effect.succeed(view()),
      reply: () => Effect.succeed(view()),
      interrupt: () => Effect.succeed(view()),
      resume: () => Effect.succeed(view()),
      rename: () => Effect.succeed(view()),
      stop: () => Effect.succeed(view()),
      projection: Effect.succeed({ revision: 0, runs: [] }),
    });
    const tool = captureSubagentTools(service, ["read", "grep"]).get("subagent_start");

    const result = yield* maybe(() =>
      tool?.execute(
        "call",
        {
          agents: [
            { task: "Review auth", name: "auth" },
            { task: "Fail launch", name: "broken" },
            {
              task: "Review storage",
              name: "storage",
            },
          ],
        },
        undefined,
        undefined,
        context,
      ),
    );

    expect(requests.map((request) => request.task)).toEqual([
      "Review auth",
      "Fail launch",
      "Review storage",
    ]);
    expect(requests[0]).toMatchObject({
      host: "local",
      runtime: "pi",
      model: "openai-codex/gpt-5.6-sol",
      effort: "high",
    });
    expect(result?.content[0]?.text).toContain("Failed starts (1)");
    expect(result?.content[0]?.text).toContain(
      "#2 broken [SubagentProcessError]: simulated launch failure",
    );
    expect(result?.content[0]?.text).toContain("agent-1");
    expect(result?.content[0]?.text).toContain("agent-3");
    expect(result?.details).toMatchObject({
      action: "start",
      cards: [{ id: "agent-1" }, { id: "agent-3" }],
      startEntries: [
        {
          index: 0,
          profile: "generalist",
          status: "started",
          routeStatus: "selected",
          host: "local",
          runtime: "pi",
          model: "openai-codex/gpt-5.6-sol",
          runId: "agent-1",
        },
        {
          index: 1,
          profile: "generalist",
          status: "failed",
          routeStatus: "selected",
          host: "local",
          runtime: "pi",
          model: "openai-codex/gpt-5.6-sol",
        },
        {
          index: 2,
          profile: "generalist",
          status: "started",
          routeStatus: "selected",
          runId: "agent-3",
        },
      ],
      startFailures: [{ index: 1, name: "broken", message: "simulated launch failure" }],
    });
  });

  effectTest("rejects per-launch routing overrides before side effects", function* () {
    const requests: StartSubagentRequest[] = [];
    const tool = captureSubagentTools(startCapturingService(requests)).get("subagent_start");

    for (const fields of [
      { execution: "foreground" },
      { context: "fresh" },
      { writeIntent: "writer" },
      { effort: "high" },
    ])
      yield* step(() =>
        expect(
          tool?.execute(
            "call",
            { agents: [{ task: "Review auth", ...fields }] },
            undefined,
            undefined,
            context,
          ),
        ).rejects.toMatchObject({ code: "launch_override_not_allowed" }),
      );
    expect(requests).toEqual([]);
  });

  effectTest(
    "does not let a failed partial renderer turn a successful launch into failure",
    function* () {
      const requests: StartSubagentRequest[] = [];
      const tool = captureSubagentTools(startCapturingService(requests)).get("subagent_start");

      const result = yield* maybe(() =>
        tool?.execute(
          "call",
          {
            agents: [{ task: "Review auth" }],
          },
          undefined,
          () => {
            throw new Error("stale renderer");
          },
          context,
        ),
      );

      expect(requests).toHaveLength(1);
      expect(result?.content[0]?.text).toContain("agent-1");
      expect(result?.details).not.toHaveProperty("startFailures");
    },
  );

  effectTest("launches through the cancellation-safe session owner", function* () {
    let sessionOwnedStarts = 0;
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const service = subagentServiceFixture({
      start: () => Effect.die("interruptible start must not be used by the public tool"),
      startSessionOwned: (input: StartSubagentRequest) =>
        Effect.sync(() => {
          sessionOwnedStarts += 1;
          return view({ task: input.task });
        }),
    });
    const tool = captureSubagentTools(service).get("subagent_start");

    const result = yield* maybe(() =>
      tool?.execute("call", { agents: [{ task: "Review auth" }] }, undefined, undefined, context),
    );

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
    const tool = captureSubagentTools(startCapturingService(requests), ["read"], profiles).get(
      "subagent_start",
    );

    yield* maybe(() =>
      tool?.execute(
        "call",
        {
          agents: [
            { task: "One", profile: "scout" },
            { task: "Two", profile: "reviewer" },
          ],
        },
        undefined,
        undefined,
        context,
      ),
    );

    expect(captures).toBe(1);
    expect(requests).toHaveLength(2);
  });

  effectTest("accepts exactly twelve batch starts at the runtime boundary", function* () {
    const requests: StartSubagentRequest[] = [];
    const start = (input: StartSubagentRequest) =>
      Effect.sync(() => {
        requests.push(input);
        return view({ id: `agent-${requests.length}`, task: input.task });
      });
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const service = subagentServiceFixture({
      start,
      startSessionOwned: start,
    });
    const tool = captureSubagentTools(service).get("subagent_start");

    const result = yield* maybe(() =>
      tool?.execute(
        "call",
        {
          agents: Array.from({ length: 12 }, (_, index) => ({
            task: `Review area ${index + 1}`,
          })),
        },
        undefined,
        undefined,
        context,
      ),
    );

    expect(requests).toHaveLength(12);
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const details = result?.details as
      | { readonly cards?: ReadonlyArray<SubagentRunView> }
      | undefined;
    expect(details?.cards).toHaveLength(12);
  });

  effectTest("rejects forged routing fields again at the host profile boundary", function* () {
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
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

    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    yield* step(() =>
      expect(
        reject({ task: "Probe", model: "pi/openai/other" } as SubagentProfileStartSpec),
      ).rejects.toMatchObject({ code: "launch_override_not_allowed" }),
    );
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    yield* step(() =>
      expect(
        reject({ task: "Probe", backend: "claude-cli" } as SubagentProfileStartSpec),
      ).rejects.toMatchObject({ code: "launch_override_not_allowed" }),
    );
    // SAFETY: These hostile shapes prove internal continuation capabilities cannot enter public start.
    yield* step(() =>
      expect(
        reject({ task: "Probe", routeContinuation: {} } as SubagentProfileStartSpec),
      ).rejects.toMatchObject({ code: "launch_override_not_allowed" }),
    );
    // SAFETY: These hostile shapes prove internal continuation capabilities cannot enter public start.
    yield* step(() =>
      expect(
        reject({ task: "Probe", supersedes: {} } as SubagentProfileStartSpec),
      ).rejects.toMatchObject({ code: "launch_override_not_allowed" }),
    );
  });
});
