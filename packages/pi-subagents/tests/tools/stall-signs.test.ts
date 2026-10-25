import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { MAIN_AGENT_ID } from "../../src/run/agent-messaging.ts";
import type { SubagentRunView, SubagentSessionEvent } from "../../src/run/model.ts";
import { decodeSubagentContract } from "../../src/tools/contract-schema.ts";
import { eventLoopTurn, step } from "../support/effect-test.ts";
import { subagentServiceDouble } from "./fixtures/subagent-service-double.ts";
import { captureSubagentTools, executeTool, view } from "./fixtures/tool-harness.ts";

const NOW = 60 * 60_000;
const MINUTE = 60_000;

const tool = (
  toolName: string,
  state: "running" | "completed" | "failed",
  startedAt: number,
): SubagentSessionEvent => ({
  type: "tool",
  toolCallId: `${toolName}-${startedAt}`,
  toolName,
  state,
  startedAt,
  ...(state !== "running" && { endedAt: startedAt + 1_000 }),
});

const running = (id: string, lastActivityAt: number, sessionEvents: SubagentSessionEvent[]) =>
  view({ id, name: id, state: "running", startedAt: 0, lastActivityAt, sessionEvents });

const RUNS: ReadonlyArray<SubagentRunView> = [
  running("agent-tool", NOW - 7 * MINUTE, [tool("bash", "running", NOW - 7 * MINUTE)]),
  running("agent-failing", NOW - 1_000, [
    tool("read", "failed", NOW - 30_000),
    tool("grep", "failed", NOW - 20_000),
    tool("edit", "failed", NOW - 10_000),
  ]),
  running("agent-idle", NOW - 3 * MINUTE, []),
  // A tool open for a few seconds is healthy, and an open tool isn't idleness.
  running("agent-healthy", NOW - 5_000, [tool("bash", "running", NOW - 5_000)]),
];

const service = subagentServiceDouble({
  agentList: () =>
    Effect.succeed({
      agents: [
        { id: MAIN_AGENT_ID, name: MAIN_AGENT_ID, kind: "main", state: "busy", self: true },
        ...Arr.map(RUNS, (run) => ({
          id: run.id,
          name: run.name,
          kind: "run" as const,
          state: run.state,
          parentId: MAIN_AGENT_ID,
          depth: 1,
          self: false,
          run,
        })),
      ],
      missingIds: [],
    }),
  agentRead: () =>
    Effect.succeed({
      agents: Arr.map(RUNS, (run) => ({
        kind: "run" as const,
        id: run.id,
        name: run.name,
        state: run.state,
        textStatus: "none" as const,
        truncated: false,
        reportGeneration: 0,
        run,
      })),
      missingIds: [],
    }),
  withAwaitTerminalObservations: (_ids, _until, onUpdate) =>
    Effect.sync(() => onUpdate?.(RUNS)).pipe(Effect.andThen(Effect.never)),
});

const toolsOnTestClock = Effect.gen(function* () {
  yield* TestClock.setTime(NOW);
  return captureSubagentTools(service, { clock: yield* Clock.Clock });
});

const stallsOf = (targets: ReadonlyArray<{ readonly stall?: unknown }>) =>
  Arr.map(targets, (target) => target.stall);

describe("stall signs in parent run views", () => {
  it.effect("agent_read and agent_list name each running run's stall sign", () =>
    Effect.gen(function* () {
      const tools = yield* toolsOnTestClock;
      const ids = Arr.map(RUNS, (run) => run.id);

      const read = yield* step(() => executeTool(tools.get("agent_read")!, { agentIds: ids }));
      const readContract = decodeSubagentContract("agent_read")(read.structuredContent);
      expect(
        stallsOf(
          Arr.flatMap(readContract?.agents ?? [], (agent) =>
            agent.kind === "run" ? [agent.status] : [],
          ),
        ),
      ).toEqual([
        { kind: "tool-open", tool: "bash", seconds: 420 },
        { kind: "failing-tools", count: 3 },
        { kind: "idle", seconds: 180 },
        undefined,
      ]);

      const list = yield* step(() => executeTool(tools.get("agent_list")!, {}));
      const listContract = decodeSubagentContract("agent_list")(list.structuredContent);
      expect(stallsOf(listContract?.agents ?? [])).toEqual([
        undefined,
        { kind: "tool-open", tool: "bash", seconds: 420 },
        { kind: "failing-tools", count: 3 },
        { kind: "idle", seconds: 180 },
        undefined,
      ]);
    }),
  );

  it.effect("a stall never ends a wait early; its timeout result names the stall", () =>
    Effect.gen(function* () {
      const tools = yield* toolsOnTestClock;
      const progress = Deferred.makeUnsafe<void>();
      let settled = false;
      const pending = executeTool(
        tools.get("agent_await")!,
        { runIds: Arr.map(RUNS, (run) => run.id), timeoutSeconds: 120 },
        { update: () => Deferred.doneUnsafe(progress, Effect.void) },
      ).finally(() => {
        settled = true;
      });
      yield* Deferred.await(progress);
      yield* TestClock.adjust(Duration.seconds(119));
      yield* step(eventLoopTurn);
      expect(settled).toBe(false);

      yield* TestClock.adjust(Duration.seconds(1));
      const result = yield* step(() => pending);
      const contract = decodeSubagentContract("agent_await")(result.structuredContent);
      expect(contract?.outcome).toBe("timed_out");
      expect(stallsOf(contract?.targets ?? [])).toEqual([
        { kind: "tool-open", tool: "bash", seconds: 540 },
        { kind: "failing-tools", count: 3 },
        { kind: "idle", seconds: 300 },
        undefined,
      ]);
    }),
  );
  it.effect("a cancelled wait names stall signs on the runtime's clock", () =>
    Effect.gen(function* () {
      const tools = yield* toolsOnTestClock;
      const progress = Deferred.makeUnsafe<void>();
      const controller = new AbortController();
      const pending = executeTool(
        tools.get("agent_await")!,
        { runIds: Arr.map(RUNS, (run) => run.id) },
        {
          signal: controller.signal,
          update: () => Deferred.doneUnsafe(progress, Effect.void),
        },
      );
      yield* Deferred.await(progress);
      controller.abort();
      const result = yield* step(() => pending);
      const contract = decodeSubagentContract("agent_await")(result.structuredContent);
      expect(contract?.outcome).toBe("cancelled");
      expect(stallsOf(contract?.targets ?? [])).toEqual([
        { kind: "tool-open", tool: "bash", seconds: 420 },
        { kind: "failing-tools", count: 3 },
        { kind: "idle", seconds: 180 },
        undefined,
      ]);
    }),
  );
});
