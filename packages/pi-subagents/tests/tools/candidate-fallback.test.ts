import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { assert, describe, expect, it } from "@effect/vitest";
import { issueMessageStyleProblems, renderContextFixture } from "pi-code-previews/testing";
import * as Arr from "effect/Array";
import type * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Str from "effect/String";
import * as TestClock from "effect/testing/TestClock";
import {
  extensionApiFixture,
  extensionContextFixture,
  modelFixture,
  yieldUntil,
} from "pi-cosmic-core/testing";
import type { BackendDriver, BackendEvent, BackendHandle } from "../../src/backend/model.ts";
import {
  SubagentBackendRegistry,
  type SubagentBackendRegistryContract,
} from "../../src/backend/service.ts";
import type { SubagentRuntime } from "../../src/domain/routing.ts";
import { InvalidSubagentRequestError, SubagentProcessError } from "../../src/run/errors.ts";
import type { SubagentNotification } from "../../src/boundary/host-notifier.ts";
import type { SubagentProfileServiceContract } from "../../src/profiles/service.ts";
import { SubagentProfileService } from "../../src/profiles/service.ts";
import { SubagentService, type SubagentServiceContract } from "../../src/run/service.ts";
import { createSubagentCompactSummary } from "../../src/tools/compact-summary.ts";
import { SubagentStartDetailsSchema } from "../../src/tools/details-schema.ts";
import { executeSubagentActionEffect } from "../../src/tools/execute.ts";
import type { SubagentStartSpec } from "../../src/tools/schema.ts";
import { declaredCandidate } from "../fixtures/profiles.ts";
import {
  acknowledgeCompletions,
  fakeChildLayer,
  fakeWriterLeaseLayer,
  leaseCounts,
  localServiceFixture,
  profileLayerFor,
  runViews,
  withService,
  type FakeChildControl,
} from "../run/fixtures/service-harness.ts";
import {
  profileServiceFor,
  testBackendDriver,
  testBackendRegistry,
} from "./fixtures/tool-harness.ts";

// The fake Pi child always reports this model, so a route candidate naming another one fails
// its startup with a model mismatch before the task is issued.
const REPORTED = "openai-codex/gpt-5.6-sol";
const LUNA = "openai-codex/gpt-6-luna";
const NOVA = "openai-codex/gpt-6-nova";
const TERRA = "openai-codex/gpt-6-terra";

const registryModels = Arr.map([REPORTED, LUNA, NOVA, TERRA], (selector) => {
  const [provider, id = ""] = Str.split(selector, "/");
  return modelFixture({ provider, id, name: id, reasoning: true });
});

const ctx = extensionContextFixture({
  cwd: "/project",
  modelRegistry: {
    find: (provider, id) =>
      Option.getOrUndefined(
        Arr.findFirst(registryModels, (model) => model.provider === provider && model.id === id),
      ),
    hasConfiguredAuth: () => true,
    getProviderAuthStatus: () => ({ configured: true, source: "stored" }),
    getRegisteredProviderIds: () => [],
    getAvailable: () => registryModels,
  },
});

const pi = extensionApiFixture({ getThinkingLevel: () => "high", getActiveTools: () => ["read"] });

const environment = {
  cwd: "/project",
  projectTrusted: true,
  parentContext: {
    sessionId: "parent-session",
    sessionFile: "/sessions/parent.jsonl",
    leafId: "user-1",
    model: REPORTED,
    effort: "high",
  },
} as const;

const routed = (models: ReadonlyArray<string>, writeIntent = "read-only") =>
  Arr.map(models, (model) => declaredCandidate(model, { effort: "default", writeIntent }));

const routeProfiles = (models: ReadonlyArray<string>) =>
  profileServiceFor({ profiles: { generalist: routed(models), worker: routed(models, "writer") } });

const start = (
  service: SubagentServiceContract,
  profiles: SubagentProfileServiceContract,
  agents: ReadonlyArray<SubagentStartSpec>,
  hostBackends: SubagentBackendRegistryContract = testBackendRegistry,
  api = pi,
) =>
  executeSubagentActionEffect(
    api,
    environment,
    { tool: "agent_start", args: { agents: [...agents] } },
    undefined,
    ctx,
  ).pipe(
    Effect.provideService(SubagentService, service),
    Effect.provideService(SubagentProfileService, profiles),
    Effect.provideService(SubagentBackendRegistry, hostBackends),
  );

