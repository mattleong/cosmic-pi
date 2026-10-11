import type { WorkflowViewStatus } from "./attention.ts";
import { countWorkflowRunAgents, isWorkflowRunFinished, type WorkflowRunView } from "./model.ts";

export const WORKFLOW_STATUS_REPEAT_MS = 60_000;

export interface WorkflowUnchangedStatus {
  readonly kind: "unchanged";
  readonly run: WorkflowRunView;
  readonly sinceMs: number;
}

interface StatusSighting {
  readonly at: number;
  readonly facts: string | undefined;
}

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

export const makeWorkflowStatusRepeats = () => {
  const sightings = new Map<string, StatusSighting>();
  return {
    note: (status: WorkflowViewStatus, now: number): number | undefined => {
      const id = status.run.id;
      if (isWorkflowRunFinished(status.run.state)) {
        sightings.delete(id);
        return undefined;
      }
      const facts = materialFacts(status);
      const previous = sightings.get(id);
      for (const [runId, sighting] of sightings)
        if (now - sighting.at >= WORKFLOW_STATUS_REPEAT_MS) sightings.delete(runId);
      sightings.set(id, { at: now, facts });
      if (previous === undefined || facts === undefined || previous.facts !== facts)
        return undefined;
      const since = now - previous.at;
      return since >= 0 && since < WORKFLOW_STATUS_REPEAT_MS ? since : undefined;
    },
    forget: (runId: string) => {
      sightings.delete(runId);
    },
  };
};
