import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { HerdrClientShape } from "../boundary/herdr-client.ts";
import type { ReportChannelShape } from "../boundary/report-channel.ts";
import { matchesOwnedAgent, remoteState } from "./coordination.ts";
import { isHerdrAgentFinished, type HerdrAgentView } from "./model.ts";

const REPORT_GRACE_MILLIS = 15_000;
const STARTING_GRACE_MILLIS = 60_000;

export interface HerdrRefreshResult {
  readonly changed: boolean;
  readonly evictedIds: ReadonlyArray<string>;
}

const trimRetention = (
  records: Map<string, HerdrAgentView>,
  maximum: number,
): ReadonlyArray<string> => {
  const terminal = [...records.values()]
    .filter((run) => isHerdrAgentFinished(run.state))
    .sort((left, right) => right.updatedAt - left.updatedAt);
  const evictedIds = terminal.slice(maximum).map((run) => run.id);
  for (const id of evictedIds) records.delete(id);
  return evictedIds;
};

export const refreshHerdrRecords = Effect.fn("HerdrReconcile.refresh")(function* (input: {
  readonly client: HerdrClientShape;
  readonly reports: ReportChannelShape;
  readonly records: Map<string, HerdrAgentView>;
  readonly maxRetained: number;
}) {
  const remoteOption = yield* input.client.listAgents.pipe(Effect.option);
  const remoteAgents = Option.isSome(remoteOption) ? remoteOption.value : [];
  const now = yield* Clock.currentTimeMillis;
  let changed = false;

  for (const current of input.records.values()) {
    const reportOption =
      current.state === "stopped"
        ? Option.none()
        : yield* input.reports.read(current.id).pipe(Effect.option);
    if (Option.isSome(reportOption) && reportOption.value !== undefined) {
      const report = reportOption.value;
      const submittedAt = report.submittedAt;
      if (current.report !== report.report) {
        const state =
          report.status === "completed"
            ? "completed"
            : report.status === "failed"
              ? "failed"
              : "blocked";
        input.records.set(current.id, {
          ...current,
          state,
          report: report.report,
          ...(report.status === "failed" ? { error: report.report } : {}),
          updatedAt: submittedAt,
          ...(state === "completed" || state === "failed" ? { completedAt: submittedAt } : {}),
        });
        changed = true;
      }
      continue;
    }
    if (isHerdrAgentFinished(current.state)) continue;

    const remote = remoteAgents.find((candidate) => matchesOwnedAgent(current, candidate));
    const observedState = remote ? remoteState(remote.agentStatus) : "unknown";
    const nextState =
      current.state === "starting" &&
      (remote?.agentStatus === "idle" || remote?.agentStatus === "done") &&
      now - current.updatedAt < STARTING_GRACE_MILLIS
        ? "starting"
        : observedState;
    const timedOutReport =
      current.state === "awaiting_report" && now - current.updatedAt >= REPORT_GRACE_MILLIS;
    const state = timedOutReport ? "failed" : nextState;
    const error = timedOutReport
      ? "The managed agent settled without submitting its final report. Inspect or stop the managed pane."
      : current.error;
    if (
      current.state !== state ||
      current.remoteStatus !== remote?.agentStatus ||
      current.error !== error
    ) {
      input.records.set(current.id, {
        ...current,
        state,
        remoteStatus: remote?.agentStatus,
        ...(remote ? { terminalId: remote.terminalId } : {}),
        ...(error ? { error } : {}),
        updatedAt: now,
        ...(state === "failed" ? { completedAt: now } : {}),
      });
      changed = true;
    }
  }

  return {
    changed,
    evictedIds: changed ? trimRetention(input.records, input.maxRetained) : [],
  } satisfies HerdrRefreshResult;
});
