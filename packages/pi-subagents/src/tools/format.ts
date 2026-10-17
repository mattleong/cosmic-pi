import { absurd } from "effect/Function";
import {
  isOffenderOnlyContainment,
  runAttention,
  runCleanupAttention,
  type AttentionRun,
} from "../run/attention.ts";
import {
  sanitizeTerminalLine,
  sanitizeDiagnosticContent,
  stripTerminalControls as sanitizeTerminalText,
  synchronousNow,
  countLabel,
} from "pi-cosmic-core";
import {
  normalizeWriteClaim,
  OUTSIDE_WORKSPACE_WRITE_CLAIM_MARKER,
  writeClaimContains,
} from "../domain/write-claims.ts";
import {
  isParentActionRequiredRun,
  isTerminalRunState,
  hasUnresolvedSteeringDelivery,
  type SubagentRunView,
} from "../run/model.ts";
import { MAX_TOOL_OUTPUT_CHARS } from "../run/limits.ts";
import type { SubagentRunObservation } from "../run/service.ts";
import { clipWithMarker } from "../run/state.ts";
import { aggregateUsage } from "../ui/metrics.ts";
import { formatRunRoute, formatSessionActivity, formatSessionAge } from "../ui/run-presentation.ts";
import { runStateLabel } from "../ui/run-state.ts";
import type { SubagentActionFailure, SubagentStartFailure } from "./model.ts";
import type { SubagentToolAction } from "./schema.ts";
import {
  actionFailureDisposition,
  NO_ELIGIBLE_ROUTE_CODES,
  noEligibleRouteRecovery,
  pendingDeliveryEvidence,
  steeringDeliveryEvidence,
  unconfirmedActionRecovery,
  type ActionFailureDisposition,
} from "./outcome.ts";

export const boundToolOutput = (text: string): string =>
  clipWithMarker(
    text,
    MAX_TOOL_OUTPUT_CHARS,
    "\n… [tool output truncated; narrow the request or query individual run IDs for the omitted content]",
  );

export const joinBoundedToolText = (parts: ReadonlyArray<string>): string =>
  boundToolOutput(parts.filter(Boolean).join("\n\n"));

export const boundedLine = (value: string, maximum: number): string =>
  clipWithMarker(sanitizeTerminalLine(value), maximum, "… [truncated]");

const runTarget = (run: AttentionRun): string =>
  `${sanitizeTerminalLine(run.name)} (${sanitizeTerminalLine(run.id)})`;

const claimViolationPaths = (run: AttentionRun): ReadonlyArray<string> => [
  ...new Set(run.writeAudit?.violations.map((violation) => violation.path)),
];

const grantableClaimPath = (path: string): string | undefined => {
  const normalized = normalizeWriteClaim(path);
  return normalized.ok ? normalized.claims[0] : undefined;
};

const safeMissingClaimPaths = (run: AttentionRun): ReadonlyArray<string> =>
  claimViolationPaths(run).flatMap((path) => {
    const claim = grantableClaimPath(path);
    return claim && !writeClaimContains(run.writeClaims ?? [], claim) ? [claim] : [];
  });

export const OUTSIDE_WORKSPACE_RESUME_GUIDANCE =
  "Writes outside the workspace aren't allowed; system temporary directories such as /tmp are fine. Continue only within your claims.";

