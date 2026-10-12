import { absurd } from "effect/Function";
import { countLabel } from "pi-cosmic-core";
import type { SubagentRunView } from "../run/model.ts";
import { runStateLabel } from "../ui/run-state.ts";
import { formatRun } from "./format.ts";
import type { SubagentToolAction } from "./schema.ts";

const stopAcknowledgement = (run: SubagentRunView): string => {
  switch (run.state) {
    case "stopped":
      return `${run.id} is stopped.`;
    case "completed":
      return `${run.id} was already finished; no stop was needed.`;
    case "failed":
      return `${run.id} had already failed; no stop was needed.`;
    case "stopping":
      return `Stop cleanup is still in progress for ${run.id}.`;
    case "starting":
    case "running":
    case "waiting_for_parent":
    case "paused":
    case "reported":
      return `Stop requested for ${run.id}; current state is ${runStateLabel(run.state)}.`;
  }
  return absurd(run.state);
};

const claimsAcknowledgement = (
  runs: ReadonlyArray<SubagentRunView>,
  claimsAction: "list" | "grant" | "revoke" | "resume_admission" | undefined,
): string => {
  const contained =
    claimsAction === "resume_admission" || runs.some((run) => run.writeAdmissionPaused === true);
  return [
    ...runs.map(
      (run) =>
        `${run.id}: ${run.writeClaims?.length ? run.writeClaims.join(", ") : run.writeIntent === "writer" ? "exclusive writer" : "read-only"}${run.writeAdmissionPaused ? " · admission paused" : ""}`,
    ),
    contained
      ? "Claim-containment recovery uses resume_admission, then lifecycle resume with the authoritative claims, or stop and replace when resume is unavailable. Do not use subagent_reply for containment."
      : "For a waiting worker, send the resulting authoritative claim set in subagent_reply before work continues.",
  ].join("\n");
};

export const managementAcknowledgement = (
  action: Exclude<SubagentToolAction, "models" | "start">,
  runs: ReadonlyArray<SubagentRunView>,
  claimsAction?: "list" | "grant" | "revoke" | "resume_admission",
): string => {
  if (runs.length === 0) return "";
  const ids = runs.map((run) => run.id).join(", ");
  switch (action) {
    case "send":
      return `Guidance delivered to ${countLabel(runs.length, "subagent")}: ${ids}.`;
    case "reply":
      return `Reply delivered to ${ids}.`;
    case "retry":
      return runs
        .map((run) =>
          run.predecessorRunId
            ? `Continued ${run.predecessorRunId} as ${run.id} on profile ${run.profile ?? "generalist"} candidate ${(run.selection.candidateIndex ?? 0) + 1}.`
            : `Started next profile candidate as ${run.id}.`,
        )
        .join("\n");
    case "interrupt":
      return `Interrupted ${ids}; state is paused.`;
    case "resume":
      return `Resumed ${ids}.`;
    case "rename":
      return runs.map((run) => `${run.id} renamed to ${run.name}.`).join("\n");
    case "stop":
      return runs.map(stopAcknowledgement).join("\n");
    case "claims":
      return claimsAcknowledgement(runs, claimsAction);
    case "list":
    case "status":
    case "await":
    case "workspace":
      return runs.map((run) => formatRun(run, true)).join("\n\n");
  }
  return absurd(action);
};
