import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import type { HerdrHostShape, HerdrHostedAgent } from "../src/boundary/herdr-host.ts";
import type { HerdrAgent } from "../src/boundary/herdr-cli.ts";
import type {
  SupervisorChannelHandle,
  SupervisorChannelShape,
} from "../src/boundary/supervisor-channel.ts";
import { makeHerdrBackendDriver } from "../src/backend/herdr.ts";
import type { BackendEvent, BackendLaunchRequest } from "../src/backend/model.ts";
import { SubagentProcessError } from "../src/run/errors.ts";

const launch = (
  runtime: "pi" | "claude" | "codex",
  closeOnReport = false,
): BackendLaunchRequest => ({
  runId: `agent-${runtime}`,
  name: `${runtime}-worker`,
  closeOnReport,
  cwd: "/project",
  context: "fresh",
  writeIntent: "read-only",
  fastMode: false,
  model: runtime === "pi" ? "openai-codex/gpt-5.6-sol" : `${runtime}-model`,
  effort: "xhigh",
  activeTools: [],
  projectTrusted: false,
  parentSessionId: "parent-session",
  systemPrompt: "Fixed base policy.",
});

const metadata = {
  runId: "agent-runtime",
  host: "127.0.0.1" as const,
  port: 1,
  stateDirectory: "/private/supervisor",
  connectionConfigPath: "/private/supervisor/connection.json",
  helperPath: "/private/helper.mjs",
  claudeMcp: {
    mcpServers: {
      pi_subagents_supervisor: {
        type: "stdio" as const,
        command: process.execPath,
        args: ["/private/helper.mjs"],
        env: {},
      },
    },
  },
  codexMcp: {
    serverName: "pi_subagents_supervisor" as const,
    command: process.execPath,
    args: ["/private/helper.mjs"],
    enabledTools: [
      "supervisor_progress",
      "supervisor_warning",
      "supervisor_question",
      "supervisor_submit_report",
    ],
    tomlFragment: "[mcp_servers.pi_subagents_supervisor]",
  },
};