const offenderOnlyContainmentRecovery = (run: AttentionRun): ReadonlyArray<string> => {
  const id = JSON.stringify(run.id);
  const header = `Containment for ${runTarget(run)} after a write outside the workspace. Its peers and writer admission are unaffected.`;
  const resume = `subagent_lifecycle({ action: "resume", runIds: [${id}], message: ${JSON.stringify(OUTSIDE_WORKSPACE_RESUME_GUIDANCE)} })`;
  const stop = `subagent_lifecycle({ action: "stop", runIds: [${id}] })`;
  if (runCleanupAttention(run) !== undefined)
    return [
      header,
      "Recovery waits until process cleanup is confirmed. Review the audit separately.",
    ];
  if (isTerminalRunState(run.state))
    return [
      header,
      "The offender is terminal. Review its write audit; no claim recovery is needed.",
    ];
  if (!run.capabilities.includes("resume"))
    return [
      header,
      "This backend cannot resume, so containment is stopping it.",
      `1. Confirm it reaches terminal: subagent_status({ runIds: [${id}] }). If it is still active, check again; do not issue a duplicate stop.`,
      "2. Review its write audit. If the work is still needed, launch a corrected replacement with exact workspace-relative claims and await its run ID.",
    ];
  if (run.state !== "paused")
    return [
      header,
      `Containment is in progress while the offender is ${runStateLabel(run.state)}.`,
      `1. Wait for containment to reach paused or terminal, then inspect it: subagent_status({ runIds: [${id}] }).`,
      `2. If paused, review the audit, then resume it with guidance: ${resume}, and await it. Or stop it: ${stop}.`,
      "3. If status is still active, check again. Do not issue a duplicate stop solely because the paused state has not published yet.",
    ];
  return [
    header,
    `1. Review the audit: subagent_status({ runIds: [${id}] }).`,
    `2. Resume it with guidance: ${resume}. Or stop it: ${stop}.`,
    `3. Await it again: subagent_await({ runIds: [${id}], until: "all_finished" }).`,
  ];
};

const claimContainmentRecovery = (run: AttentionRun): ReadonlyArray<string> => {
  if (isOffenderOnlyContainment(run)) return offenderOnlyContainmentRecovery(run);
  const id = JSON.stringify(run.id);
  const paths = claimViolationPaths(run);
  const audit = paths.map((path) => sanitizeTerminalLine(path)).join(", ");
  const safeMissing = safeMissingClaimPaths(run);
  const ungrantablePaths = paths.filter((path) => grantableClaimPath(path) === undefined);
  const hasUngrantablePath = ungrantablePaths.length > 0;
  // Outside-workspace writes can't collide with peers, so guidance can still recover the run.
  const resumableAudit = ungrantablePaths.every(
    (path) => path === OUTSIDE_WORKSPACE_WRITE_CLAIM_MARKER,
  );
  const canResume = run.state === "paused" && run.capabilities.includes("resume");
  const terminal = isTerminalRunState(run.state);
  const header = `Claim containment for ${runTarget(run)} after: ${audit || "an out-of-claim write"}.`;
  if (runCleanupAttention(run) !== undefined)
    return [
      header,
      "Claim recovery remains blocked until process and writer cleanup is confirmed. Review the audit separately; cleanup quarantine is not a claim-admission pause.",
    ];
  if (run.state !== "paused" && !terminal)
    return [
      header,
      `Containment is in progress while the offender is ${runStateLabel(run.state)}.`,
      `1. Wait for containment to reach paused or terminal, then inspect it: subagent_status({ runIds: [${id}] }).`,
      `2. If status is paused and resume is supported, review the audit, grant only intended workspace-relative missing claims, reopen admission with subagent_claims({ action: "resume_admission", runId: ${id} }), then resume and await the offender.`,
      `3. If status is terminal, confirm process and writer cleanup before subagent_claims({ action: "resume_admission", runId: ${id} }), then launch and await a corrected replacement.`,
      "4. If status is still active, check again. Do not issue a duplicate stop solely because the paused state has not published yet.",
    ];
  if (canResume && resumableAudit) {
    const grantStep =
      safeMissing.length > 0
        ? `2. If the missing files are intended and conflict-free, grant them: subagent_claims({ action: "grant", runId: ${id}, paths: ${JSON.stringify(safeMissing)} }). Otherwise skip this step.`
        : "2. Keep the current claims unless the audit proves another workspace-relative file is intended and conflict-free.";
    return [
      header,
      `1. Review the audit and shared tree: subagent_status({ runIds: [${id}] }).`,
      grantStep,
      `3. Reopen writer admission: subagent_claims({ action: "resume_admission", runId: ${id} }).`,
      `4. Resume with the authoritative claims and guidance: subagent_lifecycle({ action: "resume", runIds: [${id}], message: ${JSON.stringify(
        hasUngrantablePath
          ? `${OUTSIDE_WORKSPACE_RESUME_GUIDANCE} Use the authoritative claims returned by subagent_claims.`
          : "Use the authoritative claims returned by subagent_claims. Continue only within them.",
      )} }).`,
      `5. Await this run again: subagent_await({ runIds: [${id}], until: "all_finished" }).`,
    ];
  }
  const stopStep = terminal
    ? "2. The offender is terminal. Confirm process and writer cleanup before reopening admission."
    : `2. Stop the paused offender and wait for cleanup: subagent_lifecycle({ action: "stop", runIds: [${id}] }).`;
  const replacementClaims = [...new Set([...(run.writeClaims ?? []), ...safeMissing])];
  return [
    header,
    `1. Review the audit and shared tree: subagent_status({ runIds: [${id}] }).`,
    stopStep,
    `3. After cleanup is confirmed, reopen writer admission: subagent_claims({ action: "resume_admission", runId: ${id} }).`,
    hasUngrantablePath
      ? "4. Launch a corrected replacement with subagent_start only after narrowing the task to workspace-relative files. Supply exact writes, and do not copy outside-workspace or absolute paths into claims."
      : `4. Launch a corrected replacement with subagent_start and reviewed exact writes${replacementClaims.length > 0 ? ` such as ${JSON.stringify(replacementClaims)}` : ""}.`,
    "5. Await the replacement run ID with subagent_await.",
  ];
};

