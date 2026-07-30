// Partial boundary fakes intentionally implement only the reconciliation surface.
// @effect-diagnostics effect/strictEffectProvide:off
import { it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { describe, expect } from "vitest";
import type { HerdrClientShape } from "../src/boundary/herdr-client.ts";
import type { ReportChannelShape } from "../src/boundary/report-channel.ts";
import type { HerdrAgentView, HerdrRemoteAgentInfo } from "../src/herd/model.ts";
import { refreshHerdrRecords } from "../src/herd/reconcile.ts";

const run = (state: HerdrAgentView["state"], updatedAt = 1): HerdrAgentView => ({
  id: "herdr-11111111-1111-4111-8111-111111111111",
  name: "Claude 1",
  agentName: "pih-test",
  task: "Review",
  cwd: "/repo",
  state,
  session: "default",
  workspaceId: "w1",
  tabId: "t1",
  paneId: "p1",
  terminalId: "term1",
  reportGeneration: "herdr-11111111-1111-4111-8111-111111111111",
  startedAt: updatedAt,
  updatedAt,
});

const remote = (agentStatus: HerdrRemoteAgentInfo["agentStatus"]): HerdrRemoteAgentInfo => ({
  paneId: "p1",
  terminalId: "term1",
  workspaceId: "w1",
  tabId: "t1",
  cwd: "/repo",
  focused: false,
  agentStatus,
  name: "pih-test",
  agent: "claude",
  stateChangeSeq: 1,
});

const clientWith = (agents: ReadonlyArray<HerdrRemoteAgentInfo>): HerdrClientShape =>
  ({ listAgents: Effect.succeed(agents) }) as unknown as HerdrClientShape;

const reportsWith = (read: ReportChannelShape["read"]): ReportChannelShape =>
  ({ read, remove: () => Effect.void }) as unknown as ReportChannelShape;

describe("Herdr reconciliation", () => {
  it.effect("ingests a durable report as authoritative completion", () =>
    Effect.gen(function* () {
      const records = new Map([[run("working").id, run("working")]]);
      const submittedAt = 42;
      const result = yield* refreshHerdrRecords({
        client: clientWith([remote("working")]),
        reports: reportsWith(() =>
          Effect.succeed({
            generation: run("working").id,
            status: "completed",
            report: "final report",
            submittedAt,
          }),
        ),
        records,
        maxRetained: 8,
      });

      expect(result.changed).toBe(true);
      expect(records.get(run("working").id)).toMatchObject({
        state: "completed",
        report: "final report",
        completedAt: submittedAt,
      });
    }),
  );

  it.effect("never resurrects an explicitly stopped run from a late report", () =>
    Effect.gen(function* () {
      const stopped = run("stopped");
      const records = new Map([[stopped.id, stopped]]);
      const result = yield* refreshHerdrRecords({
        client: clientWith([remote("working")]),
        reports: reportsWith(() =>
          Effect.succeed({
            generation: stopped.id,
            status: "completed",
            report: "late report",
            submittedAt: 42,
          }),
        ),
        records,
        maxRetained: 8,
      });

      expect(result.changed).toBe(false);
      expect(records.get(stopped.id)?.state).toBe("stopped");
      expect(records.get(stopped.id)?.report).toBeUndefined();
    }),
  );

  it.effect("does not churn a restored matching remote status", () =>
    Effect.gen(function* () {
      const restored = { ...run("working"), remoteStatus: "working" as const };
      const records = new Map([[restored.id, restored]]);
      const result = yield* refreshHerdrRecords({
        client: clientWith([remote("working")]),
        reports: reportsWith(() => Effect.succeed(undefined)),
        records,
        maxRetained: 8,
      });

      expect(result.changed).toBe(false);
      expect(records.get(restored.id)).toEqual(restored);
    }),
  );

  it.effect("clears stale remote status once without churning subsequent refreshes", () =>
    Effect.gen(function* () {
      const working = { ...run("working"), remoteStatus: "working" as const };
      const records = new Map([[working.id, working]]);
      const input = {
        client: clientWith([]),
        reports: reportsWith(() => Effect.succeed(undefined)),
        records,
        maxRetained: 8,
      };

      const first = yield* refreshHerdrRecords(input);
      const updatedAt = records.get(working.id)?.updatedAt;
      const second = yield* refreshHerdrRecords(input);

      expect(first.changed).toBe(true);
      expect(records.get(working.id)).toMatchObject({ state: "unknown" });
      expect(records.get(working.id)?.remoteStatus).toBeUndefined();
      expect(second.changed).toBe(false);
      expect(records.get(working.id)?.updatedAt).toBe(updatedAt);
    }),
  );

  it.effect("expires report grace after restoring a matching terminal remote status", () =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const awaiting = {
        ...run("awaiting_report", now - 16_000),
        remoteStatus: "done" as const,
      };
      const records = new Map([[awaiting.id, awaiting]]);
      const result = yield* refreshHerdrRecords({
        client: clientWith([remote("done")]),
        reports: reportsWith(() => Effect.succeed(undefined)),
        records,
        maxRetained: 8,
      });

      expect(result.changed).toBe(true);
      expect(records.get(awaiting.id)).toMatchObject({
        state: "failed",
        remoteStatus: "done",
      });
    }),
  );

  it.effect("keeps a freshly dispatched idle agent in starting grace", () =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const starting = run("starting", now);
      const records = new Map([[starting.id, starting]]);
      yield* refreshHerdrRecords({
        client: clientWith([remote("idle")]),
        reports: reportsWith(() => Effect.succeed(undefined)),
        records,
        maxRetained: 8,
      });

      expect(records.get(starting.id)?.state).toBe("starting");
    }),
  );
});
