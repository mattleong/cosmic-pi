// Promise assertions are test-runner boundaries.
// @effect-diagnostics effect/asyncFunction:off
import { initTheme } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { BackendDriver } from "../../src/backend/model.ts";
import { type SubagentBackendRegistryContract } from "../../src/backend/service.ts";
import { type StartSubagentRequest } from "../../src/run/model.ts";
import { subagentServiceDouble } from "./fixtures/subagent-service-double.ts";
import {
  captureSubagentTools,
  context,
  profileServiceFor,
  registryContext,
  startCapturingService,
  testBackendDriver,
  view,
} from "./fixtures/tool-harness.ts";
import { extensionContextFixture } from "../fixtures/pi-host.ts";

describe("subagent tool", () => {
  beforeAll(() => initTheme("dark", false));

  it("skips extension-registered providers for Herdr Pi but permits the same @ model locally", async () => {
    const requests: StartSubagentRequest[] = [];
    const model = {
      provider: "cursor",
      id: "gpt-5.5@1m",
      name: "Cursor GPT 5.5 1M",
      reasoning: true,
      thinkingLevelMap: { high: "high" },
    };
    const profiles = profileServiceFor({
      profiles: {
        reviewer: [
          {
            host: "herdr",
            runtime: "pi",
            model: "cursor/gpt-5.5@1m",
            effort: "high",
            context: "fresh",
            writeIntent: "read-only",
            closeOnReport: true,
          },
          {
            host: "local",
            runtime: "pi",
            model: "cursor/gpt-5.5@1m",
            effort: "high",
            context: "fresh",
            writeIntent: "read-only",
            closeOnReport: true,
          },
        ],
      },
    });
    const result = await captureSubagentTools(startCapturingService(requests), ["read"], profiles)
      .get("subagent_start")
      ?.execute(
        "call",
        { agents: [{ profile: "reviewer", task: "Review with Cursor" }] },
        undefined,
        undefined,
        registryContext([model], ["cursor"]),
      );

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      host: "local",
      model: "cursor/gpt-5.5@1m",
      selection: {
        candidateIndex: 1,
        skippedCandidates: [
          expect.objectContaining({ code: "herdr_pi_extension_provider_unavailable" }),
        ],
      },
    });
    expect(result?.content[0]?.text).toContain("cursor/gpt-5.5@1m");
  });

  it("rejects a Herdr extension provider before auth or backend preflight", async () => {
    const model = {
      provider: "cursor",
      id: "gpt-5.5@1m",
      name: "Cursor GPT 5.5 1M",
      reasoning: true,
      thinkingLevelMap: { high: "high" },
    };
    const profiles = profileServiceFor({
      profiles: {
        reviewer: {
          host: "herdr",
          runtime: "pi",
          model: "cursor/gpt-5.5@1m",
          effort: "high",
          context: "fresh",
          writeIntent: "read-only",
          closeOnReport: true,
        },
      },
    });
    const baseContext = registryContext([model], ["cursor"]);
    const getAvailable = vi.fn(
      baseContext.modelRegistry.getAvailable.bind(baseContext.modelRegistry),
    );
    const getProviderAuthStatus = vi.fn();
    const getApiKeyAndHeaders = vi.fn();
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const extensionContext = extensionContextFixture({
      ...baseContext,
      modelRegistry: {
        ...baseContext.modelRegistry,
        getAvailable,
        getProviderAuthStatus,
        getApiKeyAndHeaders,
      },
    });
    const result = await captureSubagentTools(startCapturingService([]), ["read"], profiles, {
      resolve: () => Effect.succeed({ ...testBackendDriver, host: "herdr" }),
      preflight: () => Effect.die("preflight must not run"),
    })
      .get("subagent_start")
      ?.execute(
        "call",
        { agents: [{ profile: "reviewer", task: "Review extension provider" }] },
        undefined,
        undefined,
        extensionContext,
      );

    expect(getAvailable).toHaveBeenCalledTimes(1);
    expect(getProviderAuthStatus).not.toHaveBeenCalled();
    expect(getApiKeyAndHeaders).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).toContain("herdr_pi_extension_provider_unavailable");
  });

  it("fails Herdr Pi closed when registered-provider provenance cannot be inspected", async () => {
    const profiles = profileServiceFor({
      profiles: {
        reviewer: {
          host: "herdr",
          runtime: "pi",
          model: "openai-codex/gpt-5.6-sol",
          effort: "high",
          context: "fresh",
          writeIntent: "read-only",
          closeOnReport: true,
        },
      },
    });
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const unavailableContext = extensionContextFixture({
      ...context,
      modelRegistry: {
        ...context.modelRegistry,
        getRegisteredProviderIds: () => {
          throw new Error("secret provenance failure");
        },
      },
    });
    const result = await captureSubagentTools(startCapturingService([]), ["read"], profiles, {
      resolve: () => Effect.succeed({ ...testBackendDriver, host: "herdr" }),
      preflight: () => Effect.die("preflight must not run"),
    })
      .get("subagent_start")
      ?.execute(
        "call",
        { agents: [{ profile: "reviewer", task: "Review provenance" }] },
        undefined,
        undefined,
        unavailableContext,
      );

    expect(result?.details).toMatchObject({
      startFailures: [{ code: "profile_no_eligible_model" }],
    });
    expect(JSON.stringify(result)).toContain("herdr_pi_provider_provenance_unavailable");
    expect(JSON.stringify(result)).not.toContain("secret provenance failure");
  });

  it("transfers runtime-only authentication without exposing it in the model id", async () => {
    let request: StartSubagentRequest | undefined;
    const service = subagentServiceDouble({
      start: (input: StartSubagentRequest) => Effect.sync(() => ((request = input), view())),
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
    const tool = captureSubagentTools(service).get("subagent_start");
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const runtimeContext = extensionContextFixture({
      ...context,
      modelRegistry: {
        ...context.modelRegistry,
        getProviderAuthStatus: () => ({ configured: true, source: "runtime" }),
        getApiKeyAndHeaders: () => Promise.resolve({ ok: true as const, apiKey: "runtime-key" }),
      },
    });

    await tool?.execute(
      "call",
      {
        agents: [{ task: "Review auth" }],
      },
      undefined,
      undefined,
      runtimeContext,
    );

    expect(request?.runtimeApiKey && Redacted.value(request.runtimeApiKey)).toBe("runtime-key");
    expect(request?.model).toBe("openai-codex/gpt-5.6-sol");
  });

  it("privately transfers environment-authenticated models to Herdr Pi before ownership", async () => {
    const requests: StartSubagentRequest[] = [];
    const profiles = profileServiceFor({
      profiles: {
        reviewer: {
          host: "herdr",
          runtime: "pi",
          model: "openai-codex/gpt-5.6-sol",
          effort: "xhigh",
          context: "fresh",
          writeIntent: "read-only",
          closeOnReport: true,
        },
      },
    });
    const herdrPiDriver = {
      ...testBackendDriver,
      host: "herdr",
    } satisfies BackendDriver;
    let preflights = 0;
    const registry: SubagentBackendRegistryContract = {
      resolve: () => Effect.succeed(herdrPiDriver),
      preflight: () =>
        Effect.sync(() => {
          preflights += 1;
          return herdrPiDriver;
        }),
    };
    const environmentKey = "environment-only-private-key";
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const environmentContext = extensionContextFixture({
      ...context,
      modelRegistry: {
        ...context.modelRegistry,
        getProviderAuthStatus: () => ({ configured: true, source: "environment" }),
        getApiKeyAndHeaders: () => Promise.resolve({ ok: true as const, apiKey: environmentKey }),
      },
    });

    const result = await captureSubagentTools(
      startCapturingService(requests),
      ["read"],
      profiles,
      registry,
    )
      .get("subagent_start")
      ?.execute(
        "call",
        { agents: [{ profile: "reviewer", task: "Review auth" }] },
        undefined,
        undefined,
        environmentContext,
      );

    expect(preflights).toBe(1);
    expect(requests[0]).toMatchObject({
      host: "herdr",
      runtime: "pi",
    });
    expect(requests[0]?.runtimeApiKey && Redacted.value(requests[0].runtimeApiKey)).toBe(
      environmentKey,
    );
    expect(JSON.stringify(requests[0])).not.toContain(environmentKey);
    expect(JSON.stringify(result)).not.toContain(environmentKey);

    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const unavailableContext = extensionContextFixture({
      ...environmentContext,
      modelRegistry: {
        ...environmentContext.modelRegistry,
        getApiKeyAndHeaders: () => Promise.resolve({ ok: true as const }),
      },
    });
    const skipped = await captureSubagentTools(
      startCapturingService(requests),
      ["read"],
      profiles,
      registry,
    )
      .get("subagent_start")
      ?.execute(
        "call",
        { agents: [{ profile: "reviewer", task: "Review auth" }] },
        undefined,
        undefined,
        unavailableContext,
      );
    expect(preflights).toBe(1);
    expect(skipped?.details).toMatchObject({
      startFailures: [{ code: "profile_no_eligible_model" }],
    });
    expect(JSON.stringify(skipped)).not.toContain(environmentKey);
  });

  it("discovers and falls back past hard-incompatible Pi effort candidates", async () => {
    const requests: StartSubagentRequest[] = [];
    const profiles = profileServiceFor({
      profiles: {
        worker: [
          {
            host: "local",
            runtime: "pi",
            model: "zai/no-reasoning",
            effort: "high",
            context: "fresh",
            writeIntent: "writer",
          },
          {
            host: "local",
            runtime: "pi",
            model: "openai/reasoning",
            effort: "high",
            context: "fresh",
            writeIntent: "writer",
          },
        ],
      },
    });
    const ctx = registryContext([
      { provider: "zai", id: "no-reasoning", name: "No reasoning", reasoning: false },
      { provider: "openai", id: "reasoning", name: "Reasoning", reasoning: true },
    ]);
    const tools = captureSubagentTools(startCapturingService(requests), ["read"], profiles);
    const discovery = await tools
      .get("subagent_models")
      ?.execute("call", { profile: "worker" }, undefined, undefined, ctx);
    expect(discovery?.content[0]?.text).toContain("does not support required effort high");
    const started = await tools.get("subagent_start")?.execute(
      "call",
      {
        agents: [{ profile: "worker", task: "Work" }],
      },
      undefined,
      undefined,
      ctx,
    );
    expect(started?.details).not.toHaveProperty("startFailures");
    expect(requests[0]).toMatchObject({
      model: "openai/reasoning",
      selection: {
        candidateIndex: 1,
        skippedCandidates: [{ candidateIndex: 0, code: "pi_effort_unsupported" }],
      },
    });
  });

  it("marks oracle routing unavailable when the parent cannot be forked", async () => {
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const ephemeral = extensionContextFixture({
      ...context,
      sessionManager: {
        ...context.sessionManager,
        getSessionFile: () => undefined,
        getLeafEntry: () => undefined,
      },
    });
    const models = await captureSubagentTools(startCapturingService([]))
      .get("subagent_models")
      ?.execute("call", { profile: "oracle" }, undefined, undefined, ephemeral);
    const text = models?.content[0]?.text ?? "";
    expect(text).toContain("oracle —");
    expect(text).toContain(
      "source=builtin · defaults: context=fork · intent=read-only · effort=high",
    );
    expect(text).toContain(
      "local/pi/parent:default:fork:read-only:fastMode=false:closeOnReport=true · skipped",
    );
    expect(text).toContain("Forked context requires a persisted parent session");
  });

  it("states that complete context and capability choices come from v4 candidates", async () => {
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const ephemeral = extensionContextFixture({
      ...context,
      sessionManager: {
        ...context.sessionManager,
        getSessionFile: () => undefined,
        getLeafEntry: () => undefined,
      },
    });
    const models = await captureSubagentTools(startCapturingService([]))
      .get("subagent_models")
      ?.execute("call", { profile: "oracle" }, undefined, undefined, ephemeral);
    const text = models?.content[0]?.text ?? "";
    expect(text).toContain(
      "Each candidate lists host/runtime/model, effort, context, write intent, fast mode, and retention.",
    );
    expect(text).toContain("Forked context requires a persisted parent session");
  });

  it("renders explicitly repeated parent candidates in declared order", async () => {
    const profiles = profileServiceFor({
      profiles: {
        generalist: [
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
            effort: "high",
            context: "fresh",
            writeIntent: "read-only",
          },
        ],
      },
    });
    const models = await captureSubagentTools(startCapturingService([]), ["read"], profiles)
      .get("subagent_models")
      ?.execute("call", { profile: "generalist" }, undefined, undefined, context);
    const text = models?.content[0]?.text ?? "";
    expect(text).toContain(
      "1. local/pi/parent:default:fresh:read-only:fastMode=false:closeOnReport=true · eligible",
    );
    expect(text).toContain(
      "2. local/pi/parent:high:fresh:read-only:fastMode=false:closeOnReport=true · eligible",
    );
    expect(
      text.match(
        /Candidate adapter is statically eligible before native authentication\/integration\/harness readiness\./g,
      ),
    ).toHaveLength(2);
    expect(text).not.toContain("Profile generalist selected");
    expect(text).not.toContain("Profile generalist selected");
  });

  it("renders parent_model_missing skips when no parent model is active", async () => {
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const noParent = extensionContextFixture({
      ...context,
      model: undefined,
    });
    const models = await captureSubagentTools(startCapturingService([]))
      .get("subagent_models")
      ?.execute("call", { profile: "generalist" }, undefined, undefined, noParent);
    const text = models?.content[0]?.text ?? "";
    expect(text).toContain(
      "local/pi/parent:default:fresh:read-only:fastMode=false:closeOnReport=true · skipped",
    );
    expect(text).toContain("No active parent model is available.");
  });
});