const ordinaryPauseRecovery = (run: AttentionRun): ReadonlyArray<string> => {
  const id = JSON.stringify(run.id);
  if (run.capabilities.includes("resume"))
    return [
      `Paused run ${runTarget(run)} needs a parent decision.`,
      `1. Review it: subagent_status({ runIds: [${id}] }).`,
      `2. Resume it with guidance: subagent_lifecycle({ action: "resume", runIds: [${id}], message: "Continue with the reviewed guidance." }).`,
      `3. Await it again: subagent_await({ runIds: [${id}], until: "all_finished" }).`,
    ];
  return [
    `Paused run ${runTarget(run)} cannot resume on its backend.`,
    `1. Stop it: subagent_lifecycle({ action: "stop", runIds: [${id}] }).`,
    "2. Launch a corrected replacement with subagent_start after cleanup is confirmed.",
    "3. Await the replacement run ID with subagent_await.",
  ];
};

const pausedAdmissionPeerRecovery = (run: AttentionRun): ReadonlyArray<string> => {
  const header = `Writer admission is paused for ${runTarget(run)} because its cwd pool is under claim containment.`;
  if (runCleanupAttention(run) !== undefined)
    return [
      header,
      "Claim recovery also waits for independent cleanup verification. Inspect the recorded offender's write audit without changing this peer's claims.",
    ];
  return [
    header,
    "1. Inspect subagent_list and the paused or stopped offender's subagent_status write audit.",
    "2. Do not change this peer's claims. Contain or clean up the recorded offender first.",
    "3. Use resume_admission only after every offender is paused or terminal, then continue or await this peer.",
  ];
};

export const cleanupEvidenceText = (
  run: Pick<AttentionRun, "cleanup" | "writerCleanupQuarantined">,
): string => {
  const cleanup = run.cleanup;
  return [
    cleanup === undefined ? undefined : `Cleanup verification: ${cleanup.disposition}`,
    cleanup?.diagnostic === undefined
      ? undefined
      : [
          cleanup.diagnostic.phase,
          cleanup.diagnostic.code === undefined
            ? undefined
            : sanitizeDiagnosticContent(cleanup.diagnostic.code, { maximumLength: 80 }),
          sanitizeDiagnosticContent(cleanup.diagnostic.message, { maximumLength: 1_024 }),
        ]
          .filter(Boolean)
          .join(" · "),
    run.writerCleanupQuarantined === true
      ? "Writer pool is quarantined by unconfirmed cleanup"
      : undefined,
  ]
    .filter(Boolean)
    .join("\n");
};

