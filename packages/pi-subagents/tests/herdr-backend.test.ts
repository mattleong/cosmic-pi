import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import { yieldUntil } from "pi-cosmic-core/testing";
import { makeHerdrBackendDriver, withHerdrSupervisorInstructions } from "../src/backend/herdr.ts";
import type { BackendLaunchRequest, BackendReport } from "../src/backend/model.ts";
import type { HerdrAgent } from "../src/boundary/herdr-cli.ts";
import type { HerdrHostContract } from "../src/boundary/herdr-host.ts";
import type { SupervisorChannelContract } from "../src/boundary/supervisor-channel.ts";
import { SubagentProcessError, processError } from "../src/run/errors.ts";
import { backendSupervisor, supervisorMetadata } from "./fixtures/backend-supervisor.ts";
import type { SupervisorEvent } from "../src/supervisor/protocol.ts";
import {
  SUPERVISOR_MCP_REGISTRATION,
  SUPERVISOR_MCP_TOOL_NAMES,
} from "../src/supervisor/mcp-contract.ts";

const request = (writeIntent: "read-only" | "writer" = "read-only"): BackendLaunchRequest => ({
  runId: "agent-r1-1",
  name: "nested-policy",
  closeOnReport: true,
  cwd: "/project",
  context: "fresh",
  writeIntent,
  openaiFastMode: false,
  model: "openai-codex/gpt-5.6-sol",
  effort: "high",
  activeTools: ["subagent_start", "code_mode"],
  projectTrusted: true,
  parentSessionId: "root-session",
  systemPrompt: "Complete the assignment.",
});

const baseAgent: HerdrAgent = {
  paneId: "pane-1",
  terminalId: "terminal-1",
  workspaceId: "workspace-1",
  tabId: "tab-1",
  agentStatus: "working",
  name: "owned-agent",
  runtime: "claude",
  stateChangeSequence: 1,
  interactiveReady: true,
  agentSession: { source: "fixture", agent: "claude", kind: "id", value: "native-1" },
};

const metadata = supervisorMetadata({
  port: 31_337,
  stateDirectory: "/private/supervisor",
  connectionConfigPath: "/private/supervisor/connection.json",
  helperPath: "/private/supervisor/helper.mjs",
  command: "node",
  args: [],
  tomlFragment: "",
});

interface PromptState {
  readonly getRemote: () => HerdrAgent;
  readonly setRemote: (agent: HerdrAgent) => void;
}

interface HerdrBackendHarnessOptions {
  readonly prompt?:
    | ((state: PromptState) => Effect.Effect<HerdrAgent, SubagentProcessError>)
    | undefined;
  readonly accepted?: boolean | undefined;
}

const makeBackendHarness = (options: HerdrBackendHarnessOptions = {}) =>
  Effect.gen(function* () {
    let remote = baseAgent;
    let accepted = options.accepted === true;
    let inspectCalls = 0;
    let promptCalls = 0;
    const assignmentEpochs: number[] = [];
    const supervisorEvents = yield* Queue.unbounded<SupervisorEvent, Cause.Done>();
    const promptState: PromptState = {
      getRemote: () => remote,
      setRemote: (agent) => {
        remote = agent;
      },
    };
    const supervisor = backendSupervisor(metadata, supervisorEvents, {
      setAssignmentEpoch: (epoch) =>
        Effect.sync(() => {
          assignmentEpochs.push(epoch);
        }),
      hasAcceptedReport: () => Effect.sync(() => accepted),
      acceptedReportForEpoch: () => Effect.sync((): BackendReport | undefined => undefined),
      close: Effect.void,
    });
    const supervisors: SupervisorChannelContract = {
      open: () => Effect.succeed(supervisor),
    };
    const host: HerdrHostContract = {
      preflight: () => Effect.void,
      launch: () =>
        Effect.succeed({
          agentName: "owned-agent",
          workspaceId: baseAgent.workspaceId,
          tabId: baseAgent.tabId,
          paneId: baseAgent.paneId,
          inspect: Effect.sync(() => {
            inspectCalls += 1;
            return remote;
          }),
          prompt: () => {
            promptCalls += 1;
            return options.prompt?.(promptState) ?? Effect.succeed(remote);
          },
          close: Effect.void,
        }),
    };
    const handle = yield* makeHerdrBackendDriver("claude", host, supervisors).spawn(request());
    return {
      handle,
      assignmentEpochs,
      promptCalls: () => promptCalls,
      inspectCalls: () => inspectCalls,
      setAccepted: (value: boolean) => {
        accepted = value;
      },
      setRemote: promptState.setRemote,
    };
  });

describe("Herdr backend policy", () => {
  it.each(["pi", "claude", "codex"] as const)(
    "permits owned delegation surfaces while rejecting competing ones for %s",
    (runtime) => {
      const systemPrompt = withHerdrSupervisorInstructions(runtime, request()).systemPrompt;

      expect(systemPrompt).toContain("package-owned authenticated subagent proxies");
      expect(systemPrompt).toContain("native agent controls explicitly enabled by this runtime");
      expect(systemPrompt).toContain("competing orchestration tools");
      expect(systemPrompt).toContain(SUPERVISOR_MCP_REGISTRATION);
      for (const toolName of SUPERVISOR_MCP_TOOL_NAMES) expect(systemPrompt).toContain(toolName);
      expect(systemPrompt).not.toContain("Never delegate");
    },
  );
});

