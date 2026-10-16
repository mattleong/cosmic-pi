import { absurd } from "effect/Function";
import { countLabel } from "pi-cosmic-core";
import type { SubagentRunView } from "../run/model.ts";
import { runStateLabel } from "../ui/run-state.ts";
import { cleanupEvidenceText, cleanupRecoveryText, formatRun } from "./format.ts";
import type { SubagentToolAction } from "./schema.ts";

const stopAcknowledgement = (run: SubagentRunView): string => {
  const task = `${run.id}: task state is ${runStateLabel(run.state)}.`;
  const disposition = run.cleanup?.disposition;
  switch (disposition) {
    case "confirmed":
      return [`${task} Cleanup is confirmed for this run.`, ...cleanupRecoveryText(run)].join("\n");
    case "pending":
      return `${task} Cleanup verification is still pending.`;
    case "quarantined":
      return [task, ...cleanupRecoveryText(run)].join("\n");
    case undefined:
      return `${task} Cleanup verification is unknown in this observation; terminal state does not confirm cleanup.`;
  }
  return absurd(disposition);
};

const claimsAcknowledgement = (
  runs: ReadonlyArray<SubagentRunView>,
  claimsAction: "list" | "grant" | "revoke" | "resume_admission" | undefined,
): string => {
  const contained =
    claimsAction === "resume_admission" || runs.some((run) => run.writeAdmissionPaused === true);
  return [
    ...runs.flatMap((run) => [
      `${run.id}: ${run.writeClaims?.length ? run.writeClaims.join(", ") : run.writeIntent === "writer" ? "exclusive writer" : "read-only"}${run.writeAdmissionPaused ? " · claim admission paused" : ""}`,
      cleanupRecoveryText(run).join("\n") || cleanupEvidenceText(run),
    ]),
    runs.some((run) => run.cleanup?.disposition === "quarantined" || run.writerCleanupQuarantined)
      ? "Cleanup quarantine is separate from claim containment. Resolve cleanup before claim recovery or writer reuse."
      : contained
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