export const cleanupRecoveryText = (run: AttentionRun): ReadonlyArray<string> => {
  const attention = runCleanupAttention(run);
  if (attention === undefined) return [];
  const evidence = cleanupEvidenceText(run);
  if (attention === "pool-quarantined")
    return [
      `Writer admission for ${runTarget(run)} is blocked by cleanup quarantine, independently of claim containment.`,
      evidence,
      "Inspect subagent_list and the quarantined run's full subagent_status. Recover that run's cleanup; do not stop healthy peers or change their claims to clear the pool.",
    ];
  if (attention === "pending")
    return [
      `Cleanup verification is pending for ${runTarget(run)}.`,
      evidence,
      "Wait for cleanup verification before retrying or reusing writer resources; terminal task state is not confirmation.",
    ];
  return [
    `Cleanup is unconfirmed for ${runTarget(run)}; its task outcome and accepted report are unchanged.`,
    evidence,
    run.cleanup?.recovery === "stop"
      ? `Request observational cleanup verification with subagent_lifecycle({ action: "stop", runIds: [${JSON.stringify(run.id)}] }). This also stops any active descendants. Only confirmed cleanup releases held resources.`
      : "Manual inspection is required. Cleanup cannot safely be reverified automatically; do not retry, delete leases, or reuse held resources.",
  ];
};

export const attentionRecoveryText = (runs: ReadonlyArray<AttentionRun>): string => {
  const attention = runs.filter(
    (run) =>
      isParentActionRequiredRun(run) ||
      run.writeViolationOffender === true ||
      runCleanupAttention(run) !== undefined,
  );
  if (attention.length === 0) return "";
  const parentActionRequired = attention.some(isParentActionRequiredRun);
  return [
    parentActionRequired
      ? "Parent action required; other unfinished subagents continue independently."
      : "Recovery verification is still in progress; other unfinished subagents continue independently.",
    ...attention.flatMap((run) => {
      const state = runAttention(run);
      const cleanup = cleanupRecoveryText(run);
      const claim = ((): ReadonlyArray<string> => {
        switch (state?.kind) {
          case "containment":
            return claimContainmentRecovery(run);
          case "admission-paused":
            return pausedAdmissionPeerRecovery(run);
          case "paused":
            return runCleanupAttention(run) === undefined ? ordinaryPauseRecovery(run) : [];
          case "question":
            return [
              `Question from ${sanitizeTerminalLine(run.name)}: ${boundedLine(state.message, 512)}`,
              `Reply with subagent_reply({ runId: ${JSON.stringify(run.id)}, message: "..." }), then call subagent_await again.`,
            ];
          case "question-unavailable":
          case undefined:
            return [];
        }
        return absurd(state);
      })();
      return claim.concat(cleanup);
    }),
  ].join("\n");
};

const statusField = (label: string, value: string): string =>
  `  ${label.padEnd(10)} ${sanitizeTerminalLine(value)}`;

const optionalStatusField = (label: string, value: string | undefined): string | undefined =>
  value ? statusField(label, value) : undefined;

const formatRunHeader = (run: SubagentRunView, route: string): string => {
  const profile = run.profile ? ` · profile=${sanitizeTerminalLine(run.profile)}` : "";
  const tree = run.depth
    ? ` · depth=${run.depth} · children=${run.directChildCount ?? 0}/${run.descendantCount ?? 0}`
    : "";
  const native = run.nativeActivity
    ? ` · native=${run.nativeActivity.active}/${run.nativeActivity.total}`
    : "";
  const workspace = run.writerWorkspaceMode
    ? ` · workspace=${run.writerWorkspaceMode}${run.workspaceId ? `:${sanitizeTerminalLine(run.workspaceId)}` : ""}`
    : "";
  const steering = run.steeringDelivery ? ` · steeringDelivery=${run.steeringDelivery}` : "";
  return `${sanitizeTerminalLine(run.id)} ${sanitizeTerminalLine(run.name)} · ${runStateLabel(run.state)} · ${run.writeIntent}${profile} · ${route}${tree}${native}${workspace}${steering}`;
};