describe("Herdr prompt settlement", () => {
  it.effect("returns the exact definite typed prompt failure", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const exact = processError("prompt", "fixture_prompt_rejected", "Rejected before issue.");
        const harness = yield* makeBackendHarness({ prompt: () => Effect.fail(exact) });

        const failure = yield* harness.handle.controls.start("Try once.", 1).pipe(Effect.flip);

        expect(failure).toBe(exact);
        expect(harness.assignmentEpochs).toEqual([1]);
        expect(Option.isNone(yield* Queue.poll(harness.handle.events))).toBe(true);
      }),
    ),
  );

  it.effect("keeps prompt interruption as an interrupt cause", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>();
        const harness = yield* makeBackendHarness({
          prompt: () => Deferred.await(gate).pipe(Effect.andThen(Effect.succeed(baseAgent))),
        });
        const starting = yield* harness.handle.controls
          .start("Wait for cancellation.", 1)
          .pipe(Effect.forkScoped);
        yield* yieldUntil(() => harness.promptCalls() === 1);

        yield* Fiber.interrupt(starting);
        const exit = yield* Fiber.await(starting);

        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
          expect(Cause.hasFails(exit.cause)).toBe(false);
          expect(Cause.hasDies(exit.cause)).toBe(false);
        }
        expect(Option.isNone(yield* Queue.poll(harness.handle.events))).toBe(true);
      }),
    ),
  );

  it.effect("keeps prompt defects as die causes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const defect = new Error("fixture prompt defect");
        const harness = yield* makeBackendHarness({ prompt: () => Effect.die(defect) });

        const exit = yield* harness.handle.controls.start("Defect.", 1).pipe(Effect.exit);

        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Cause.hasDies(exit.cause)).toBe(true);
          expect(Cause.hasFails(exit.cause)).toBe(false);
          expect(Cause.hasInterrupts(exit.cause)).toBe(false);
        }
        expect(Option.isNone(yield* Queue.poll(harness.handle.events))).toBe(true);
      }),
    ),
  );

  it.effect("accepts report evidence once and keeps the handle alive", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeBackendHarness({ accepted: true });

        yield* harness.handle.controls.start("Report evidence.", 7);

        expect(yield* Queue.take(harness.handle.events)).toEqual({
          type: "run_started",
          assignmentEpoch: 7,
        });
        expect(Option.isNone(yield* Queue.poll(harness.handle.events))).toBe(true);
        const waitingForExit = yield* harness.handle.awaitExit.pipe(Effect.forkScoped);
        yield* Effect.yieldNow;
        expect(waitingForExit.pollUnsafe()).toBeUndefined();
        expect(harness.assignmentEpochs).toEqual([7]);
      }),
    ),
  );

  it.effect("accepts one causal post-prompt state change", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeBackendHarness({
          prompt: ({ getRemote, setRemote }) =>
            Effect.sync(() => {
              const baseline = getRemote();
              setRemote({ ...baseline, stateChangeSequence: baseline.stateChangeSequence + 1 });
              return baseline;
            }),
        });

        yield* harness.handle.controls.start("Topology evidence.", 3);

        expect(yield* Queue.take(harness.handle.events)).toEqual({
          type: "run_started",
          assignmentEpoch: 3,
        });
        expect(Option.isNone(yield* Queue.poll(harness.handle.events))).toBe(true);
        expect(harness.assignmentEpochs).toEqual([3]);
      }),
    ),
  );

  it.effect("fails closed when bounded prompt evidence expires", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const uncertain = processError(
          "prompt",
          "fixture_prompt_outcome_uncertain",
          "Prompt delivery was not confirmed.",
        );
        const harness = yield* makeBackendHarness({ prompt: () => Effect.fail(uncertain) });
        const starting = yield* harness.handle.controls
          .start("Reconcile this prompt.", 2)
          .pipe(Effect.forkScoped);
        yield* yieldUntil(() => harness.inspectCalls() >= 2);
        yield* TestClock.adjust("5 seconds");

        const failure = yield* Fiber.join(starting).pipe(Effect.flip);
        const protocolError = yield* Queue.take(harness.handle.events);
        const exited = yield* harness.handle.awaitExit;

        expect(failure).toMatchObject({
          _tag: "SubagentProcessError",
          code: "herdr_prompt_outcome_uncertain",
        });
        expect(protocolError).toMatchObject({
          type: "protocol_error",
          message: expect.stringContaining("uncertain"),
        });
        expect(exited).toMatchObject({ type: "exit", exitCode: null });
        expect(harness.assignmentEpochs).toEqual([2]);
        expect(Option.isNone(yield* Queue.poll(harness.handle.events))).toBe(true);

        harness.setAccepted(true);
        harness.setRemote({ ...baseAgent, stateChangeSequence: 2 });
        yield* TestClock.adjust("1 second");
        expect(Option.isNone(yield* Queue.poll(harness.handle.events))).toBe(true);
      }),
    ),
  );
});