const resolveAnyRuntime: SubagentBackendRegistryContract["resolve"] = ({ runtime }) =>
  Effect.succeed({ ...testBackendDriver, runtime });

/**
 * The host's readiness probes for every runtime. Each probe is recorded by model, then may wait on
 * a gate or fail with a code.
 */
const hostBackends = (
  options: {
    readonly gates?: Readonly<Record<string, Deferred.Deferred<void>>>;
    readonly failures?: Readonly<Record<string, string>>;
  } = {},
) => {
  const probed: string[] = [];
  const registry: SubagentBackendRegistryContract = {
    resolve: resolveAnyRuntime,
    preflight: (selection, probe) =>
      Effect.gen(function* () {
        probed.push(probe.model);
        const gate = options.gates?.[probe.model];
        if (gate) yield* Deferred.await(gate);
        const code = options.failures?.[probe.model];
        if (code)
          return yield* InvalidSubagentRequestError.make({
            code,
            message: `Fixture probe for ${probe.model} failed.`,
          });
        return yield* resolveAnyRuntime(selection);
      }),
  };
  return { registry, probed };
};

const NATIVE_CAPABILITIES = ["steer", "interrupt", "parent-contact"] as const;

/**
 * A Claude or Codex driver whose initialization fails with a code for some models, and whose
 * service-side preflight may fail too. Each spawn records its model and how many run-state reclaims
 * preceded it.
 */
const fakeNativeDriver = (
  runtime: Exclude<SubagentRuntime, "pi">,
  options: {
    readonly initializeFailures?: Readonly<Record<string, string>>;
    readonly preflightFailures?: Readonly<Record<string, string>>;
    readonly reclaimed?: () => number;
  } = {},
) => {
  const spawns: Array<{ readonly model: string; readonly reclaimedBefore: number }> = [];
  const driver: BackendDriver = {
    runtime,
    capabilities: NATIVE_CAPABILITIES,
    supportsContext: (context) => context === "fresh",
    preflight: ({ model }) => {
      const code = options.preflightFailures?.[model];
      return code
        ? Effect.fail(
            InvalidSubagentRequestError.make({
              code,
              message: `Fixture ${runtime} preflight failed for ${model}.`,
            }),
          )
        : Effect.void;
    },
    spawn: (launch) =>
      Effect.acquireRelease(
        Effect.gen(function* () {
          spawns.push({ model: launch.model, reclaimedBefore: options.reclaimed?.() ?? 0 });
          const events = yield* Queue.unbounded<BackendEvent, Cause.Done>();
          const failure = options.initializeFailures?.[launch.model];
          const handle: BackendHandle = {
            events,
            awaitExit: Effect.never,
            controls: {
              initialize: failure
                ? Effect.fail(
                    SubagentProcessError.make({
                      operation: "initialize",
                      code: failure,
                      message: `Fixture ${runtime} failed to start ${launch.model}.`,
                    }),
                  )
                : Effect.succeed({
                    model: launch.model,
                    effort: launch.effort,
                    sessionId: `${runtime}-session`,
                  }),
              start: () => Effect.void,
              steer: () => Effect.void,
              interrupt: Effect.void,
              reply: () => Effect.void,
              notifyPeers: () => Effect.void,
            },
            acknowledge: () => {},
            terminate: () => Effect.void,
            cancelPending: () => {},
          };
          return { handle, events };
        }),
        ({ events }) => Effect.sync(() => Queue.endUnsafe(events)),
      ).pipe(Effect.map(({ handle }) => handle)),
  };
  return { driver, spawns };
};

const nativeCandidate = (runtime: Exclude<SubagentRuntime, "pi">, model: string) =>
  declaredCandidate(model, { runtime, effort: "default" });

const mixedProfiles = (candidates: ReadonlyArray<ReturnType<typeof declaredCandidate>>) =>
  profileServiceFor({ profiles: { generalist: [...candidates] } });