const identityStatusFields = (
  run: SubagentRunView,
  route: string,
): ReadonlyArray<string | undefined> => [
  "Subagent status",
  statusField("Name", run.name),
  statusField("ID", run.id),
  statusField("State", runStateLabel(run.state)),
  optionalStatusField("Parent", run.parentRunId),
  run.depth === undefined
    ? undefined
    : statusField(
        "Tree",
        `depth ${run.depth} · ${run.directChildCount ?? 0} direct · ${run.descendantCount ?? 0} descendants`,
      ),
  optionalStatusField("Profile", run.profile),
  statusField("Route", route),
  statusField("Retention", `close after report · assignment ${run.reportGeneration || 1}`),
];

const routeRetryStatus = (run: SubagentRunView): string | undefined => {
  if (hasUnresolvedSteeringDelivery(run))
    return statusField(
      "Route retry",
      "blocked by unresolved guidance delivery; do not retry or launch a replacement automatically",
    );
  if (run.retryBlocked)
    return statusField(
      "Route retry",
      "blocked by uncertain execution or cleanup; inspect manually",
    );
  if (run.retryExhausted)
    return statusField("Route retry", "exhausted; only now consider a generalist replacement");
  const remaining = run.remainingCandidateCount ?? 0;
  if (remaining === 0 || run.state !== "failed") return undefined;
  return statusField(
    "Route retry",
    `${remaining} candidate${remaining === 1 ? " remains" : "s remain"}; use subagent_lifecycle action=retry`,
  );
};

const selectionStatusFields = (run: SubagentRunView): ReadonlyArray<string | undefined> => [
  statusField(
    "Selection",
    `${run.selection.source}${run.selection.candidateIndex === undefined ? "" : ` candidate ${run.selection.candidateIndex + 1}`}`,
  ),
  optionalStatusField("Route source", run.selection.routeSource),
  statusField("Reason", run.selection.reason),
  optionalStatusField("Predecessor", run.predecessorRunId),
  optionalStatusField("Superseded by", run.supersededByRunId),
  routeRetryStatus(run),
  ...run.selection.skippedCandidates.map((candidate) =>
    statusField(
      "Skipped",
      `${candidate.candidateIndex === undefined ? "route" : `candidate ${candidate.candidateIndex + 1}`} [${candidate.code}]: ${candidate.reason}`,
    ),
  ),
  optionalStatusField("Route warning", run.selection.warning),
];

const writeStatusFields = (run: SubagentRunView): ReadonlyArray<string | undefined> => {
  const audit = run.writeAudit;
  return [
    statusField("Context", run.context),
    statusField("Intent", run.writeIntent),
    optionalStatusField("Workspace mode", run.writerWorkspaceMode),
    optionalStatusField("Workspace ID", run.workspaceId),
    statusField("Cwd", run.cwd),
    optionalStatusField("Source cwd", run.sourceCwd),
    run.workspaceId
      ? statusField(
          "Proposal",
          `Use subagent_workspace review with workspaceId=${run.workspaceId} after process cleanup. Inspect ALL immutable diff pages, prepare combined changes, run relevant tests in the prepared cwd, then integrate the exact revisionId and preparationId. A report does not approve integration.`,
        )
      : undefined,
    run.writeIntent === "writer"
      ? statusField("Writes", (run.writeClaims?.join(", ") ?? "") || "exclusive whole cwd")
      : undefined,
    run.writeAdmissionPaused ? statusField("Admission", "paused after claim violation") : undefined,
    run.writeViolationOffender
      ? statusField("Containment", "current violation offender")
      : undefined,
    audit
      ? statusField(
          "Write audit",
          `${countLabel(audit.observedFileWrites.length, "native file path")} observed · ${countLabel(audit.violations.length, "violation")} · ${countLabel(audit.bashWriteHints, "Bash heuristic notice")}`,
        )
      : undefined,
    statusField(
      "Capabilities",
      `${run.capabilities.join(", ") || "none"}; stop/await always available`,
    ),
  ];
};

