import {
  sanitizeTerminalLine,
  stripTerminalControls as sanitizeTerminalText,
  synchronousNow,
} from "pi-cosmic-core";
import { normalizeWriteClaim, writeClaimContains } from "../domain/write-claims.ts";
import type { SubagentSelectionProvenance } from "../profiles/model.ts";
import {
  isParentActionRequiredRun,
  isTerminalRunState,
  type SubagentRunView,
} from "../run/model.ts";
import { MAX_TOOL_OUTPUT_CHARS } from "../run/limits.ts";
import type { SubagentRunObservation } from "../run/service.ts";
import { clipWithMarker } from "../run/state.ts";
import { formatUsage } from "../ui/metrics.ts";
import { formatRunRoute, formatSessionAge } from "../ui/run-presentation.ts";
import { runStateLabel } from "../ui/run-state.ts";
import type { SubagentActionFailure, SubagentStartFailure } from "./model.ts";

export const selectionSourceLabel = (
  run: Pick<SubagentRunView, "selection"> | { readonly selection: SubagentSelectionProvenance },
): string => {
  const candidate =
    run.selection.candidateIndex === undefined
      ? ""
      : ` candidate ${run.selection.candidateIndex + 1}`;
  return `${run.selection.source}${candidate}`;
};

export const boundToolOutput = (text: string): string =>
  clipWithMarker(
    text,
    MAX_TOOL_OUTPUT_CHARS,
    "\n… [tool output truncated; narrow the request or query individual run IDs for the omitted content]",
  );

export const joinBoundedToolText = (parts: ReadonlyArray<string>): string =>
  boundToolOutput(parts.filter(Boolean).join("\n\n"));

interface AttentionRun {
  readonly id: string;
  readonly name: string;
  readonly state: SubagentRunView["state"];
  readonly question?: { readonly message: string } | undefined;
  readonly writeIntent: SubagentRunView["writeIntent"];
  readonly writeClaims?: ReadonlyArray<string> | undefined;
  readonly writeAudit?: SubagentRunView["writeAudit"] | undefined;
  readonly writeAdmissionPaused?: boolean | undefined;
  readonly writeViolationOffender?: boolean | undefined;
  readonly capabilities: SubagentRunView["capabilities"];
}

const runTarget = (run: AttentionRun): string =>
  `${sanitizeTerminalLine(run.name)} (${sanitizeTerminalLine(run.id)})`;

