// Owned routing policy and its host classifier boundary; provider protocols stay out of scope.
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { extensionContextFixture } from "pi-cosmic-core/testing";
import { makeSubagentBackendRegistry, SubagentBackendRegistry } from "../../src/backend/service.ts";
import type { BackendDriver } from "../../src/backend/model.ts";
import {
  AUTOMATIC_ROUTING_TASK_CHARS,
  automaticRoutingChoices,
  automaticRoutingContext,
  automaticRoutingReason,
  decideAutomaticRouting,
  preferredJevClassifier,
} from "../../src/profiles/automatic-selection.ts";
import { SubagentProfileService } from "../../src/profiles/service.ts";
import type { StartSubagentRequest } from "../../src/run/model.ts";
import { SubagentService } from "../../src/run/service.ts";
import { executeSubagentActionEffect } from "../../src/tools/execute.ts";
import { executeStartBatch } from "../../src/tools/execute-start.ts";
import type { SubagentStartOutcome } from "../../src/tools/model.ts";
import {
  decodeSubagentProxyResult,
  encodeSubagentProxyPayload,
} from "../../src/tools/proxy-protocol.ts";
import type { SubagentStartSpec } from "../../src/tools/schema.ts";
import { declaredCandidate } from "../fixtures/profiles.ts";
import { extensionApiFixture } from "../fixtures/pi-host.ts";
import { subagentServiceDouble } from "./fixtures/subagent-service-double.ts";
import {
  captureSubagentTools,
  context,
  executeTool,
  profileServiceFor,
  view,
} from "./fixtures/tool-harness.ts";

const claude = (writeIntent: "read-only" | "writer" = "read-only") =>
  declaredCandidate("sonnet", { runtime: "claude", writeIntent });

const routedProfiles = (automaticProfileRouting?: boolean) =>
  profileServiceFor({
    ...(automaticProfileRouting !== undefined && { automaticProfileRouting }),
    profiles: {
      scout: [claude()],
      reviewer: [claude()],
      planner: [claude(), claude("writer")],
      researcher: "disabled",
      worker: [claude("writer")],
      generalist: [claude()],
    },
  });

const driver: BackendDriver = {
  host: "local",
  runtime: "claude",
  capabilities: [],
  supportsContext: (mode) => mode === "fresh",
  preflight: () => Effect.void,
  spawn: () => Effect.die("Launch admission is the owned service double."),
};
const registry = makeSubagentBackendRegistry([driver]);
const pi = extensionApiFixture({ getThinkingLevel: () => "high", getActiveTools: () => ["read"] });
const environment = { cwd: "/project", projectTrusted: true };

interface CatalogModel {
  readonly type: "classifier";
  readonly provider: string;
  readonly id: string;
  readonly api: string;
}
const jev: CatalogModel = { type: "classifier", provider: "acme", id: "jev-2", api: "acme-api" };

interface FakeAnswer {
  readonly choice: string;
  readonly confidence: number;
}
const result = (model: CatalogModel, answer: FakeAnswer) => ({
  api: model.api,
  provider: model.provider,
  model: model.id,
  timestamp: 1,
  stopReason: "stop",
  answers: {
    profile: {
      type: "choice",
      choice: answer.choice,
      probabilities: {},
      confidence: answer.confidence,
    },
  },
  usage: {
    input: 3,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 4,
    cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
  },
});

interface FakeRegistry {
  readonly getAvailableOfType?: () => Promise<ReadonlyArray<CatalogModel>>;
  readonly classify?: (
    model: CatalogModel,
    request: { readonly state: { readonly task?: string } },
    options?: { readonly signal?: AbortSignal },
  ) => Promise<ReturnType<typeof result>>;
}

/** The root tool context with a fake authenticated classifier catalog and classify call. */
const classifierContext = (registry: FakeRegistry) =>
  extensionContextFixture({
    ...context,
    modelRegistry: { ...context.modelRegistry, ...registry },
  });

const runBatch = (
  agents: ReadonlyArray<SubagentStartSpec>,
  registryFixture: FakeRegistry,
  options: { readonly readOnly?: boolean; readonly automaticProfileRouting?: boolean } = {},
) => {
  const requests: StartSubagentRequest[] = [];
  const batch = executeStartBatch({
    agents,
    pi,
    ctx: classifierContext(registryFixture),
    environment,
    startOwned: (request) =>
      Effect.sync(() => {
        requests.push(request);
        return view({
          id: `agent-${requests.length}`,
          profile: request.profile,
          runtime: request.runtime,
        });
      }),
    onUpdate: undefined,
    ...(options.readOnly !== undefined && { readOnly: options.readOnly }),
  }).pipe(
    Effect.provideService(SubagentProfileService, routedProfiles(options.automaticProfileRouting)),
    Effect.provideService(SubagentBackendRegistry, registry),
  );
  return { requests, batch };
};