const activityStatusFields = (run: SubagentRunView): ReadonlyArray<string | undefined> => {
  const now = synchronousNow();
  const elapsed = formatSessionAge(run.endedAt ?? now, run.startedAt) || undefined;
  const activity = formatSessionActivity(now, run.lastActivityAt) || undefined;
  const usage = aggregateUsage([run]);
  const native = run.nativeActivity;
  return [
    run.pid ? statusField("Process", `pid ${run.pid}`) : undefined,
    optionalStatusField("Elapsed", elapsed),
    optionalStatusField("Activity", activity),
    optionalStatusField("Usage", usage),
    native
      ? statusField(
          "Native",
          `${native.active} active · ${native.total} total${native.latest ? ` · latest ${native.latest.kind} ${native.latest.state}` : ""}`,
        )
      : undefined,
    run.steeringDelivery
      ? statusField(
          "Steering",
          `steeringDelivery=${run.steeringDelivery}. ${steeringDeliveryEvidence[run.steeringDelivery].detail}`,
        )
      : undefined,
    optionalStatusField("Current tool", run.currentTool),
    optionalStatusField("Progress", run.progress),
    optionalStatusField("Warning", run.warning),
    run.question ? statusField("Needs reply", run.question.message) : undefined,
    optionalStatusField("Failure", run.error),
  ];
};

const finalReportStatus = (run: SubagentRunView): string | undefined => {
  if (run.finalText) return `\nFinal report\n${sanitizeTerminalText(run.finalText)}`;
  if (run.reportStatus === "missing")
    return "\nFinal report\nMissing: no accepted final report for this assignment.";
  if (run.reportStatus === "claimed")
    return "\nFinal report\nClaimed by another operation; report text is withheld here.";
  if (run.reportStatus === "delivered")
    return "\nFinal report\nAlready delivered; report text is withheld here.";
  if (run.state !== "completed") return undefined;
  return "\nFinal report\nAvailability unknown in this observation; report text is not included.";
};