const decodeStartDetails = Schema.decodeUnknownSync(SubagentStartDetailsSchema);

const startIssueStyleProblems = (
  agents: ReadonlyArray<SubagentStartSpec>,
  result: AgentToolResult<unknown>,
  isError: boolean,
) =>
  Arr.flatMap(
    createSubagentCompactSummary("agent_start")({
      phase: "settled",
      args: { agents: [...agents] },
      result: { content: [{ type: "text", text: "" }], details: result.details },
      context: renderContextFixture({ isError }),
    })?.issues ?? [],
    // Quoted warnings and failures are clipped after their launch label.
    (issue) => issueMessageStyleProblems(issue.message, { maxLength: 160 }),
  );

const noticedRuns = (notifications: ReadonlyArray<SubagentNotification>) =>
  Arr.flatMap(notifications, (notification) =>
    notification.type === "completed" ? notification.runs : [],
  );

const override = (model: string) => ({ runtime: "pi", model }) as const;

describe("automatic candidate fallback before the task is issued", () => {
  it.effect("moves a failed startup to the next candidate in the same run, with a warning", () => {
    const releasedBeforeSpawn: Array<number | undefined> = [];
    let controls: ReadonlyArray<FakeChildControl> = [];
    const fake = fakeChildLayer(
      Effect.sync(() => void releasedBeforeSpawn.push(controls[0]?.released())),
    );
    controls = fake.controls;
    const { layer, notifications } = localServiceFixture({ notify: acknowledgeCompletions }, fake);
    return withService(layer, function* (service) {
      const agents = [{ task: "Map the auth flow" }];
      const result = yield* start(service, routeProfiles([LUNA, REPORTED, NOVA]), agents);
      expect(result.structuredContent).toMatchObject({ outcome: "started" });
      expect(startIssueStyleProblems(agents, result, false)).toEqual([]);
      const runs = yield* runViews(service);
      expect(runs).toHaveLength(1);
      const [run] = runs;
      assert(run !== undefined);
      expect(run).toMatchObject({ state: "running", model: REPORTED });
      expect(run.selection.skippedCandidates).toMatchObject([
        { candidate: { model: LUNA }, code: "pi_model_mismatch" },
      ]);
      // The warning names the failed candidate, in the run and in its start entry.
      expect(run.systemWarning).toContain(LUNA);
      const [entry] = decodeStartDetails(result.details).startEntries;
      assert(entry?.status === "started");
      expect(entry.warning).toContain(LUNA);
      // The failed candidate's process was gone before the next one spawned.
      expect(fake.controls).toHaveLength(2);
      expect(releasedBeforeSpawn[1]).toBe(1);
      expect(fake.controls[1]?.sent("prompt")).toBe(true);
      expect(fake.controls[0]?.sent("prompt")).toBe(false);

      yield* TestClock.adjust("1 second");
      expect(noticedRuns(notifications)).toEqual([]);
    });
  });

  it.effect("hands a writer's lease to the next candidate without releasing it", () => {
    const counts = leaseCounts();
    const { layer } = localServiceFixture(
      {},
      fakeChildLayer(),
      profileLayerFor({}),
      fakeWriterLeaseLayer({ counts }),
    );
    return withService(layer, function* (service) {
      yield* start(service, routeProfiles([LUNA, REPORTED]), [
        { task: "Fix the parser", profile: "worker" },
      ]);
      const [run] = yield* runViews(service);
      assert(run !== undefined);
      expect(run).toMatchObject({ state: "running", model: REPORTED, writeIntent: "writer" });
      // One lease, held from the first candidate's spawn through the second's: no other Pi
      // process could take the directory in between.
      expect(counts).toMatchObject({ acquire: 1, release: 0 });
      yield* service.stop(run.id);
      expect(counts).toMatchObject({ acquire: 1, release: 1 });
    });
  });

  it.effect("releases a writer's lease when no candidate takes the run", () => {
    const counts = leaseCounts();
    const { layer, fake } = localServiceFixture(
      {},
      fakeChildLayer(),
      profileLayerFor({}),
      fakeWriterLeaseLayer({ counts }),
    );
    return withService(layer, function* (service) {
      const result = yield* start(service, routeProfiles([LUNA, NOVA]), [
        { task: "Fix the parser", profile: "worker" },
      ]);
      expect(result.structuredContent).toMatchObject({ outcome: "failed" });
      expect(fake.controls).toHaveLength(2);
      expect(counts).toMatchObject({ acquire: 1, release: 1 });
      expect((yield* runViews(service))[0]?.cleanup?.disposition).toBe("confirmed");
    });
  });

  it.effect("keeps a failure that isn't the candidate's own", () => {
    const fake = fakeChildLayer(Effect.void, {
      initialFailures: [{ spawnIndex: 0, type: "get_state", error: "State unavailable." }],
    });
    const { layer } = localServiceFixture({ notify: acknowledgeCompletions }, fake);
    return withService(layer, function* (service) {
      const result = yield* start(service, routeProfiles([REPORTED, NOVA]), [
        { task: "Map the auth flow" },
      ]);
      expect(result.structuredContent).toMatchObject({ outcome: "failed" });
      expect(fake.controls).toHaveLength(1);
      const [run] = yield* runViews(service);
      expect(run).toMatchObject({ state: "failed", model: REPORTED });
      expect(run?.systemWarning).toBeUndefined();
    });
  });

  it.effect("never moves a run whose task was already issued", () => {
    const fake = fakeChildLayer(Effect.void, {
      initialFailures: [{ spawnIndex: 0, type: "prompt", error: "Prompt was rejected." }],
    });
    const { layer } = localServiceFixture({ notify: acknowledgeCompletions }, fake);
    return withService(layer, function* (service) {
      const result = yield* start(service, routeProfiles([REPORTED, NOVA]), [
        { task: "Map the auth flow" },
      ]);
      expect(result.structuredContent).toMatchObject({ outcome: "failed" });
      expect(fake.controls).toHaveLength(1);
      expect((yield* runViews(service))[0]?.state).toBe("failed");
    });
  });

  it.effect("reports one failure naming each candidate when every candidate fails", () => {
    const { layer, fake, notifications } = localServiceFixture({
      notify: acknowledgeCompletions,
    });
    return withService(layer, function* (service) {
      const agents = [{ task: "Map the auth flow" }];
      const result = yield* start(service, routeProfiles([LUNA, NOVA]), agents);
      expect(startIssueStyleProblems(agents, result, true)).toEqual([]);
      expect(fake.controls).toHaveLength(2);
      const runs = yield* runViews(service);
      expect(runs).toHaveLength(1);
      const [run] = runs;
      assert(run !== undefined);
      expect(run.state).toBe("failed");
      expect(run.error).toContain(LUNA);
      expect(run.error).toContain(NOVA);
      const details = decodeStartDetails(result.details);
      expect(details.startFailures).toHaveLength(1);
      const [failure] = details.startFailures ?? [];
      expect(failure).toMatchObject({
        code: "pi_model_mismatch",
        admittedRun: { runId: run.id, nextCandidate: "none" },
      });
      expect(failure?.message).toContain(LUNA);
      expect(failure?.message).toContain(NOVA);
      // The failed entry names the candidate the run last tried, not the one it started on.
      expect(details.startEntries[0]).toMatchObject({ status: "failed", model: NOVA });

      yield* TestClock.adjust("1 second");
      expect(noticedRuns(notifications)).toEqual([]);
    });
  });

  it.effect("stops moving on once the parent stops the run", () => {
    const gate = Deferred.makeUnsafe<void>();
    const fake = fakeChildLayer(Effect.void, {
      initialSendGates: [{ spawnIndex: 1, type: "get_state", gate }],
    });
    const { layer } = localServiceFixture({ notify: acknowledgeCompletions }, fake);
    return withService(layer, function* (service) {
      const call = yield* start(service, routeProfiles([LUNA, NOVA, REPORTED]), [
        { task: "Map the auth flow" },
      ]).pipe(Effect.forkChild);
      // The second candidate is starting when the parent stops the run.
      yield* yieldUntil(() => fake.controls[1]?.sent("get_state") === true);
      const [run] = yield* runViews(service);
      assert(run !== undefined);
      yield* service.stop(run.id);
      const result = yield* Fiber.join(call);
      expect(result.structuredContent).toMatchObject({ outcome: "failed" });
      expect(fake.controls).toHaveLength(2);
      expect((yield* runViews(service))[0]?.state).toBe("stopped");
    });
  });
});

