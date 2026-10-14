import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import { describe, expect, vi } from "vitest";
import { SubagentBackendRegistry } from "../src/backend/service.ts";
import { SubagentProfileService } from "../src/profiles/service.ts";
import {
  InvalidSubagentRequestError,
  SubagentProcessError,
  type SubagentError,
} from "../src/run/errors.ts";
import type { SubagentControlExpectation, SubagentRunView } from "../src/run/model.ts";
import { SubagentService, type SubagentServiceContract } from "../src/run/service.ts";
import { SUBAGENT_TOOL_NAME } from "../src/run/tool-policy.ts";
import {
  registerSubagentProxyManagerCommand,
  type SubagentProxyCall,
} from "../src/settings/proxy-controller.ts";
import { compactToolDetails } from "../src/tools/details.ts";
import {
  decodeFleetActionRequest,
  encodeFleetActionRequest,
  executeFleetSnapshot,
  fleetSnapshotProxyRequest,
} from "../src/tools/proxy-fleet.ts";
import { executeSubagentActionEffect } from "../src/tools/execute.ts";
import { steeringDeliveryEvidence } from "../src/tools/outcome.ts";
import {
  decodeSubagentProxyResult,
  encodeSubagentProxyPayload,
} from "../src/tools/proxy-protocol.ts";
import type { SubagentToolInput } from "../src/tools/schema.ts";
import { extensionApiFixture } from "pi-cosmic-core/testing";
import { openRegisteredFleet } from "./fixtures/profile-settings-inspection.ts";
import { effectTest, step } from "./support/effect-test.ts";
import { subagentServiceDouble } from "./tools/fixtures/subagent-service-double.ts";
import {
  context,
  fallbackProfileService,
  testBackendRegistry,
  view,
} from "./tools/fixtures/tool-harness.ts";

const CALLER = "caller";
const ENTER = "\r";
const SEND_FAILURE = "Test-owned definite send failure.";

const caller = view({ id: CALLER, name: CALLER, parentRunId: "root", depth: 1 });
const child = (overrides: Partial<SubagentRunView> = {}): SubagentRunView =>
  view({ id: "child", name: "child", parentRunId: CALLER, depth: 2, ...overrides });

const pendingSendError = () =>
  new SubagentProcessError({
    operation: "steer",
    code: "steer_outcome_uncertain",
    pendingDelivery: true,
    message: "Guidance may have been sent; acknowledgement is pending.",
  });

type RootResponder = (input: SubagentToolInput) => Promise<AgentToolResult<unknown>> | undefined;

interface ProxyFleetOptions {
  readonly service?: Partial<SubagentServiceContract>;
  readonly respond?: RootResponder;
  readonly snapshot?: () => Promise<AgentToolResult<unknown>> | undefined;
  readonly isCurrent?: () => boolean;
}

const openProxyFleet = function* (
  getRuns: () => ReadonlyArray<SubagentRunView>,
  options: ProxyFleetOptions = {},
) {
  const calls: SubagentToolInput[] = [];
  const service = subagentServiceDouble({
    visibleList: () => Effect.sync(() => getRuns()),
    authorizeTargets: () => Effect.void,
    ...options.service,
  });
  const rootPi = extensionApiFixture({});
  const root = (input: SubagentToolInput, expected: SubagentControlExpectation) =>
    Effect.runPromise(
      executeSubagentActionEffect(
        rootPi,
        { cwd: "/project", projectTrusted: true },
        input,
        undefined,
        context,
        CALLER,
        undefined,
        false,
        expected,
      ).pipe(
        Effect.provideService(SubagentService, service),
        Effect.provideService(SubagentProfileService, fallbackProfileService),
        Effect.provideService(SubagentBackendRegistry, testBackendRegistry),
      ),
    ).then((result) => {
      const decoded = decodeSubagentProxyResult(encodeSubagentProxyPayload(result) ?? "");
      if (!decoded) throw new Error("Root proxy result failed to round-trip.");
      return decoded;
    });
  const call: SubagentProxyCall = (input, expected) => {
    const decoded = decodeFleetActionRequest(encodeFleetActionRequest(input, expected));
    if (decoded instanceof InvalidSubagentRequestError) return Promise.reject(decoded);
    calls.push(decoded.input);
    return options.respond?.(decoded.input) ?? root(decoded.input, decoded.expected);
  };
  let snapshots = 0;
  const snapshot = (signal: AbortSignal) =>
    (
      options.snapshot?.() ??
      Effect.runPromise(
        executeFleetSnapshot(fleetSnapshotProxyRequest, CALLER).pipe(
          Effect.provideService(SubagentService, service),
        ),
        { signal },
      )
    ).then((result) => {
      const decoded = decodeSubagentProxyResult(encodeSubagentProxyPayload(result) ?? "");
      if (!decoded) throw new Error("Fleet snapshot failed to round-trip.");
      snapshots += 1;
      return decoded;
    });
  const fleet = yield* openRegisteredFleet(
    (pi) =>
      registerSubagentProxyManagerCommand(
        pi,
        CALLER,
        call,
        snapshot,
        options.isCurrent ?? (() => true),
      ),
    160,
  );
  const toolCalls = (tool: string) => calls.filter((input) => input.tool === tool);
  const refreshed = function* () {
    const before = snapshots;
    yield* step(() => vi.waitFor(() => expect(snapshots).toBeGreaterThan(before)));
  };
  return { ...fleet, toolCalls, refreshed };
};

