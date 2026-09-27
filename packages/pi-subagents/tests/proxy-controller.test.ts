// Registered nested /subagents actions over the real root executor and proxy codec. Assertions
// observe the fleet's settled outcome kind and proxied calls, never presentation details.
import type { AgentToolResult, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import * as Effect from "effect/Effect";
import { extensionContextFixture, plainTheme } from "pi-cosmic-core/testing";
import { describe, expect, vi } from "vitest";
import { SubagentBackendRegistry } from "../src/backend/service.ts";
import { SubagentProfileService } from "../src/profiles/service.ts";
import {
  InvalidSubagentRequestError,
  SubagentProcessError,
  type SubagentError,
} from "../src/run/errors.ts";
import type { SubagentRunView } from "../src/run/model.ts";
import { SubagentService, type SubagentServiceContract } from "../src/run/service.ts";
import { SUBAGENT_TOOL_NAME } from "../src/run/tool-policy.ts";
import {
  registerSubagentProxyManagerCommand,
  type SubagentProxyCall,
} from "../src/settings/proxy-controller.ts";
import { makeCompactToolDetails } from "../src/tools/details.ts";
import { executeSubagentActionEffect } from "../src/tools/execute.ts";
import { steeringDeliveryEvidence } from "../src/tools/outcome.ts";
import {
  decodeSubagentProxyResult,
  encodeSubagentProxyPayload,
} from "../src/tools/proxy-protocol.ts";
import type { SubagentToolInput } from "../src/tools/schema.ts";
import { SubagentFleetComponent, type FleetNoticeKind } from "../src/ui/fleet.ts";
import { extensionApiFixture, mountingCustomUi } from "./fixtures/pi-host.ts";
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
const ESC = "\x1b";
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
  /** Replaces the root response for protocol-drift cases the real executor cannot produce. */
  readonly respond?: RootResponder;
}

/** Opens the registered nested manager whose proxy reaches the real root action executor. */
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
  const root = (input: SubagentToolInput) =>
    Effect.runPromise(
      executeSubagentActionEffect(
        rootPi,
        { cwd: "/project", projectTrusted: true },
        input,
        undefined,
        context,
        CALLER,
      ).pipe(
        Effect.provideService(SubagentService, service),
        Effect.provideService(SubagentProfileService, fallbackProfileService),
        Effect.provideService(SubagentBackendRegistry, testBackendRegistry),
      ),
    ).then((result) => {
      // The private proxy transports JSON; decode it exactly as nested Pi does.
      const decoded = decodeSubagentProxyResult(encodeSubagentProxyPayload(result) ?? "");
      if (!decoded) throw new Error("Root proxy result failed to round-trip.");
      return decoded;
    });
  const call: SubagentProxyCall = (input) => {
    calls.push(input);
    return options.respond?.(input) ?? root(input);
  };
  let handler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
  registerSubagentProxyManagerCommand(
    extensionApiFixture({
      registerCommand: (
        _name: string,
        definition: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> },
      ) => {
        handler = definition.handler;
      },
    }),
    CALLER,
    call,
  );
  const overlays: Component[] = [];
  const { custom } = mountingCustomUi(plainTheme, (created) => overlays.push(created), {
    columns: 160,
    rows: 30,
  });
  const ctx = extensionContextFixture({
    cwd: "/project",
    hasUI: true,
    mode: "tui",
    ui: { notify: vi.fn(), custom },
  });
  const running = handler?.("", ctx) ?? Promise.resolve();
  yield* step(() => vi.waitFor(() => expect(overlays).toHaveLength(1)));
  const fleet = overlays[0];
  if (!(fleet instanceof SubagentFleetComponent)) throw new Error("Expected the nested fleet.");
  const press = (...keys: string[]) => {
    for (const key of keys) {
      fleet.handleInput(key);
      fleet.render(160);
    }
  };
  const toolCalls = (tool: string) => calls.filter((input) => input.tool === tool);
  /** Waits for the one in-flight action to settle into a final outcome. */
  const settled = function* () {
    let kind: FleetNoticeKind | undefined;
    yield* step(() =>
      vi.waitFor(() => {
        kind = fleet.noticeKind;
        expect(kind === undefined || kind === "info").toBe(false);
      }),
    );
    return kind;
  };
  const close = function* () {
    press(ESC);
    yield* step(() => running);
  };
  return { fleet, press, toolCalls, settled, close };
};

const sendGuidance = (fixture: { readonly press: (...keys: string[]) => void }) =>
  fixture.press("m", "h", "i", ENTER);

describe("nested /subagents proxied actions", () => {
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

      // The refreshed card carries pending delivery: guidance and interruption stay closed.
      expect(fixture.fleet.render(160).join("\n")).toContain(
        steeringDeliveryEvidence.pending.message,
      );
      fixture.press("m", "z", "z", ENTER, "h", "i");
      expect(fixture.toolCalls(SUBAGENT_TOOL_NAME.send)).toHaveLength(1);
      expect(fixture.toolCalls(SUBAGENT_TOOL_NAME.lifecycle)).toHaveLength(0);

      // Stop remains available; the normal subtree stop receipt is the selected run's view.
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
        details: makeCompactToolDetails({ action: "reply", runs: [child()] }),
      }),
    ],
    [
      "another target's run card",
      () => ({
        content: [],
        details: makeCompactToolDetails({ action: "send", runs: [child({ id: "other" })] }),
      }),
    ],
    [
      "another target's pending failure",
      () => ({
        content: [],
        details: {
          ...makeCompactToolDetails({ action: "send", runs: [] }),
          actionFailures: [{ ...pendingFailure, id: "other", pendingDelivery: true }],
        },
      }),
    ],
    [
      "a pending failure contradicted by a run card",
      () => ({
        content: [],
        details: {
          ...makeCompactToolDetails({ action: "send", runs: [child()] }),
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

  const question = { requestId: "q", message: "Which file?", createdAt: 1 };

  effectTest("keeps a flagged reply failure an error rather than pending", function* () {
    const fixture = yield* openProxyFleet(
      () => [caller, child({ state: "waiting_for_parent", question })],
      {
        respond: (input) =>
          input.tool === SUBAGENT_TOOL_NAME.reply
            ? Promise.resolve({
                content: [],
                details: {
                  ...makeCompactToolDetails({ action: "reply", runs: [] }),
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
    ["interrupt", ["i"]],
    ["rename", ["n", "o", "k", ENTER]],
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
              details: makeCompactToolDetails({ action: "interrupt", runs: [child()] }),
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
      respond: (input) =>
        refreshFails && input.tool === SUBAGENT_TOOL_NAME.list
          ? Promise.reject(new Error("Refresh unavailable."))
          : undefined,
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
      respond: (input) =>
        refreshFails && input.tool === SUBAGENT_TOOL_NAME.list
          ? Promise.reject(new Error("Refresh unavailable."))
          : undefined,
    });
    refreshFails = true;
    sendGuidance(fixture);
    expect(yield* fixture.settled()).toBe("error");
    expect(fixture.fleet.render(160).join("\n")).toContain(SEND_FAILURE);
    expect(fixture.toolCalls(SUBAGENT_TOOL_NAME.send)).toHaveLength(1);
    yield* fixture.close();
  });
});
