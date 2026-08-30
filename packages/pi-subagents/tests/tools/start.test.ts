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
import { decodeSubagentEffort, type SubagentRuntime } from "../../src/domain/routing.ts";
import type { StartSubagentRequest } from "../../src/run/model.ts";
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
import { extensionApiFixture, extensionContextFixture } from "../fixtures/pi-host.ts";

describe("subagent tool", () => {
  beforeAll(() => initTheme("dark", false));

  effectTest(
    "uses short-form defaults and snapshots ordered root tools without write-intent filtering",
    function* () {
      let request: StartSubagentRequest | undefined;
      const service = subagentServiceDouble({
        start: (input) => Effect.sync(() => ((request = input), view())),
      });
      const tool = captureSubagentTools(service, [
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
      expect(tool?.promptGuidelines?.join(" ")).toContain(
        "parent coordinates and reviews but does not edit",
      );
      expect(tool?.promptGuidelines?.join(" ")).toContain("pairwise-disjoint exact writes claims");
      expect(result?.content[0]?.text).toContain("agent-1");
      expect(request).toMatchObject({
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
    const tool = captureSubagentTools(
      startCapturingService([]),
      ["read"],
      fallbackProfileService,
      undefined,
      { cwd: "/project", projectTrusted: true },
      "high",
      undefined,
      presentation,
    ).get("subagent_start");

    yield* maybe(() =>
      tool?.execute("call", { agents: [{ task: "Review auth" }] }, undefined, undefined, context),
    );

    expect(presentation.beginStart).toHaveBeenCalledWith(1);
    expect(release).toHaveBeenCalledOnce();
  });

  effectTest("threads exact writes claims only through writer profiles", function* () {
    const requests: StartSubagentRequest[] = [];
    const tools = captureSubagentTools(startCapturingService(requests));
    const start = tools.get("subagent_start");

    const result = yield* maybe(() =>
      start?.execute(
        "call",
        {
          agents: [
            {
              task: "Implement token parsing",
              profile: "worker",
              writes: ["packages/auth/src/token.ts", "packages/auth/tests/token.test.ts"],
            },
          ],
        },
        undefined,
        undefined,
        context,
      ),
    );
    expect(result?.content[0]?.text).toContain("agent-1");
    expect(requests[0]).toMatchObject({
      writeIntent: "writer",
      writes: ["packages/auth/src/token.ts", "packages/auth/tests/token.test.ts"],
    });

    const rejected = yield* maybe(() =>
      start?.execute(
        "call",
        {
          agents: [
            { task: "Inspect auth", profile: "scout", writes: ["packages/auth/src/token.ts"] },
          ],
        },
        undefined,
        undefined,
        context,
      ),
    );
    expect(rejected?.content[0]?.text).toContain(
      "writes may be supplied only for a writer profile",
    );
    expect(requests).toHaveLength(1);
  });

  effectTest("skips read-only route candidates when exact writes require a writer", function* () {
    const requests: StartSubagentRequest[] = [];
    const profiles = profileServiceFor({
      profiles: {
        worker: [
          {
            host: "local",
            runtime: "pi",
            model: "parent",
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
            writeIntent: "writer",
          },
        ],
      },
    });
    const start = captureSubagentTools(startCapturingService(requests), ["read"], profiles).get(
      "subagent_start",
    );
    yield* maybe(() =>
      start?.execute(
        "call",
        {
          agents: [
            {
              task: "Implement auth",
              profile: "worker",
              writes: ["src/auth.ts"],
            },
          ],
        },
        undefined,
        undefined,
        context,
      ),
    );
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
              openaiFastMode: false,
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
    "falls back from an unsupported Herdr protocol to the matching local runtime",
    function* () {
      const runtimeCases = [
        {
          runtime: "pi",
          model: "openai-codex/gpt-5.6-sol",
          openaiFastMode: true,
        },
        { runtime: "claude", model: "claude-opus-5", openaiFastMode: false },
        { runtime: "codex", model: "gpt-5.6-codex", openaiFastMode: false },
      ] as const;

      for (const runtimeCase of runtimeCases) {
        const requests: StartSubagentRequest[] = [];
        const profiles = profileServiceFor({
          profiles: {
            reviewer: {
              host: "herdr",
              runtime: runtimeCase.runtime,
              model: runtimeCase.model,
              effort: "high",
              context: "fresh",
              writeIntent: "read-only",
              openaiFastMode: runtimeCase.openaiFastMode,
              closeOnReport: false,
            },
          },
        });
        const driverFor = (runtime: SubagentRuntime) => ({ ...testBackendDriver, runtime });
        const registry: SubagentBackendRegistryContract = {
          resolve: (selection) => Effect.succeed(driverFor(selection.runtime)),
          preflight: (selection) =>
            selection.host === "herdr"
              ? Effect.fail(
                  new InvalidSubagentRequestError({
                    code: "herdr_protocol_unsupported",
                    message:
                      "Unsupported Herdr protocol 21. pi-subagents supports protocol 20; Herdr launch was blocked before topology changes.",
                  }),
                )
              : Effect.succeed(driverFor(selection.runtime)),
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

        expect(requests).toHaveLength(1);
        expect(requests[0]).toMatchObject({
          host: "local",
          runtime: runtimeCase.runtime,
          model: runtimeCase.model,
          closeOnReport: true,
          selection: {
            host: "local",
            runtime: runtimeCase.runtime,
            closeOnReport: true,
            candidateIndex: 0,
            skippedCandidates: [{ candidateIndex: 0, code: "herdr_protocol_unsupported" }],
            warning: expect.stringContaining(
              `Fell back automatically to local/${runtimeCase.runtime}`,
            ),
          },
          routeContinuation: {
            selectedCandidateIndex: 0,
            candidates: [{ host: "herdr", runtime: runtimeCase.runtime, closeOnReport: false }],
          },
        });
        expect(requests[0]?.selection?.warning).toContain("closeOnReport was forced to true");
        expect(result?.content[0]?.text).toContain("Unsupported Herdr protocol 21");
        expect(result?.details).toMatchObject({
          startEntries: [
            {
              status: "started",
              host: "local",
              runtime: runtimeCase.runtime,
              warning: expect.stringContaining(
                `Fell back automatically to local/${runtimeCase.runtime}`,
              ),
            },
          ],
        });
      }
    },
  );

  effectTest("preserves writer claims across automatic Herdr protocol fallback", function* () {
    const requests: StartSubagentRequest[] = [];
    const profiles = profileServiceFor({
      profiles: {
        worker: {
          host: "herdr",
          runtime: "pi",
          model: "openai-codex/gpt-5.6-sol",
          effort: "high",
          context: "fresh",
          writeIntent: "writer",
          closeOnReport: true,
        },
      },
    });
    const registry: SubagentBackendRegistryContract = {
      resolve: () => Effect.succeed(testBackendDriver),
      preflight: (selection) =>
        selection.host === "herdr"
          ? Effect.fail(
              new InvalidSubagentRequestError({
                code: "herdr_upgrade_required",
                message:
                  "Unsupported Herdr protocol 19. pi-subagents supports protocol 20; Herdr launch was blocked before topology changes.",
              }),
            )
          : Effect.succeed(testBackendDriver),
    };

    yield* maybe(() =>
      captureSubagentTools(startCapturingService(requests), ["read"], profiles, registry)
        .get("subagent_start")
        ?.execute(
          "call",
          {
            agents: [
              {
                profile: "worker",
                task: "Implement auth",
                writes: ["src/auth.ts"],
              },
            ],
          },
          undefined,
          undefined,
          context,
        ),
    );

    expect(requests[0]).toMatchObject({
      host: "local",
      runtime: "pi",
      writeIntent: "writer",
      writes: ["src/auth.ts"],
      selection: {
        warning: expect.stringContaining("Fell back automatically to local/pi"),
      },
    });
  });

  effectTest(
    "keeps the unsupported Herdr protocol diagnostic when local fallback also fails",
    function* () {
      const requests: StartSubagentRequest[] = [];
      const profiles = profileServiceFor({
        profiles: {
          reviewer: {
            host: "herdr",
            runtime: "claude",
            model: "claude-opus-5",
            effort: "high",
            context: "fresh",
            writeIntent: "read-only",
            closeOnReport: true,
          },
        },
      });
      const registry: SubagentBackendRegistryContract = {
        resolve: () => Effect.succeed({ ...testBackendDriver, runtime: "claude" }),
        preflight: (selection) =>
          selection.host === "herdr"
            ? Effect.fail(
                new InvalidSubagentRequestError({
                  code: "herdr_protocol_unsupported",
                  message:
                    "Unsupported Herdr protocol 21. pi-subagents supports protocol 20; Herdr launch was blocked before topology changes.",
                }),
              )
            : Effect.fail(
                new InvalidSubagentRequestError({
                  code: "claude_unauthenticated",
                  message: "Local Claude authentication is unavailable.",
                }),
              ),
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
      expect(result?.content[0]?.text).toContain("Unsupported Herdr protocol 21");
      expect(result?.content[0]?.text).toContain("Local Claude authentication is unavailable");
      expect(result?.details).toMatchObject({
        startFailures: [{ code: "profile_no_eligible_model" }],
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
    const tool = captureSubagentTools(service, ["read", "grep"]).get("subagent_start");

    const result = yield* maybe(() =>
      tool?.execute("call", { agents }, undefined, undefined, context),
    );

    expect(requests.map((request) => request.task)).toEqual(agents.map((agent) => agent.task));
    expect(requests).toHaveLength(32);
    expect(requests[0]).toMatchObject({
      host: "local",
      runtime: "pi",
      model: "openai-codex/gpt-5.6-sol",
      effort: "high",
    });
    // SAFETY: This locally constructed test fixture satisfies the declared details contract.
    const details = result?.details as
      | {
          readonly startEntries?: ReadonlyArray<{
            readonly index: number;
            readonly name: string;
            readonly profile: string;
            readonly status: "started" | "failed" | "pending";
            readonly routeStatus: "selected" | "resolving" | "unavailable";
            readonly host?: string;
            readonly runtime?: string;
            readonly model?: string;
            readonly effort?: string;
            readonly openaiFastMode?: boolean;
            readonly runId?: string;
          }>;
          readonly startFailures?: ReadonlyArray<{
            readonly index: number;
            readonly name?: string;
            readonly message: string;
            readonly code?: string;
          }>;
        }
      | undefined;
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
    const service = subagentServiceDouble({
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