const fixture = Effect.gen(function* () {
  const supervisorEvents = yield* Queue.unbounded<
    Extract<BackendEvent, { readonly type: "supervisor_contact" | "report" }>,
    Cause.Done
  >();
  const epochs: number[] = [];
  const replies: Array<readonly [string, string]> = [];
  const prompts: string[] = [];
  let remoteStatus: HerdrAgent["agentStatus"] = "working";
  let remoteStateChangeSequence = 1;
  let pendingPromptLifecycleEvidence = false;
  let promptMode:
    | "success-transition"
    | "success-report"
    | "success-no-evidence"
    | "uncertain-report"
    | "uncertain-no-evidence" = "success-transition";
  const acceptedEpochs = new Set<number>();
  let currentEpoch = 0;
  let closed = 0;
  const remote = (): HerdrAgent => ({
    paneId: "w:p",
    terminalId: "term",
    workspaceId: "w",
    tabId: "w:t",
    cwd: "/project",
    focused: false,
    agentStatus: remoteStatus,
    name: "owned-agent",
    runtime: "pi",
    stateChangeSequence: remoteStateChangeSequence,
    interactiveReady: true,
    agentSession: { source: "fixture", agent: "pi", kind: "id", value: "native-session" },
    nativeSession: "native-session",
  });
  const hosted = (runtime: "pi" | "claude" | "codex"): HerdrHostedAgent => ({
    runId: `agent-${runtime}`,
    runtime,
    agentName: "owned-agent",
    workspaceId: "w",
    tabId: "w:t",
    paneId: "w:p",
    terminalId: "term",
    nativeSession: "native-session",
    agentSession: {
      source: "fixture",
      agent: runtime,
      kind: "id",
      value: "native-session",
    },
    sessionIdentity: "inherited",
    inspect: Effect.sync(() => {
      if (pendingPromptLifecycleEvidence) {
        pendingPromptLifecycleEvidence = false;
        remoteStateChangeSequence += 1;
      }
      return { ...remote(), runtime };
    }),
    prompt: (text) =>
      Effect.suspend(() => {
        prompts.push(text);
        if (promptMode === "success-transition") pendingPromptLifecycleEvidence = true;
        if (promptMode === "uncertain-report" || promptMode === "success-report") {
          acceptedEpochs.add(currentEpoch);
          Queue.offerUnsafe(supervisorEvents, {
            type: "report",
            runId: `agent-${runtime}`,
            assignmentEpoch: currentEpoch,
            sequence: 1,
            deliveryId: `${promptMode}-${currentEpoch}`,
            text: "Report accepted as causal prompt evidence.",
          });
        }
        return promptMode.startsWith("success-")
          ? Effect.succeed({ ...remote(), runtime })
          : Effect.fail(
              new SubagentProcessError({
                operation: "prompt agent",
                code: "herdr_prompt_agent_outcome_uncertain",
                message: "Fixture prompt outcome uncertain.",
              }),
            );
      }),
    close: Effect.sync(() => {
      closed += 1;
    }),
  });
  const host: HerdrHostShape = {
    preflight: () => Effect.void,
    launch: (runtime) => Effect.succeed(hosted(runtime)),
  };
  let currentHandle: SupervisorChannelHandle | undefined;
  const supervisors: SupervisorChannelShape = {
    open: (request) => {
      currentHandle = {
        runId: request.runId,
        metadata: { ...metadata, runId: request.runId },
        events: supervisorEvents,
        awaitReady: Effect.void,
        setAssignmentEpoch: (epoch) =>
          Effect.sync(() => {
            currentEpoch = epoch;
            epochs.push(epoch);
          }),
        hasAcceptedReport: (epoch) => Effect.sync(() => acceptedEpochs.has(epoch)),
        acceptedReportForEpoch: (epoch) =>
          Effect.sync(() =>
            acceptedEpochs.has(epoch)
              ? {
                  runId: request.runId,
                  assignmentEpoch: epoch,
                  sequence: 1,
                  deliveryId: `herdr-${epoch}`,
                  text: "Accepted Herdr fixture report.",
                }
              : undefined,
          ),
        reply: (id, message) => Effect.sync(() => void replies.push([id, message])),
        cancelPending: () => {},
        close: Effect.void,
      };
      return Effect.succeed(currentHandle);
    },
  };
  return {
    host,
    supervisors,
    supervisorEvents,
    epochs,
    replies,
    prompts,
    setRemoteStatus: (status: HerdrAgent["agentStatus"]) => void (remoteStatus = status),
    setPromptMode: (mode: typeof promptMode) => void (promptMode = mode),
    closed: () => closed,
  };
});

const take = <A>(queue: Queue.Dequeue<A, Cause.Done>) => Queue.take(queue);