describe("model override continuation", () => {
  it.effect("names the route candidate after the override, walking the route", () => {
    const { layer, fake } = localServiceFixture({ notify: acknowledgeCompletions });
    const profiles = routeProfiles([LUNA, NOVA, REPORTED]);
    const nextAfter = (model: string) =>
      withService(layer, function* (service) {
        const result = yield* start(service, profiles, [
          { task: "Map the auth flow", model: override(model) },
        ]);
        return decodeStartDetails(result.details).startFailures?.[0]?.admittedRun?.nextCandidate;
      });
    return Effect.gen(function* () {
      expect(yield* nextAfter(LUNA)).toMatchObject({ runtime: "pi", model: NOVA });
      expect(yield* nextAfter(NOVA)).toMatchObject({ runtime: "pi", model: REPORTED });
      // An override outside the route keeps a route of itself alone.
      expect(yield* nextAfter(TERRA)).toBe("none");
      // An override never falls back: each launch spawned only its own candidate.
      expect(fake.controls).toHaveLength(3);
    });
  });
});

describe("startup failure scope", () => {
  it.effect("moves a Claude candidate failure to the next Claude candidate", () => {
    const claude = fakeNativeDriver("claude", {
      initializeFailures: { opus: "claude_model_mismatch" },
    });
    const { layer } = localServiceFixture(
      { notify: acknowledgeCompletions },
      fakeChildLayer(),
      profileLayerFor({}),
      fakeWriterLeaseLayer(),
      [claude.driver],
    );
    return withService(layer, function* (service) {
      const host = hostBackends();
      const result = yield* start(
        service,
        mixedProfiles([nativeCandidate("claude", "opus"), nativeCandidate("claude", "sonnet")]),
        [{ task: "Map the auth flow" }],
        host.registry,
      );
      expect(result.structuredContent).toMatchObject({ outcome: "started" });
      expect(Arr.map(claude.spawns, ({ model }) => model)).toEqual(["opus", "sonnet"]);
      const [run] = yield* runViews(service);
      expect(run).toMatchObject({ state: "running", runtime: "claude", model: "sonnet" });
      expect(run?.selection.skippedCandidates).toMatchObject([
        { candidate: { model: "opus" }, code: "claude_model_mismatch" },
      ]);
    });
  });

  it.effect("moves a Codex candidate failure to the next Codex candidate", () => {
    const codex = fakeNativeDriver("codex", {
      initializeFailures: { "gpt-a": "codex_service_tier_mismatch" },
    });
    const { layer } = localServiceFixture(
      { notify: acknowledgeCompletions },
      fakeChildLayer(),
      profileLayerFor({}),
      fakeWriterLeaseLayer(),
      [codex.driver],
    );
    return withService(layer, function* (service) {
      const result = yield* start(
        service,
        mixedProfiles([nativeCandidate("codex", "gpt-a"), nativeCandidate("codex", "gpt-b")]),
        [{ task: "Map the auth flow" }],
        hostBackends().registry,
      );
      expect(result.structuredContent).toMatchObject({ outcome: "started" });
      expect(Arr.map(codex.spawns, ({ model }) => model)).toEqual(["gpt-a", "gpt-b"]);
      expect((yield* runViews(service))[0]).toMatchObject({ runtime: "codex", model: "gpt-b" });
    });
  });

  it.effect("passes over a failed runtime's other candidates without probing them", () => {
    const claude = fakeNativeDriver("claude", {
      initializeFailures: { opus: "claude_native_init_missing" },
    });
    const codex = fakeNativeDriver("codex", {
      initializeFailures: { "gpt-a": "local_codex_exited" },
    });
    const { layer, fake } = localServiceFixture(
      { notify: acknowledgeCompletions },
      fakeChildLayer(),
      profileLayerFor({}),
      fakeWriterLeaseLayer(),
      [claude.driver, codex.driver],
    );
    return withService(layer, function* (service) {
      const host = hostBackends();
      const result = yield* start(
        service,
        mixedProfiles([
          nativeCandidate("claude", "opus"),
          nativeCandidate("codex", "gpt-a"),
          nativeCandidate("claude", "sonnet"),
          nativeCandidate("codex", "gpt-b"),
          declaredCandidate(REPORTED, { effort: "default" }),
        ]),
        [{ task: "Map the auth flow" }],
        host.registry,
      );
      expect(result.structuredContent).toMatchObject({ outcome: "started" });
      expect(Arr.map(claude.spawns, ({ model }) => model)).toEqual(["opus"]);
      expect(Arr.map(codex.spawns, ({ model }) => model)).toEqual(["gpt-a"]);
      expect(host.probed).not.toContain("sonnet");
      expect(host.probed).not.toContain("gpt-b");
      expect(fake.controls).toHaveLength(1);
      const [run] = yield* runViews(service);
      expect(run).toMatchObject({ state: "running", runtime: "pi", model: REPORTED });
      expect(run?.selection.skippedCandidates).toMatchObject([
        { candidate: { model: "opus" }, code: "claude_native_init_missing" },
        { candidate: { model: "gpt-a" }, code: "local_codex_exited" },
        { candidate: { model: "sonnet" }, code: "runtime_startup_failed" },
        { candidate: { model: "gpt-b" }, code: "runtime_startup_failed" },
      ]);
    });
  });

  it.effect("never moves past an attempt whose outcome is uncertain", () => {
    const claude = fakeNativeDriver("claude", {
      initializeFailures: { opus: "initialize_outcome_uncertain" },
    });
    const { layer } = localServiceFixture(
      { notify: acknowledgeCompletions },
      fakeChildLayer(),
      profileLayerFor({}),
      fakeWriterLeaseLayer(),
      [claude.driver],
    );
    return withService(layer, function* (service) {
      const result = yield* start(
        service,
        mixedProfiles([nativeCandidate("claude", "opus"), nativeCandidate("claude", "sonnet")]),
        [{ task: "Map the auth flow" }],
        hostBackends().registry,
      );
      expect(result.structuredContent).toMatchObject({ outcome: "failed" });
      expect(Arr.map(claude.spawns, ({ model }) => model)).toEqual(["opus"]);
      expect(decodeStartDetails(result.details).startFailures?.[0]).toMatchObject({
        code: "initialize_outcome_uncertain",
      });
    });
  });
});