const claimViolationPaths = (run: AttentionRun): ReadonlyArray<string> => [
  ...new Set(run.writeAudit?.violations.map((violation) => violation.path) ?? []),
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

const claimContainmentRecovery = (run: AttentionRun): ReadonlyArray<string> => {
  const id = JSON.stringify(run.id);
  const paths = claimViolationPaths(run);
  const audit = paths.map((path) => sanitizeTerminalLine(path)).join(", ");
  const safeMissing = safeMissingClaimPaths(run);
  const hasUngrantablePath = paths.some((path) => grantableClaimPath(path) === undefined);
  const canResume = run.state === "paused" && run.capabilities.includes("resume");
  const terminal = isTerminalRunState(run.state);
  const header = `Claim containment for ${runTarget(run)} after: ${audit || "an out-of-claim write"}.`;
  if (run.state !== "paused" && !terminal)
    return [
      header,
      `Containment is in progress while the offender is ${runStateLabel(run.state)}.`,
      `1. Wait for containment to reach paused or terminal, then inspect it: subagent_status({ runIds: [${id}] }).`,
      `2. If status is paused and resume is supported, review the audit, grant only intended workspace-relative missing claims, reopen admission with subagent_claims({ action: "resume_admission", runId: ${id} }), then resume and await the offender.`,
      `3. If status is terminal, confirm process and writer cleanup before subagent_claims({ action: "resume_admission", runId: ${id} }), then launch and await a corrected replacement.`,
      "4. If status is still active, check again. Do not issue a duplicate stop solely because the paused state has not published yet.",
    ];
  if (canResume && !hasUngrantablePath) {
    const grantStep =
      safeMissing.length > 0
        ? `2. If the missing files are intended and conflict-free, grant them: subagent_claims({ action: "grant", runId: ${id}, paths: ${JSON.stringify(safeMissing)} }). Otherwise skip this step.`
        : "2. Keep the current claims unless the audit proves another workspace-relative file is intended and conflict-free.";
    return [
      header,
      `1. Review the audit and shared tree: subagent_status({ runIds: [${id}] }).`,
      grantStep,
      `3. Reopen writer admission: subagent_claims({ action: "resume_admission", runId: ${id} }).`,
      `4. Resume with the authoritative claims and guidance: subagent_lifecycle({ action: "resume", runIds: [${id}], message: "Use the authoritative claims returned by subagent_claims. Continue only within them." }).`,
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

const pausedAdmissionPeerRecovery = (run: AttentionRun): ReadonlyArray<string> => [
  `Writer admission is paused for ${runTarget(run)} because its cwd pool is under claim containment.`,
  "1. Inspect subagent_list and the paused or stopped offender's subagent_status write audit.",
  "2. Do not change this peer's claims. Contain or clean up the recorded offender first.",
  "3. Use resume_admission only after every offender is paused or terminal, then continue or await this peer.",
];

export const attentionRecoveryText = (runs: ReadonlyArray<AttentionRun>): string => {
  const attention = runs.filter(
    (run) => isParentActionRequiredRun(run) || run.writeViolationOffender === true,
  );
  if (attention.length === 0) return "";
  const parentActionRequired = attention.some(isParentActionRequiredRun);
  return [
    parentActionRequired
      ? "Parent action required; other unfinished subagents continue independently."
      : "Write-claim containment is still in progress; other unfinished subagents continue independently.",
    ...attention.flatMap((run) => {
      if (run.writeViolationOffender === true) return claimContainmentRecovery(run);
      if (run.writeAdmissionPaused === true) return pausedAdmissionPeerRecovery(run);
      if (run.state === "paused") return ordinaryPauseRecovery(run);
      const question = sanitizeTerminalLine(run.question?.message ?? "");
      const bounded = clipWithMarker(question, 512, "… [truncated]");
      return [
        `Question from ${sanitizeTerminalLine(run.name)}: ${bounded}`,
        `Reply with subagent_reply({ runId: ${JSON.stringify(run.id)}, message: "..." }), then call subagent_await again.`,
      ];
    }),
  ].join("\n");
};

const boundedLine = (value: string, maximum: number): string =>
  clipWithMarker(sanitizeTerminalLine(value), maximum, "… [truncated]");

export const formatRun = (run: SubagentRunView, detailed = false): string => {
  const profile = run.profile ? ` · profile=${sanitizeTerminalLine(run.profile)}` : "";
  const route = formatRunRoute(run.host, run.runtime, run.model, run.effort, run.openaiFastMode);
  const tree = run.depth
    ? ` · depth=${run.depth} · children=${run.directChildCount ?? 0}/${run.descendantCount ?? 0}`
    : "";
  const native = run.nativeActivity
    ? ` · native=${run.nativeActivity.active}/${run.nativeActivity.total}`
    : "";
  const header = `${sanitizeTerminalLine(run.id)} ${sanitizeTerminalLine(run.name)} · ${runStateLabel(run.state)} · ${run.writeIntent}${profile} · ${route}${tree}${native}`;
  if (!detailed) return header;
  const field = (label: string, value: string): string =>
    `  ${label.padEnd(10)} ${sanitizeTerminalLine(value)}`;
  const now = synchronousNow();
  const durationEnd = run.endedAt ?? now;
  const elapsed = formatSessionAge(durationEnd, run.startedAt) || undefined;
  const activityAge = formatSessionAge(now, run.lastActivityAt);
  const activity = activityAge ? `${activityAge} ago` : undefined;
  const retained = run.state === "reported" && run.closeOnReport === false;
  // Unknown or zero-information usage renders nothing rather than "unknown".
  const usage = formatUsage(run.usage);
  return [
    "Subagent status",
    field("Name", run.name),
    field("ID", run.id),
    field("State", runStateLabel(run.state)),
    run.parentRunId ? field("Parent", run.parentRunId) : undefined,
    run.depth !== undefined
      ? field(
          "Tree",
          `depth ${run.depth} · ${run.directChildCount ?? 0} direct · ${run.descendantCount ?? 0} descendants`,
        )
      : undefined,
    run.profile ? field("Profile", run.profile) : undefined,
    field("Route", route),
    field(
      "Retention",
      `${run.closeOnReport === false ? "retain backend after report" : "close after report"} · assignment ${run.reportGeneration || 1}${retained ? " · retained now" : ""}`,
    ),
    field("Selection", selectionSourceLabel(run)),
    run.selection.routeSource ? field("Route source", run.selection.routeSource) : undefined,
    field("Reason", run.selection.reason),
    run.predecessorRunId ? field("Predecessor", run.predecessorRunId) : undefined,
    run.supersededByRunId ? field("Superseded by", run.supersededByRunId) : undefined,
    run.retryBlocked
      ? field("Route retry", "blocked by uncertain execution or cleanup; inspect manually")
      : run.retryExhausted
        ? field("Route retry", "exhausted; only now consider a generalist replacement")
        : (run.remainingCandidateCount ?? 0) > 0 && run.state === "failed"
          ? field(
              "Route retry",
              `${run.remainingCandidateCount} candidate${run.remainingCandidateCount === 1 ? " remains" : "s remain"}; use subagent_lifecycle action=retry`,
            )
          : undefined,
    ...run.selection.skippedCandidates.map((candidate) =>
      field(
        "Skipped",
        `${candidate.candidateIndex === undefined ? "route" : `candidate ${candidate.candidateIndex + 1}`} [${candidate.code}]: ${candidate.reason}`,
      ),
    ),
    run.selection.warning ? field("Route warning", run.selection.warning) : undefined,
    field("Context", run.context),
    field("Intent", run.writeIntent),
    run.writeIntent === "writer"
      ? field("Writes", run.writeClaims?.join(", ") || "exclusive whole cwd")
      : undefined,
    run.writeAdmissionPaused ? field("Admission", "paused after claim violation") : undefined,
    run.writeViolationOffender ? field("Containment", "current violation offender") : undefined,
    run.writeAudit
      ? field(
          "Write audit",
          `${run.writeAudit.observedFileWrites.length} native file path${run.writeAudit.observedFileWrites.length === 1 ? "" : "s"} observed · ${run.writeAudit.violations.length} violation${run.writeAudit.violations.length === 1 ? "" : "s"} · ${run.writeAudit.bashWriteHints} Bash heuristic notice${run.writeAudit.bashWriteHints === 1 ? "" : "s"}`,
        )
      : undefined,
    field("Capabilities", `${run.capabilities.join(", ") || "none"}; stop/await always available`),
    run.pid ? field("Process", `pid ${run.pid}`) : undefined,
    elapsed ? field("Elapsed", elapsed) : undefined,
    activity ? field("Activity", activity) : undefined,
    usage ? field("Usage", usage) : undefined,
    run.nativeActivity
      ? field(
          "Native",
          `${run.nativeActivity.active} active · ${run.nativeActivity.total} total${run.nativeActivity.latest ? ` · latest ${run.nativeActivity.latest.kind} ${run.nativeActivity.latest.state}` : ""}`,
        )
      : undefined,
    run.currentTool ? field("Current tool", run.currentTool) : undefined,
    run.progress ? field("Progress", run.progress) : undefined,
    run.warning ? field("Warning", run.warning) : undefined,
    run.question ? field("Needs reply", run.question.message) : undefined,
    run.error ? field("Failure", run.error) : undefined,
    run.finalText
      ? `\nFinal report\n${sanitizeTerminalText(run.finalText)}`
      : run.state === "completed" || run.state === "reported"
        ? "\nFinal report\nUnavailable in this observation; it may be claimed by another subagent_await or already delivered to the parent."
        : undefined,
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
    ? ` · ${recovery.remainingCandidateCount} candidate${recovery.remainingCandidateCount === 1 ? "" : "s"} remains`
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
};

export const formatStartFailures = (failures: ReadonlyArray<SubagentStartFailure>): string =>
  failures.length === 0
    ? ""
    : [
        `Failed starts (${failures.length})`,
        ...failures.map((failure) => {
          const target = failure.name ? ` ${sanitizeTerminalLine(failure.name)}` : "";
          const message = boundedLine(failure.message, 2_048);
          const code = failure.code ? ` [${sanitizeTerminalLine(failure.code)}]` : "";
          const recovery = failure.admittedRun;
          return [
            `  #${failure.index + 1}${target}${code}: ${message}`,
            recovery ? `    ${formatFailedStartRecovery(recovery)}` : undefined,
            recovery ? `    Next: ${failedStartRecoveryAction(recovery)}` : undefined,
          ]
            .filter((line): line is string => line !== undefined)
            .join("\n");
        }),
      ].join("\n");

export const formatStartResultDetails = (
  runs: ReadonlyArray<SubagentRunView>,
  failures: ReadonlyArray<SubagentStartFailure>,
): DetailedRunsFormat => {
  const failureText = formatStartFailures(failures);
  return formatDetailedRuns(
    runs,
    failureText ? `${failureText}${runs.length > 0 ? "\n\n" : ""}` : "",
  );
};

export const formatStartResult = (
  runs: ReadonlyArray<SubagentRunView>,
  failures: ReadonlyArray<SubagentStartFailure>,
): string => formatStartResultDetails(runs, failures).text;

export const formatActionFailures = (failures: ReadonlyArray<SubagentActionFailure>): string =>
  failures.length === 0
    ? ""
    : [
        `Failed targets (${failures.length})`,
        ...failures.map((failure) => {
          const code = failure.code ? ` [${sanitizeTerminalLine(failure.code)}]` : "";
          return `  ${sanitizeTerminalLine(failure.id)}${code}: ${boundedLine(failure.message, 320)}`;
        }),
      ].join("\n");

export const renderedCompletionReceipts = (
  observations: ReadonlyArray<SubagentRunObservation>,
  fullyRenderedIds: ReadonlySet<string>,
) =>
  observations.flatMap((observation) =>
    observation.completionReceipt && fullyRenderedIds.has(observation.run.id)
      ? [observation.completionReceipt]
      : [],
  );