describe("Herdr Phase One backend drivers", () => {
  for (const runtime of ["pi", "claude", "codex"] as const) {
    it.effect(
      `${runtime} confirms assignment epochs, prompts, parent contact, report, and retained follow-up`,
      () =>
        Effect.gen(function* () {
          const test = yield* fixture;
          const driver = makeHerdrBackendDriver(runtime, test.host, test.supervisors);
          expect(driver.capabilities).toEqual(["parent-contact"]);
          expect(driver.supportsContext("fork")).toBe(false);
          const handle = yield* driver.spawn(launch(runtime));
          expect(yield* handle.controls.initialize).toMatchObject({
            model: launch(runtime).model,
            effort: "xhigh",
            sessionId: "herdr:term",
          });
          yield* handle.controls.start("Initial task", 1);
          expect(test.epochs).toEqual([1]);
          expect(test.prompts.at(-1)).toContain("assignment epoch 1");
          expect(yield* take(handle.events)).toEqual({ type: "run_started", assignmentEpoch: 1 });

          Queue.offerUnsafe(test.supervisorEvents, {
            type: "supervisor_contact",
            assignmentEpoch: 1,
            requestId: "question-1",
            kind: "question",
            message: "Need a decision",
          });
          expect(yield* take(handle.events)).toMatchObject({
            type: "supervisor_contact",
            kind: "question",
          });
          yield* handle.controls.reply("question-1", "Proceed");
          expect(test.replies).toEqual([["question-1", "Proceed"]]);

          Queue.offerUnsafe(test.supervisorEvents, {
            type: "report",
            runId: `agent-${runtime}`,
            assignmentEpoch: 1,
            sequence: 1,
            deliveryId: "generation-1",
            text: "First report",
          });
          expect(yield* take(handle.events)).toMatchObject({ type: "report", sequence: 1 });

          yield* handle.controls.start("Follow-up task", 2);
          expect(test.epochs).toEqual([1, 2]);
          expect(test.prompts.at(-1)).toContain("assignment epoch 2");
          expect(yield* take(handle.events)).toEqual({ type: "run_started", assignmentEpoch: 2 });
          yield* handle.terminate("graceful");
          expect(test.closed()).toBe(1);
        }).pipe(Effect.scoped),
    );
  }

  it.effect("causally starts an assignment when a report settles uncertain prompt delivery", () =>
    Effect.gen(function* () {
      const test = yield* fixture;
      test.setPromptMode("uncertain-report");
      const handle = yield* makeHerdrBackendDriver("pi", test.host, test.supervisors).spawn(
        launch("pi"),
      );
      yield* handle.controls.initialize;
      yield* handle.controls.start("Task", 1);
      const observed = [yield* take(handle.events), yield* take(handle.events)];
      expect(observed).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "report", assignmentEpoch: 1 }),
          expect.objectContaining({ type: "run_started", assignmentEpoch: 1 }),
        ]),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("requires causal evidence after a successful prompt dispatch response", () =>
    Effect.gen(function* () {
      const test = yield* fixture;
      test.setPromptMode("success-no-evidence");
      const handle = yield* makeHerdrBackendDriver("pi", test.host, test.supervisors).spawn(
        launch("pi"),
      );
      yield* handle.controls.initialize;
      const starting = yield* handle.controls.start("Task", 1).pipe(Effect.forkScoped);
      yield* TestClock.adjust("5 seconds");
      const failure = yield* Fiber.join(starting).pipe(Effect.flip);
      expect(failure).toMatchObject({ code: "herdr_prompt_outcome_uncertain" });
      const pending = yield* Queue.poll(handle.events);
      expect(pending._tag).toBe("None");
    }).pipe(Effect.scoped),
  );

  it.effect("accepts an epoch report as causal evidence after successful prompt dispatch", () =>
    Effect.gen(function* () {
      const test = yield* fixture;
      test.setPromptMode("success-report");
      const handle = yield* makeHerdrBackendDriver("pi", test.host, test.supervisors).spawn(
        launch("pi"),
      );
      yield* handle.controls.initialize;
      yield* handle.controls.start("Task", 1);
      const observed = [yield* take(handle.events), yield* take(handle.events)];
      expect(observed).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "report", assignmentEpoch: 1 }),
          expect.objectContaining({ type: "run_started", assignmentEpoch: 1 }),
        ]),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("bounds uncertain prompt reconciliation without starting missing-report polling", () =>
    Effect.gen(function* () {
      const test = yield* fixture;
      test.setRemoteStatus("done");
      test.setPromptMode("uncertain-no-evidence");
      const handle = yield* makeHerdrBackendDriver("pi", test.host, test.supervisors).spawn(
        launch("pi"),
      );
      yield* handle.controls.initialize;
      const starting = yield* handle.controls.start("Task", 1).pipe(Effect.forkScoped);
      yield* TestClock.adjust("5 seconds");
      const failure = yield* Fiber.join(starting).pipe(Effect.flip);
      expect(failure).toMatchObject({ code: "herdr_prompt_outcome_uncertain" });
      const pending = yield* Queue.poll(handle.events);
      expect(pending._tag).toBe("None");
    }).pipe(Effect.scoped),
  );

  it.effect("fails when a native turn settles without the supervisor-owned report", () =>
    Effect.gen(function* () {
      const test = yield* fixture;
      const handle = yield* makeHerdrBackendDriver("pi", test.host, test.supervisors).spawn(
        launch("pi"),
      );
      yield* handle.controls.initialize;
      yield* handle.controls.start("Task", 1);
      yield* take(handle.events);
      test.setRemoteStatus("done");
      yield* TestClock.adjust("6 seconds");
      const event = yield* take(handle.events);
      expect(event).toMatchObject({
        type: "protocol_error",
        message: expect.stringContaining("without an accepted supervisor report"),
      });
    }).pipe(Effect.scoped),
  );
});