describe("startup fallback stops", () => {
  it.effect("ends the chain at a host probe whose cleanup is unconfirmed", () => {
    const claude = fakeNativeDriver("claude");
    const { layer, fake } = localServiceFixture(
      { notify: acknowledgeCompletions },
      fakeChildLayer(),
      profileLayerFor({}),
      fakeWriterLeaseLayer(),
      [claude.driver],
    );
    return withService(layer, function* (service) {
      const host = hostBackends({ failures: { sonnet: "claude_preflight_cleanup_unconfirmed" } });
      const result = yield* start(
        service,
        mixedProfiles([
          declaredCandidate(LUNA, { effort: "default" }),
          nativeCandidate("claude", "sonnet"),
          declaredCandidate(REPORTED, { effort: "default" }),
        ]),
        [{ task: "Map the auth flow" }],
        host.registry,
      );
      // No later candidate is probed or started.
      expect(host.probed).not.toContain(REPORTED);
      expect(claude.spawns).toEqual([]);
      expect(fake.controls).toHaveLength(1);
      const [failure] = decodeStartDetails(result.details).startFailures ?? [];
      expect(failure).toMatchObject({ code: "claude_preflight_cleanup_unconfirmed" });
      expect(failure?.message).toContain(LUNA);
      // The failed run suggests no candidate, since its route stopped at an unsafe probe.
      expect(failure?.admittedRun?.nextCandidate).toBeUndefined();
      const [run] = yield* runViews(service);
      assert(run !== undefined);
      expect(run.state).toBe("failed");
      expect(run.nextCandidate).toBeUndefined();
      expect(
        Arr.map(run.selection.skippedCandidates, ({ candidate, code }) => [candidate.model, code]),
      ).toContainEqual(["sonnet", "claude_preflight_cleanup_unconfirmed"]);
      expect(run.systemWarning).toContain("claude_preflight_cleanup_unconfirmed");
    });
  });

  it.effect("ends the chain at a service preflight whose cleanup is unconfirmed", () => {
    const claude = fakeNativeDriver("claude", {
      preflightFailures: { sonnet: "claude_preflight_cleanup_unconfirmed" },
    });
    const { layer } = localServiceFixture(
      { notify: acknowledgeCompletions },
      fakeChildLayer(),
      profileLayerFor({}),
      fakeWriterLeaseLayer(),
      [claude.driver],
    );
    return withService(layer, function* (service) {
      const host = hostBackends();
      const result = yield* start(
        service,
        mixedProfiles([
          declaredCandidate(LUNA, { effort: "default" }),
          nativeCandidate("claude", "sonnet"),
          declaredCandidate(REPORTED, { effort: "default" }),
        ]),
        [{ task: "Map the auth flow" }],
        host.registry,
      );
      expect(claude.spawns).toEqual([]);
      expect(host.probed).not.toContain(REPORTED);
      const [failure] = decodeStartDetails(result.details).startFailures ?? [];
      expect(failure).toMatchObject({ code: "claude_preflight_cleanup_unconfirmed" });
      expect(failure?.admittedRun?.nextCandidate).toBeUndefined();
      expect((yield* runViews(service))[0]?.state).toBe("failed");
    });
  });

  it.effect("names its reason when the next candidate has another write intent", () => {
    const { layer, fake } = localServiceFixture({ notify: acknowledgeCompletions });
    return withService(layer, function* (service) {
      const agents = [{ task: "Map the auth flow" }];
      const result = yield* start(
        service,
        mixedProfiles([
          declaredCandidate(LUNA, { effort: "default" }),
          declaredCandidate(REPORTED, { effort: "default", writeIntent: "writer" }),
        ]),
        agents,
      );
      expect(startIssueStyleProblems(agents, result, true)).toEqual([]);
      expect(fake.controls).toHaveLength(1);
      const [failure] = decodeStartDetails(result.details).startFailures ?? [];
      expect(failure).toMatchObject({
        code: "pi_model_mismatch",
        admittedRun: { nextCandidate: { runtime: "pi", model: REPORTED } },
      });
      expect(failure?.message).toContain("fallback_write_intent_changed");
      const [run] = yield* runViews(service);
      expect(run?.systemWarning).toContain("fallback_write_intent_changed");
    });
  });

  it.effect("names a failed route lookup in the failure and warning", () => {
    // The session is replaced after the first candidate's planning read its tools.
    let toolReads = 0;
    const replaced = extensionApiFixture({
      getThinkingLevel: () => "high",
      getActiveTools: () => {
        toolReads += 1;
        if (toolReads > 1) throw new Error("This extension context is stale.");
        return ["read"];
      },
    });
    const { layer, fake } = localServiceFixture({ notify: acknowledgeCompletions });
    return withService(layer, function* (service) {
      const result = yield* start(
        service,
        routeProfiles([LUNA, REPORTED]),
        [{ task: "Map the auth flow" }],
        testBackendRegistry,
        replaced,
      );
      expect(fake.controls).toHaveLength(1);
      const [failure] = decodeStartDetails(result.details).startFailures ?? [];
      expect(failure).toMatchObject({ code: "pi_model_mismatch" });
      expect(failure?.message).toContain("host_session_unavailable");
      const [run] = yield* runViews(service);
      expect(run?.systemWarning).toContain("host_session_unavailable");
    });
  });

  it.effect("ends the chain when the parent stops the run between candidates", () => {
    const gate = Deferred.makeUnsafe<void>();
    const counts = leaseCounts();
    const { layer, fake } = localServiceFixture(
      { notify: acknowledgeCompletions },
      fakeChildLayer(),
      profileLayerFor({}),
      fakeWriterLeaseLayer({ counts }),
    );
    return withService(layer, function* (service) {
      const host = hostBackends({ gates: { [REPORTED]: gate } });
      const call = yield* start(
        service,
        routeProfiles([LUNA, REPORTED]),
        [{ task: "Fix the parser", profile: "worker" }],
        host.registry,
      ).pipe(Effect.forkChild);
      // The first candidate's processes are gone and the lookup is probing the next one.
      yield* yieldUntil(() => host.probed.includes(REPORTED));
      expect(fake.controls[0]?.released()).toBe(1);
      expect(counts.release).toBe(0);
      const [run] = yield* runViews(service);
      assert(run !== undefined);
      yield* service.stop(run.id);
      // The stop ends the handover, so the lease is released at once.
      expect(counts).toMatchObject({ acquire: 1, release: 1 });
      yield* Deferred.succeed(gate, undefined);
      const result = yield* Fiber.join(call);
      expect(result.structuredContent).toMatchObject({ outcome: "failed" });
      expect(fake.controls).toHaveLength(1);
      expect(yield* runViews(service)).toMatchObject([
        { state: "stopped", cleanup: { disposition: "confirmed" } },
      ]);
    });
  });

  it.effect("ends the chain when the session shuts down between candidates", () => {
    const gate = Deferred.makeUnsafe<void>();
    const counts = leaseCounts();
    const { layer, fake } = localServiceFixture(
      { notify: acknowledgeCompletions },
      fakeChildLayer(),
      profileLayerFor({}),
      fakeWriterLeaseLayer({ counts }),
    );
    return Effect.gen(function* () {
      const serviceScope = yield* Scope.make();
      const service = Context.get(
        yield* Layer.buildWithScope(layer, serviceScope),
        SubagentService,
      );
      const host = hostBackends({ gates: { [REPORTED]: gate } });
      const call = yield* start(
        service,
        routeProfiles([LUNA, REPORTED]),
        [{ task: "Fix the parser", profile: "worker" }],
        host.registry,
      ).pipe(Effect.forkChild);
      yield* yieldUntil(() => host.probed.includes(REPORTED));
      yield* Scope.close(serviceScope, Exit.void);
      // Shutdown ended the handover, and the session-owned start with it.
      expect(counts).toMatchObject({ acquire: 1, release: 1 });
      yield* Deferred.succeed(gate, undefined);
      const settled = yield* Fiber.await(call);
      expect(
        Exit.isSuccess(settled) ? settled.value.structuredContent : { outcome: "interrupted" },
      ).not.toMatchObject({ outcome: "started" });
      expect(fake.controls).toHaveLength(1);
    }).pipe(Effect.scoped);
  });
});