const failureCodes = (outcomes: ReadonlyArray<SubagentStartOutcome>) =>
  outcomes.map((outcome) => ("failure" in outcome ? outcome.failure.code : undefined));

describe("automatic routing policy", () => {
  it("offers only profiles whose complete route plans read-only work", () => {
    const snapshot = Effect.runSync(routedProfiles().capture);
    expect(
      automaticRoutingChoices(snapshot.effectiveConfig, {
        availablePiModels: [],
        forkAvailable: false,
      }),
    ).toEqual(["scout", "reviewer", "generalist"]);
  });

  it("bounds classifier input to a task excerpt, a short name, and offered profiles", () => {
    const routed = automaticRoutingContext(
      { task: `  ${"x".repeat(AUTOMATIC_ROUTING_TASK_CHARS + 50)}  `, name: "n".repeat(500) },
      ["scout", "reviewer"],
    );
    expect(Object.keys(routed.state).sort()).toEqual(["name", "task", "taskTruncated"]);
    expect(String(routed.state.task)).toHaveLength(AUTOMATIC_ROUTING_TASK_CHARS);
    expect(String(routed.state.name).length).toBeLessThan(100);
    expect(Object.keys(routed.questions.profile?.criteria ?? {})).toEqual([
      "scout",
      "reviewer",
      "main",
    ]);
  });

  it("trusts only stopped, offered, in-range answers at or above the confidence gate", () => {
    const decide = (answer: FakeAnswer | undefined, stopped = true) =>
      decideAutomaticRouting({ stopped, answer }, ["scout", "reviewer"]);
    expect(decide({ choice: "reviewer", confidence: 0.9 })).toEqual({
      kind: "selected",
      profile: "reviewer",
      confidence: 0.9,
    });
    const declined = (answer: FakeAnswer | undefined, stopped = true) => {
      const decision = decide(answer, stopped);
      return decision.kind === "declined" ? decision.failure.code : decision.profile;
    };
    expect(declined({ choice: "reviewer", confidence: 0.899 })).toBe(
      "automatic_routing_low_confidence",
    );
    expect(declined({ choice: "main", confidence: 1 })).toBe("automatic_routing_handback");
    expect(declined({ choice: "worker", confidence: 1 })).toBe("automatic_routing_invalid_answer");
    for (const confidence of [Number.NaN, Number.POSITIVE_INFINITY, 1.01, -0.1])
      expect(declined({ choice: "reviewer", confidence })).toBe("automatic_routing_invalid_answer");
    expect(declined(undefined)).toBe("automatic_routing_invalid_answer");
    expect(declined({ choice: "reviewer", confidence: 1 }, false)).toBe("automatic_routing_failed");
  });

  it("prefers native Jev, then authenticated Jev elsewhere, and never arbitrary classifiers", () => {
    const entry = (provider: string, id: string, api = `${provider}-api`) => ({
      entry: { provider, id, api },
    });
    const pick = (...entries: ReadonlyArray<ReturnType<typeof entry>>) =>
      preferredJevClassifier(entries)?.entry;
    const local = entry("local", "jev-latest", "llama-cpp-classify");
    const lookalike = entry("typesafe", "jevons");
    const other = entry("acme", "jev2-mini");
    const native = entry("typesafe", "jev-latest");
    expect(pick(local, lookalike, other, native)).toEqual(native.entry);
    expect(pick(local, lookalike, other)).toEqual(other.entry);
    expect(pick(local, lookalike, entry("acme", "classifier"))).toBeUndefined();
  });

  it("keeps routing provenance within the persisted reason bound", () => {
    const reason = automaticRoutingReason("acme/jev-2", "reviewer", 0.97, "r".repeat(5_000));
    expect(reason.length).toBeLessThanOrEqual(1_024);
    expect(reason).toMatch(/acme\/jev-2.*reviewer.*97%/u);
  });
});