export const formatRun = (run: SubagentRunView, detailed = false): string => {
  const route = formatRunRoute(run);
  const header = formatRunHeader(run, route);
  if (!detailed) return header;
  return [
    ...identityStatusFields(run, route),
    ...selectionStatusFields(run),
    ...writeStatusFields(run),
    cleanupEvidenceText(run) || undefined,
    ...activityStatusFields(run),
    finalReportStatus(run),
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
};

interface DetailedRunsFormat {
  readonly text: string;
  readonly fullyRenderedIds: ReadonlySet<string>;
}

export const formatDetailedRuns = (
  runs: ReadonlyArray<SubagentRunView>,
  prefix = "",
): DetailedRunsFormat => {
  if (runs.length === 0)
    return { text: prefix || "No subagent runs.", fullyRenderedIds: new Set() };
  const separatorLength = Math.max(0, runs.length - 1) * 2;
  const available = Math.max(0, MAX_TOOL_OUTPUT_CHARS - prefix.length - separatorLength);
  const perRun = Math.max(256, Math.floor(available / runs.length));
  const fullyRenderedIds = new Set<string>();
  const formatted = runs.map((run) => {
    const value = formatRun(run, true);
    if (value.length <= perRun) {
      fullyRenderedIds.add(run.id);
      return value;
    }
    return clipWithMarker(value, perRun, "\n… [run output truncated]");
  });
  const output = `${prefix}${formatted.join("\n\n")}`;
  if (output.length <= MAX_TOOL_OUTPUT_CHARS) return { text: output, fullyRenderedIds };
  return {
    text: clipWithMarker(
      output,
      MAX_TOOL_OUTPUT_CHARS,
      "\n… [additional run output omitted; query individual run IDs]",
    ),
    fullyRenderedIds: new Set(),
  };
};

type FailedStartRecovery = NonNullable<SubagentStartFailure["admittedRun"]>;

export const formatFailedStartRecovery = (recovery: FailedStartRecovery): string => {
  const remaining = recovery.hasRemainingCandidate
    ? ` · ${countLabel(recovery.remainingCandidateCount, "candidate")} remains`
    : " · no candidate remains";
  return `admitted ${sanitizeTerminalLine(recovery.runId)} · cleanup ${recovery.cleanupDisposition} · retry ${recovery.retryDisposition}${remaining}`;
};

export const failedStartRecoveryAction = (recovery: FailedStartRecovery): string => {
  switch (recovery.retryDisposition) {
    case "eligible":
      return `Continue with subagent_lifecycle({ action: "retry", runIds: [${JSON.stringify(recovery.runId)}] }).`;
    case "pending":
      return "Cleanup is still settling; do not retry until an eligible disposition is returned.";
    case "blocked":
      return "Do not retry automatically; ownership or execution outcome is uncertain.";
    case "exhausted":
      return "The frozen profile route is exhausted; only now consider a generalist replacement.";
    case "unavailable":
      return "This run has no frozen route continuation; start a new profiled run if appropriate.";
  }
  return absurd(recovery.retryDisposition);
};

const formatStartFailures = (failures: ReadonlyArray<SubagentStartFailure>): string =>
  failures.length === 0
    ? ""
    : [
        `Failed starts (${failures.length})`,
        ...failures.map((failure) => {
          const target = failure.name ? ` ${sanitizeTerminalLine(failure.name)}` : "";
          const message = boundedLine(failure.message, 2_048);
          const code = failure.code ? ` [${sanitizeTerminalLine(failure.code)}]` : "";
          const recovery = failure.admittedRun;
          const noEligibleRoute = NO_ELIGIBLE_ROUTE_CODES.includes(failure.code ?? "");
          return [
            `  #${failure.index + 1}${target}${code}: ${message}`,
            recovery ? `    ${formatFailedStartRecovery(recovery)}` : undefined,
            recovery ? `    Next: ${failedStartRecoveryAction(recovery)}` : undefined,
            !recovery && noEligibleRoute ? `    Next: ${noEligibleRouteRecovery}` : undefined,
          ]
            .filter((line): line is string => line !== undefined)
            .join("\n");
        }),
      ].join("\n");

export const formatStartResult = (
  runs: ReadonlyArray<SubagentRunView>,
  failures: ReadonlyArray<SubagentStartFailure>,
): string => {
  const failureText = formatStartFailures(failures);
  return formatDetailedRuns(
    runs,
    failureText ? `${failureText}${runs.length > 0 ? "\n\n" : ""}` : "",
  ).text;
};

const actionFailureLine = (failure: SubagentActionFailure): string => {
  const code = failure.code ? ` [${sanitizeTerminalLine(failure.code)}]` : "";
  return `  ${sanitizeTerminalLine(failure.id)}${code}: ${boundedLine(failure.message, 320)}`;
};

export const ACTION_FAILURE_SECTIONS = [
  ["pending", "Guidance awaiting confirmation", pendingDeliveryEvidence.detail],
  ["unconfirmed", "Unconfirmed targets", unconfirmedActionRecovery],
  ["failed", "Failed targets", undefined],
] as const satisfies ReadonlyArray<readonly [ActionFailureDisposition, string, string | undefined]>;

export const formatActionFailures = (
  action: SubagentToolAction,
  failures: ReadonlyArray<SubagentActionFailure>,
): string =>
  ACTION_FAILURE_SECTIONS.flatMap(([disposition, title, guidance]) => {
    const entries = failures.filter(
      (failure) => actionFailureDisposition(action, failure) === disposition,
    );
    if (entries.length === 0) return [];
    return [
      [
        `${title} (${entries.length})`,
        ...entries.map(actionFailureLine),
        ...(guidance ? [`  ${guidance}`] : []),
      ].join("\n"),
    ];
  }).join("\n\n");

export const renderedCompletionReceipts = (
  observations: ReadonlyArray<SubagentRunObservation>,
  fullyRenderedIds: ReadonlySet<string>,
) =>
  observations.flatMap((observation) =>
    observation.completionReceipt && fullyRenderedIds.has(observation.run.id)
      ? [observation.completionReceipt]
      : [],
  );
