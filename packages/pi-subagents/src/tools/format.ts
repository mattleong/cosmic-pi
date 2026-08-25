import {
  sanitizeTerminalLine,
  stripTerminalControls as sanitizeTerminalText,
  synchronousNow,
} from "pi-cosmic-core";
import type { SubagentSelectionProvenance } from "../profiles/model.ts";
import type { SubagentRunView } from "../run/model.ts";
import { MAX_TOOL_OUTPUT_CHARS } from "../run/limits.ts";
import type { SubagentRunObservation } from "../run/service.ts";
import { clipWithMarker } from "../run/state.ts";
import { formatDuration, formatUsage } from "../ui/metrics.ts";
import { runStateLabel } from "../ui/run-state.ts";
import type { SubagentRunCard } from "./details.ts";
import type { SubagentActionFailure, SubagentStartFailure } from "./subagent.ts";

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

export const formatToolModel = (model: string, effort: string, fastMode?: boolean): string =>
  `${sanitizeTerminalLine(model)}:${sanitizeTerminalLine(effort)}${fastMode ? " ⚡" : ""}`;

export const formatToolRoute = (
  host: string,
  runtime: string,
  model: string,
  effort: string,
  fastMode?: boolean,
): string =>
  `${sanitizeTerminalLine(host)}/${sanitizeTerminalLine(runtime)} · ${formatToolModel(model, effort, fastMode)}`;

export const joinBoundedToolText = (parts: ReadonlyArray<string>): string =>
  boundToolOutput(parts.filter(Boolean).join("\n\n"));

interface AttentionRun {
  readonly id: string;
  readonly name: string;
  readonly state: SubagentRunCard["state"];
  readonly question?: { readonly message: string } | undefined;
}

export const attentionRecoveryText = (runs: ReadonlyArray<AttentionRun>): string => {
  const waiting = runs.filter((run) => run.state === "waiting_for_parent" && run.question?.message);
  if (waiting.length === 0) return "";
  return [
    "Parent reply required; other unfinished subagents continue independently.",
    ...waiting.flatMap((run) => {
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
  const route = formatToolRoute(run.host, run.runtime, run.model, run.effort, run.fastMode);
  const header = `${sanitizeTerminalLine(run.id)} ${sanitizeTerminalLine(run.name)} · ${runStateLabel(run.state)} · ${run.writeIntent}${profile} · ${route}`;
  if (!detailed) return header;
  const field = (label: string, value: string): string =>
    `  ${label.padEnd(10)} ${sanitizeTerminalLine(value)}`;
  const now = synchronousNow();
  const durationEnd = run.endedAt ?? now;
  const elapsedMilliseconds = durationEnd - run.startedAt;
  const activityMilliseconds = now - run.lastActivityAt;
  const elapsed =
    elapsedMilliseconds >= 0 && elapsedMilliseconds <= 7 * 24 * 60 * 60 * 1_000
      ? formatDuration(elapsedMilliseconds)
      : undefined;
  const activity =
    activityMilliseconds >= 0 && activityMilliseconds <= 7 * 24 * 60 * 60 * 1_000
      ? `${formatDuration(activityMilliseconds)} ago`
      : undefined;
  const retained = run.state === "reported" && run.closeOnReport === false;
  // Unknown or zero-information usage renders nothing rather than "unknown".
  const usage = formatUsage(run.usage);
  return [
    "Subagent status",
    field("Name", run.name),
    field("ID", run.id),
    field("State", runStateLabel(run.state)),
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

export const formatStartFailures = (failures: ReadonlyArray<SubagentStartFailure>): string =>
  failures.length === 0
    ? ""
    : [
        `Failed starts (${failures.length})`,
        ...failures.map((failure) => {
          const target = failure.name ? ` ${sanitizeTerminalLine(failure.name)}` : "";
          const message = boundedLine(failure.message, 2_048);
          const code = failure.code ? ` [${sanitizeTerminalLine(failure.code)}]` : "";
          return `  #${failure.index + 1}${target}${code}: ${message}`;
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