const sendGuidance = (fixture: { readonly press: (...keys: string[]) => void }) =>
  fixture.press("m", "h", "i", ENTER);

describe("nested /subagents proxied actions", () => {
  effectTest(
    "closes a retired fleet and stops refreshing without further user input",
    function* () {
      let current = true;
      const snapshot = vi.fn(() => undefined);
      const fixture = yield* openProxyFleet(() => [caller, child()], {
        isCurrent: () => current,
        snapshot,
      });
      let closed = false;
      void Promise.resolve(fixture.completion).then(
        () => {
          closed = true;
          return undefined;
        },
        () => undefined,
      );
      current = false;
      yield* step(() => vi.waitFor(() => expect(closed).toBe(true)));
      expect(snapshot).toHaveBeenCalledTimes(1);
      expect(fixture.fleet.render(160)).toEqual([]);
    },
  );

  effectTest(
    "carries the captured question identity before the next snapshot refresh",
    function* () {
      const original = child({
        state: "waiting_for_parent",
        assignmentEpoch: 4,
        sessionId: "first-session",
        question: { requestId: "first-question", message: "Proceed?" },
      });
      let runs = [caller, original];
      const received: SubagentControlExpectation[] = [];
      const fixture = yield* openProxyFleet(() => runs, {
        service: {
          reply: (_id, _message, expected) => {
            if (expected) received.push(expected);
            return Effect.fail(
              new InvalidSubagentRequestError({
                code: "run_control_stale",
                message: "The question changed before this reply was admitted.",
              }),
            );
          },
        },
      });
      fixture.press("m", "y", "e", "s");
      runs = [
        caller,
        child({
          state: "waiting_for_parent",
          assignmentEpoch: 5,
          question: { requestId: "second-question", message: "Proceed?" },
        }),
      ];
      fixture.press(ENTER);
      expect(yield* fixture.settled()).toBe("error");
      expect(received).toEqual([
        {
          assignmentEpoch: 4,
          sessionId: "first-session",
          state: "waiting_for_parent",
          questionRequestId: "first-question",
        },
      ]);
      yield* fixture.close();
    },
  );

  effectTest("keeps children beyond the public tool's display-card limit selectable", function* () {
    const runs = Array.from({ length: 32 }, (_, index) =>
      child({ id: `child-${index}`, name: `child-${index}` }),
    );
    const fixture = yield* openProxyFleet(() => [caller, ...runs], {
      service: { stop: (id) => Effect.succeed(child({ id, state: "stopped" })) },
    });
    fixture.press("G", "x", "x");
    expect(yield* fixture.settled()).toBe("success");
    expect(fixture.toolCalls(SUBAGENT_TOOL_NAME.lifecycle)).toEqual([
      { tool: SUBAGENT_TOOL_NAME.lifecycle, args: { action: "stop", runIds: ["child-31"] } },
    ]);
    yield* fixture.close();
  });

  effectTest("keeps exact question identity across private snapshot refreshes", function* () {
    let runs = [
      caller,
      child({
        state: "waiting_for_parent",
        question: { requestId: "first", message: "Proceed?" },
      }),
    ];
    const fixture = yield* openProxyFleet(() => runs);
    fixture.press("m", "y", "e", "s");
    runs = [
      caller,
      child({
        state: "waiting_for_parent",
        question: { requestId: "second", message: "Proceed?" },
      }),
    ];
    yield* fixture.refreshed();
    fixture.press(ENTER);
    expect(fixture.toolCalls(SUBAGENT_TOOL_NAME.reply)).toHaveLength(0);
    fixture.press("\u001b");
    yield* fixture.close();
  });

  effectTest("confirms delivered guidance from the target's own run card", function* () {
    const fixture = yield* openProxyFleet(() => [caller, child()], {
      service: { send: (id) => Effect.succeed(child({ id })) },
    });
    sendGuidance(fixture);
    expect(yield* fixture.settled()).toBe("success");
    expect(fixture.toolCalls(SUBAGENT_TOOL_NAME.send)).toHaveLength(1);
    yield* fixture.close();
  });

  effectTest(
    "shows pending delivery without resending and projects its steering state",
    function* () {
      let runs = [caller, child()];
      const fixture = yield* openProxyFleet(() => runs, {
        service: {
          send: () => {
            runs = [caller, child({ steeringDelivery: "pending" })];
            return Effect.fail(pendingSendError());
          },
          stop: (id) => Effect.succeed(child({ id, state: "stopped" })),
        },
      });
      sendGuidance(fixture);
      expect(yield* fixture.settled()).toBe("warning");

      expect(fixture.fleet.render(160).join("\n")).toContain(
        steeringDeliveryEvidence.pending.message,
      );
      fixture.press("m", "z", "z", ENTER, "h", "i");
      expect(fixture.toolCalls(SUBAGENT_TOOL_NAME.send)).toHaveLength(1);
      expect(fixture.toolCalls(SUBAGENT_TOOL_NAME.lifecycle)).toHaveLength(0);

      fixture.press("x", "x");
      expect(yield* fixture.settled()).toBe("success");
      expect(fixture.toolCalls(SUBAGENT_TOOL_NAME.lifecycle)).toHaveLength(1);
      yield* fixture.close();
    },
  );

  const rejectedSends: ReadonlyArray<readonly [string, () => SubagentError]> = [
    [
      "a definite failure",
      () => new InvalidSubagentRequestError({ code: "run_not_running", message: SEND_FAILURE }),
    ],
    [
      "generic uncertainty without the pending flag",
      () =>
        new SubagentProcessError({
          operation: "steer",
          code: "steer_outcome_uncertain",
          message: "Guidance outcome is uncertain.",
        }),
    ],
    [
      "a pending flag on another uncertain code",
      () =>
        new SubagentProcessError({
          operation: "steer",
          code: "transport_outcome_uncertain",
          pendingDelivery: true,
          message: "Transport outcome is uncertain.",
        }),
    ],
  ];
  for (const [label, error] of rejectedSends)
    effectTest(`never reports success for ${label} and never resends`, function* () {
      const fixture = yield* openProxyFleet(() => [caller, child()], {
        service: { send: () => Effect.fail(error()) },
      });
      sendGuidance(fixture);
      expect(yield* fixture.settled()).toBe("error");
      expect(fixture.toolCalls(SUBAGENT_TOOL_NAME.send)).toHaveLength(1);
      yield* fixture.close();
    });

  const pendingFailure = { id: "child", code: "steer_outcome_uncertain", message: "Pending." };
  const driftedResults: ReadonlyArray<readonly [string, () => AgentToolResult<unknown>]> = [
    ["missing details", () => ({ content: [], details: {} })],
    ["malformed details", () => ({ content: [], details: { version: 2, action: "send" } })],
    [
      "another action's details",
      () => ({
        content: [],
        details: compactToolDetails({ action: "reply", runs: [child()] }),
      }),
    ],
    [
      "another target's run card",
      () => ({
        content: [],
        details: compactToolDetails({ action: "send", runs: [child({ id: "other" })] }),
      }),
    ],
    [
      "another target's pending failure",
      () => ({
        content: [],
        details: {
          ...compactToolDetails({ action: "send", runs: [] }),
          actionFailures: [{ ...pendingFailure, id: "other", pendingDelivery: true }],
        },
      }),
    ],
    [
      "a pending failure contradicted by a run card",
      () => ({
        content: [],
        details: {
          ...compactToolDetails({ action: "send", runs: [child()] }),
          actionFailures: [{ ...pendingFailure, pendingDelivery: true }],
        },
      }),
    ],
  ];
  for (const [label, result] of driftedResults)
    effectTest(`rejects ${label} as unconfirmed without resending`, function* () {
      const fixture = yield* openProxyFleet(() => [caller, child()], {
        respond: (input) =>
          input.tool === SUBAGENT_TOOL_NAME.send ? Promise.resolve(result()) : undefined,
      });
      sendGuidance(fixture);
      expect(yield* fixture.settled()).toBe("error");
      expect(fixture.toolCalls(SUBAGENT_TOOL_NAME.send)).toHaveLength(1);
      yield* fixture.close();
    });

  const question = { requestId: "q", message: "Which file?" };

  effectTest("keeps a flagged reply failure an error rather than pending", function* () {
    const fixture = yield* openProxyFleet(
      () => [caller, child({ state: "waiting_for_parent", question })],
      {
        respond: (input) =>
          input.tool === SUBAGENT_TOOL_NAME.reply
            ? Promise.resolve({
                content: [],
                details: {
                  ...compactToolDetails({ action: "reply", runs: [] }),
                  actionFailures: [{ ...pendingFailure, pendingDelivery: true }],
                },
              })
            : undefined,
      },
    );
    fixture.press("m", "o", "k", ENTER);
    expect(yield* fixture.settled()).toBe("error");
    expect(fixture.toolCalls(SUBAGENT_TOOL_NAME.reply)).toHaveLength(1);
    yield* fixture.close();
  });

  effectTest("keeps a pending run's parent-question reply available", function* () {
    const waiting = child({ state: "waiting_for_parent", question, steeringDelivery: "pending" });
    const fixture = yield* openProxyFleet(() => [caller, waiting], {
      service: { reply: (id) => Effect.succeed(child({ id })) },
    });
    fixture.press("m", "o", "k", ENTER);
    expect(yield* fixture.settled()).toBe("success");
    expect(fixture.toolCalls(SUBAGENT_TOOL_NAME.reply)).toHaveLength(1);
    yield* fixture.close();
  });

  for (const [label, keys] of [
    ["interrupt", ["i", "i"]],
    ["rename", ["e", "o", "k", ENTER]],
  ] as const)
    effectTest(`accepts ${label} with its own matching receipt`, function* () {
      const fixture = yield* openProxyFleet(() => [caller, child()], {
        service: {
          interrupt: (id) => Effect.succeed(child({ id, state: "paused" })),
          rename: (id, name) => Effect.succeed(child({ id, name })),
        },
      });
      fixture.press(...keys);
      expect(yield* fixture.settled()).toBe("success");
      yield* fixture.close();
    });

  effectTest("rejects a lifecycle receipt for a different lifecycle action", function* () {
    const fixture = yield* openProxyFleet(() => [caller, child()], {
      respond: (input) =>
        input.tool === SUBAGENT_TOOL_NAME.lifecycle
          ? Promise.resolve({
              content: [],
              details: compactToolDetails({ action: "interrupt", runs: [child()] }),
            })
          : undefined,
    });
    fixture.press("x", "x");
    expect(yield* fixture.settled()).toBe("error");
    expect(fixture.toolCalls(SUBAGENT_TOOL_NAME.lifecycle)).toHaveLength(1);
    yield* fixture.close();
  });

  effectTest("keeps accepted work successful when the later refresh fails", function* () {
    let refreshFails = false;
    const fixture = yield* openProxyFleet(() => [caller, child()], {
      service: { send: (id) => Effect.succeed(child({ id })) },
      snapshot: () =>
        refreshFails ? Promise.reject(new Error("Refresh unavailable.")) : undefined,
    });
    refreshFails = true;
    sendGuidance(fixture);
    expect(yield* fixture.settled()).toBe("success");
    expect(fixture.toolCalls(SUBAGENT_TOOL_NAME.send)).toHaveLength(1);
    yield* fixture.close();
  });

  effectTest("reports the action's own failure over a later refresh failure", function* () {
    let refreshFails = false;
    const fixture = yield* openProxyFleet(() => [caller, child()], {
      service: {
        send: () =>
          Effect.fail(
            new InvalidSubagentRequestError({ code: "run_not_running", message: SEND_FAILURE }),
          ),
      },
      snapshot: () =>
        refreshFails ? Promise.reject(new Error("Refresh unavailable.")) : undefined,
    });
    refreshFails = true;
    sendGuidance(fixture);
    expect(yield* fixture.settled()).toBe("error");
    expect(fixture.fleet.render(160).join("\n")).toContain(SEND_FAILURE);
    expect(fixture.toolCalls(SUBAGENT_TOOL_NAME.send)).toHaveLength(1);
    yield* fixture.close();
  });
});