describe("automatic routing at the start boundary", () => {
  it.effect("routes omitted profiles once per batch and leaves explicit siblings alone", () =>
    Effect.gen(function* () {
      let lookups = 0;
      const tasks: Array<string | undefined> = [];
      const { requests, batch } = runBatch(
        [
          { task: "Evaluate the parser change", name: "parser" },
          { task: "Evaluate the lexer change" },
          { task: "Map the parser", profile: "scout" },
          { task: "Implement the parser", writes: ["src/parser.ts"] },
        ],
        {
          getAvailableOfType: () => {
            lookups += 1;
            return Promise.resolve([jev]);
          },
          classify: (model, request) => {
            tasks.push(request.state.task);
            return Promise.resolve(result(model, { choice: "reviewer", confidence: 0.97 }));
          },
        },
      );
      const settled = yield* batch;
      expect(lookups).toBe(1);
      expect(tasks.sort()).toEqual(["Evaluate the lexer change", "Evaluate the parser change"]);
      expect(requests.map((request) => request.profile).sort()).toEqual([
        "reviewer",
        "reviewer",
        "scout",
      ]);
      expect(
        requests.find((request) => request.task === "Evaluate the parser change")?.selection
          ?.reason,
      ).toMatch(/acme\/jev-2.*reviewer.*97%/u);
      // Writes keep the legacy generalist path, which has no writer candidate here.
      expect(failureCodes(settled.startOutcomes).slice(0, 3)).toEqual([
        undefined,
        undefined,
        undefined,
      ]);
      expect(settled.startOutcomes[3]).toHaveProperty("failure");
      expect(settled.classifierUsage?.totalTokens).toBe(8);
    }),
  );

  it.effect("makes no lookup when routing is off and keeps the generalist fallback", () =>
    Effect.gen(function* () {
      let lookups = 0;
      const { requests, batch } = runBatch(
        [{ task: "Summarize the change" }],
        {
          getAvailableOfType: () => {
            lookups += 1;
            return Promise.resolve([jev]);
          },
        },
        { automaticProfileRouting: false },
      );
      yield* batch;
      expect(lookups).toBe(0);
      expect(requests.map((request) => request.profile)).toEqual(["generalist"]);
    }),
  );

  it.effect("treats missing, hostile, or failing catalogs as unavailable", () =>
    Effect.gen(function* () {
      const throwing: FakeRegistry = {
        getAvailableOfType: () => {
          throw new Error("catalog exploded");
        },
        classify: () => Promise.reject(new Error("unreachable")),
      };
      for (const registryFixture of [
        {},
        { getAvailableOfType: () => Promise.resolve([jev]) },
        throwing,
        { ...throwing, getAvailableOfType: () => Promise.reject(new Error("auth")) },
        { ...throwing, getAvailableOfType: () => Promise.resolve([]) },
      ] satisfies ReadonlyArray<FakeRegistry>) {
        const { requests, batch } = runBatch([{ task: "Summarize the change" }], registryFixture);
        const settled = yield* batch;
        expect(requests.map((request) => request.profile)).toEqual(["generalist"]);
        expect(settled.classifierUsage).toBeUndefined();
      }
    }),
  );

  it.effect("falls back to generalist when the lookup outlives its bound", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const { requests, batch } = runBatch([{ task: "Summarize the change" }], {
        getAvailableOfType: () => {
          Deferred.doneUnsafe(entered, Effect.void);
          // Ignores its signal and never settles, like a misbehaving host.
          return Effect.runPromise(Effect.never);
        },
        classify: () => Promise.reject(new Error("unreachable")),
      });
      const running = yield* batch.pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      yield* TestClock.adjust("5 seconds");
      yield* Fiber.join(running);
      expect(requests.map((request) => request.profile)).toEqual(["generalist"]);
    }),
  );

  it.effect("fails only a slot whose classification times out, with an aborted signal", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      let aborted = false;
      const { requests, batch } = runBatch(
        [{ task: "Evaluate the parser change" }, { task: "Map the parser", profile: "scout" }],
        {
          getAvailableOfType: () => Promise.resolve([jev]),
          classify: (_model, _request, options) => {
            options?.signal?.addEventListener("abort", () => {
              aborted = true;
            });
            Deferred.doneUnsafe(entered, Effect.void);
            return Effect.runPromise(Effect.never);
          },
        },
      );
      const running = yield* batch.pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      yield* TestClock.adjust("15 seconds");
      const settled = yield* Fiber.join(running);
      expect(aborted).toBe(true);
      expect(failureCodes(settled.startOutcomes)).toEqual(["automatic_routing_timeout", undefined]);
      expect(requests.map((request) => request.profile)).toEqual(["scout"]);
    }),
  );

  it.effect("fails routed slots on hostile classifier calls and responses", () =>
    Effect.gen(function* () {
      const responses: ReadonlyArray<NonNullable<FakeRegistry["classify"]>> = [
        () => {
          throw new Error("provider-secret");
        },
        () => Promise.reject(new Error("provider-secret")),
        // SAFETY: A hostile host may return a non-Promise; the boundary must contain it.
        () => "not a promise" as never,
        (model) =>
          Promise.resolve({
            ...result(model, { choice: "reviewer", confidence: 1 }),
            stopReason: "aborted",
          }),
        (model) =>
          Promise.resolve(
            Object.defineProperty(result(model, { choice: "reviewer", confidence: 1 }), "answers", {
              get: () => {
                throw new Error("provider-secret");
              },
            }),
          ),
      ];
      for (const classify of responses) {
        const { requests, batch } = runBatch([{ task: "Evaluate the parser change" }], {
          getAvailableOfType: () => Promise.resolve([jev]),
          classify,
        });
        const settled = yield* batch;
        expect(requests).toEqual([]);
        expect(settled.startFailures[0]?.code).toMatch(/^automatic_routing_/u);
        expect(settled.startFailures[0]?.message).not.toContain("provider-secret");
      }
    }),
  );

  it.live("runs at most four classifications at once", () =>
    Effect.gen(function* () {
      let active = 0;
      let peak = 0;
      const gate = yield* Deferred.make<void>();
      const { requests, batch } = runBatch(
        Array.from({ length: 6 }, (_, index) => ({ task: `Evaluate change ${index}` })),
        {
          getAvailableOfType: () => Promise.resolve([jev]),
          classify: (model) => {
            active += 1;
            peak = Math.max(peak, active);
            return Effect.runPromise(Deferred.await(gate)).then(() => {
              active -= 1;
              return result(model, { choice: "reviewer", confidence: 0.95 });
            });
          },
        },
      );
      const running = yield* batch.pipe(Effect.forkChild);
      for (let attempt = 0; attempt < 200 && active < 4; attempt += 1)
        yield* Effect.sleep("5 millis");
      yield* Effect.sleep("20 millis");
      expect(active).toBe(4);
      yield* Deferred.succeed(gate, undefined);
      yield* Fiber.join(running);
      expect(peak).toBe(4);
      expect(requests.map((request) => request.profile)).toEqual(Array(6).fill("reviewer"));
    }),
  );
});