describe("cross-runtime fallback", () => {
  it.effect("reclaims the Pi run state before Claude takes the run", () => {
    const fake = fakeChildLayer();
    const claude = fakeNativeDriver("claude", { reclaimed: () => fake.reclaimedRunIds.length });
    const { layer } = localServiceFixture(
      { notify: acknowledgeCompletions },
      fake,
      profileLayerFor({}),
      fakeWriterLeaseLayer(),
      [claude.driver],
    );
    return withService(layer, function* (service) {
      const result = yield* start(
        service,
        mixedProfiles([
          declaredCandidate(LUNA, { effort: "default" }),
          nativeCandidate("claude", "sonnet"),
        ]),
        [{ task: "Map the auth flow" }],
        hostBackends().registry,
      );
      expect(result.structuredContent).toMatchObject({ outcome: "started" });
      const [run] = yield* runViews(service);
      assert(run !== undefined);
      expect(run).toMatchObject({ state: "running", runtime: "claude", model: "sonnet" });
      expect(run.capabilities).toEqual(NATIVE_CAPABILITIES);
      // The Pi candidate's private directory was reclaimed before Claude spawned.
      expect(fake.reclaimedRunIds).toEqual([run.id]);
      expect(claude.spawns).toEqual([{ model: "sonnet", reclaimedBefore: 1 }]);
    });
  });
});
