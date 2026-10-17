import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { describe, expect, it } from "vitest";
import { InvalidSubagentRequestError } from "../../src/run/errors.ts";
import { captureSubagentControlExpectation } from "../../src/run/model.ts";
import { SubagentService } from "../../src/run/service.ts";
import { MAX_RETAINED_RUNS } from "../../src/run/limits.ts";
import {
  decodeFleetSnapshotResult,
  decodeFleetActionRequest,
  encodeFleetActionRequest,
  FLEET_ACTION_TOOL_NAME,
  executeFleetSnapshot,
  fleetSnapshotProxyRequest,
} from "../../src/tools/proxy-fleet.ts";
import {
  decodeSubagentProxyResult,
  encodeSubagentProxyPayload,
} from "../../src/tools/proxy-protocol.ts";
import { subagentServiceDouble } from "./fixtures/subagent-service-double.ts";
import { view } from "../fixtures/run-view.ts";
import { effectTest } from "../support/effect-test.ts";

describe("private fleet snapshots", () => {
  effectTest(
    "returns every authorized retained run without acquiring or returning completion reports",
    function* () {
      const runs = Array.from({ length: MAX_RETAINED_RUNS }, (_, index) =>
        view({
          id: `child-${index}`,
          parentRunId: "caller",
          finalText: "Retained report not owned by this display",
          error: "Retained failure detail",
          question: { requestId: `question-${index}`, message: "Proceed?" },
          sessionId: `session-${index}`,
        }),
      );
      const service = subagentServiceDouble({
        visibleList: (caller) => Effect.succeed(caller === "caller" ? runs : []),
      });
      const result = yield* executeFleetSnapshot(fleetSnapshotProxyRequest, "caller").pipe(
        Effect.provideService(SubagentService, service),
        Effect.orDie,
      );
      const decoded = decodeSubagentProxyResult(encodeSubagentProxyPayload(result) ?? "");
      expect(decoded).toBeDefined();
      const snapshot = decodeFleetSnapshotResult(decoded!);
      expect(snapshot?.map((run) => run.id)).toEqual(runs.map((run) => run.id));
      expect(snapshot?.at(-1)?.question?.requestId).toBe(`question-${MAX_RETAINED_RUNS - 1}`);
      expect(snapshot?.at(-1)?.assignmentEpoch).toBe(runs.at(-1)?.assignmentEpoch);
      expect(snapshot?.at(-1)?.sessionId).toBe(`session-${MAX_RETAINED_RUNS - 1}`);
      expect(JSON.stringify(decoded)).not.toContain("Retained report");
      expect(JSON.stringify(decoded)).not.toContain("Retained failure");
      expect(Object.isFrozen(snapshot)).toBe(true);
      expect(Object.isFrozen(snapshot?.[0])).toBe(true);
    },
  );

  effectTest("rejects requests that try to supply their own caller authority", function* () {
    const result = yield* executeFleetSnapshot(
      { ...fleetSnapshotProxyRequest, argumentsJson: '{"callerRunId":"root"}' },
      "caller",
    ).pipe(Effect.provideService(SubagentService, subagentServiceDouble({})), Effect.result);
    expect(Result.isFailure(result) && result.failure).toMatchObject({
      code: "proxy_request_invalid",
    });
  });
});

describe("private fleet actions", () => {
  it("preserves the captured assignment and question without widening action or caller authority", () => {
    const expected = captureSubagentControlExpectation(
      view({
        assignmentEpoch: 9,
        state: "waiting_for_parent",
        sessionId: "session-a",
        question: { requestId: "question-a", message: "Proceed?" },
      }),
    );
    const input = { tool: "subagent_reply", args: { runId: "child", message: "yes" } } as const;
    expect(decodeFleetActionRequest(encodeFleetActionRequest(input, expected))).toEqual({
      input,
      expected,
    });
    for (const request of [
      {
        tool: "subagent_send",
        argumentsJson: JSON.stringify({ runIds: ["first", "second"], message: "hi" }),
      },
      {
        tool: "subagent_lifecycle",
        argumentsJson: JSON.stringify({ action: "retry", runIds: ["child"] }),
      },
      { tool: "subagent_status", argumentsJson: JSON.stringify({ runIds: ["child"] }) },
    ]) {
      expect(
        decodeFleetActionRequest({
          tool: FLEET_ACTION_TOOL_NAME,
          argumentsJson: JSON.stringify({ request, expected }),
        }),
      ).toBeInstanceOf(InvalidSubagentRequestError);
    }
    expect(
      decodeFleetActionRequest({
        tool: FLEET_ACTION_TOOL_NAME,
        argumentsJson: JSON.stringify({
          request: { tool: input.tool, argumentsJson: JSON.stringify(input.args) },
          expected,
          callerRunId: "root",
        }),
      }),
    ).toBeInstanceOf(InvalidSubagentRequestError);
  });
});
