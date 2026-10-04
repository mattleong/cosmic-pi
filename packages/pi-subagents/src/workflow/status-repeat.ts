import type { WorkflowViewStatus } from "./attention.ts";
import { countWorkflowRunAgents, isWorkflowRunFinished, type WorkflowRunView } from "./model.ts";

/**
 * How soon after the main agent's status call for a live run another call, with nothing material
 * changed in between, gets a short answer instead of the full status. Polling can't make a run
 * finish sooner; its notification starts the main agent's next turn.
 */
export const WORKFLOW_STATUS_REPEAT_MS = 60_000;

/** A live run that the main agent's previous status call, `sinceMs` ago, already described. */
export interface WorkflowUnchangedStatus {
  readonly kind: "unchanged";
  readonly run: WorkflowRunView;
  readonly sinceMs: number;
}

/** What the main agent's last status call saw of a run, and when. */
interface StatusSighting {
  readonly at: number;
  /** The run's material facts then; undefined while something waited on a person. */
  readonly facts: string | undefined;
}

/** Agents by phase and state, in a stable order. */
const phaseCounts = (run: WorkflowRunView): ReadonlyArray<readonly [string, number]> => {
  const counts = new Map<string, number>();
  for (const agent of run.agents) {
    const key = `${agent.phase ?? ""}\u0000${agent.state}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
};

const queuedBehindPausedWriter = (run: WorkflowRunView): boolean =>
  run.agents.some(
    (agent) => agent.state === "queued" && agent.waiting?.kind === "writer" && agent.waiting.paused,
  );

/**
 * A live run's facts whose change makes the full status worth reading again: its state, current
 * phase and phases, its agents by state and by phase, reused results and planned agents. Usage,
 * durations and log lines change all the time, so they don't count. Undefined while something
 * waits on a person, which status always shows in full.
 */
const materialFacts = (status: WorkflowViewStatus): string | undefined => {
  const run = status.run;
  if (status.attention.length > 0 || queuedBehindPausedWriter(run)) return undefined;
  return JSON.stringify([
    run.state,
    run.currentPhase ?? null,
    run.phases.length,
    countWorkflowRunAgents(run),
    run.reused,
    run.planned.length,
    phaseCounts(run),
  ]);
};

/** The main agent's status calls per run, which decide when a repeat gets the short answer. */
export interface WorkflowStatusRepeats {
  /**
   * Notes the main agent's status call for a run this activation holds. Returns how long ago its
   * previous call was when the run is live, nothing waits on a person and nothing material changed
   * since that call, within {@link WORKFLOW_STATUS_REPEAT_MS}; undefined when the full status is due.
   */
  readonly note: (status: WorkflowViewStatus, now: number) => number | undefined;
  /** Drops what was noted about a run once it has ended. */
  readonly forget: (runId: string) => void;
}

export const makeWorkflowStatusRepeats = (): WorkflowStatusRepeats => {
  const sightings = new Map<string, StatusSighting>();
  return {
    note: (status, now) => {
      const id = status.run.id;
      if (isWorkflowRunFinished(status.run.state)) {
        sightings.delete(id);
        return undefined;
      }
      const facts = materialFacts(status);
      const previous = sightings.get(id);
      // A sighting older than the window can't shorten a repeat; dropping those bounds what a
      // run that ended while a status call was reading it leaves behind.
      for (const [runId, sighting] of sightings)
        if (now - sighting.at >= WORKFLOW_STATUS_REPEAT_MS) sightings.delete(runId);
      sightings.set(id, { at: now, facts });
      if (previous === undefined || facts === undefined || previous.facts !== facts)
        return undefined;
      const since = now - previous.at;
      return since >= 0 && since < WORKFLOW_STATUS_REPEAT_MS ? since : undefined;
    },
    forget: (runId) => {
      sightings.delete(runId);
    },
  };
};