describe("automatic routing callers", () => {
  it.effect("reports root classifier usage on a model-issued start result", () =>
    Effect.gen(function* () {
      const requests: StartSubagentRequest[] = [];
      const service = subagentServiceDouble({
        start: (request) =>
          Effect.sync(() => {
            requests.push(request);
            return view({ profile: request.profile, runtime: request.runtime });
          }),
      });
      const tool = captureSubagentTools(service, {
        profiles: routedProfiles(),
        registry,
      }).get("subagent_start");
      const ctx = classifierContext({
        getAvailableOfType: () => Promise.resolve([jev]),
        classify: (model) =>
          Promise.resolve(result(model, { choice: "reviewer", confidence: 0.95 })),
      });
      const started = yield* Effect.promise(() =>
        executeTool(tool!, { agents: [{ task: "Evaluate the parser change" }] }, { context: ctx }),
      );
      expect(requests.map((request) => request.profile)).toEqual(["reviewer"]);
      expect(started.usage?.totalTokens).toBe(4);
    }),
  );

  it.effect("routes an authenticated child's proxied start with the root classifier", () =>
    Effect.gen(function* () {
      const callers: Array<readonly [string, string | undefined]> = [];
      const service = subagentServiceDouble({
        startSessionOwnedFrom: (callerRunId, request) =>
          Effect.sync(() => {
            callers.push([callerRunId, request.profile]);
            return view({ profile: request.profile, runtime: request.runtime });
          }),
      });
      const proxied = yield* executeSubagentActionEffect(
        pi,
        environment,
        { tool: "subagent_start", args: { agents: [{ task: "Evaluate the parser change" }] } },
        undefined,
        classifierContext({
          getAvailableOfType: () => Promise.resolve([jev]),
          classify: (model) =>
            Promise.resolve(result(model, { choice: "reviewer", confidence: 0.95 })),
        }),
        "caller-run",
      ).pipe(
        Effect.provideService(SubagentService, service),
        Effect.provideService(SubagentProfileService, routedProfiles()),
        Effect.provideService(SubagentBackendRegistry, registry),
      );
      expect(callers).toEqual([["caller-run", "reviewer"]]);
      // The strict private proxy result is unchanged: no usage field crosses to the child.
      expect(proxied.usage).toBeUndefined();
      expect(decodeSubagentProxyResult(encodeSubagentProxyPayload(proxied) ?? "")).toBeDefined();
    }),
  );
});
