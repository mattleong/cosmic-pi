import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import { managerStateGlyph } from "pi-cosmic-ui/manager";
import { sanitizeTerminalLine } from "../ui/sanitize.ts";
import { formatToolModel, formatToolRoute } from "./format.ts";
import type {
  CompactSubagentToolDetails,
  SubagentProfileRouteCard,
  SubagentRunCard,
} from "./details.ts";

export interface SemanticOutcomeBanner {
  readonly color: "warning" | "success" | "error" | "accent";
  readonly text: string;
}

export const failureRecovery = (
  code: string | undefined,
  message: string,
  context: "start" | "action" = "action",
): string => {
  const normalizedCode = code?.toLowerCase() ?? "";
  const normalizedMessage = message.toLowerCase();
  if (context === "start") {
    if (
      normalizedCode.includes("profile") ||
      normalizedCode.includes("candidate") ||
      normalizedCode.includes("auth") ||
      normalizedCode.includes("harness") ||
      normalizedCode.includes("model") ||
      normalizedCode.includes("unsupported") ||
      normalizedCode.includes("confinement") ||
      normalizedCode.includes("readiness")
    )
      return "Inspect the effective route with subagent_models or choose a compatible route in /subagents profiles.";
    if (normalizedCode.includes("capacity") || normalizedCode.includes("writer"))
      return "Resolve the reported capacity or writer-ownership constraint, then retry the launch.";
    return "Review the launch failure and profile route before retrying.";
  }
  if (
    normalizedCode.includes("notfound") ||
    normalizedCode.includes("not_found") ||
    normalizedMessage.includes("not found")
  )
    return "Refresh run IDs with subagent_list.";
  if (normalizedCode.includes("completion_claim_conflict"))
    return "Wait for or cancel the operation that already owns this completion, then retry.";
  if (normalizedCode.includes("report_delivery_backlog"))
    return "Wait for automatic outcome delivery or claim the current outcome with subagent_await, then retry.";
  if (normalizedCode.includes("reply_outcome_uncertain"))
    return "Do not resend the reply automatically; inspect subagent_status and wait for the run's next event.";
  if (normalizedCode.includes("question_ownership_mismatch"))
    return "The question is no longer pending; refresh the run with subagent_status before taking another action.";
  if (
    normalizedCode.includes("waiting_for_parent") ||
    normalizedCode.includes("parent_question") ||
    normalizedMessage.includes("waiting for a parent reply")
  )
    return "Reply with subagent_reply, then await the run again.";
  if (normalizedCode.includes("capability") || normalizedCode.includes("unsupported"))
    return "Inspect the run's capabilities with subagent_status.";
  if (
    normalizedCode.includes("profile") ||
    normalizedCode.includes("candidate") ||
    normalizedCode.includes("auth") ||
    normalizedCode.includes("harness") ||
    normalizedCode.includes("model")
  )
    return "Inspect the effective route with subagent_models or edit it with /subagents profiles.";
  return "Review the failure detail and current subagent_status before retrying.";
};

const friendlyCandidateRoute = (value: string, fastModeApplied: boolean): string => {
  const match =
    /^(.*):([^:]+):(fresh|fork):(read-only|writer):fastMode=(true|false):closeOnReport=(true|false)$/.exec(
      value,
    );
  if (!match) return value;
  const [, route, effort, context, intent, fast, close] = match;
  const parts = /^(local|herdr)\/(pi|claude|codex)\/(.+)$/.exec(route ?? "");
  const model = parts
    ? formatToolRoute(
        parts[1] ?? "",
        parts[2] ?? "",
        parts[3] ?? "",
        effort ?? "",
        fast === "true" && fastModeApplied,
      )
    : formatToolModel(route ?? "", effort ?? "", fast === "true" && fastModeApplied);
  return `${model} · ${context} · ${intent} · ${close === "true" ? "close after report" : "retain after report"}`;
};

const profileSource = (source: SubagentProfileRouteCard["source"]): string => {
  switch (source) {
    case "session":
      return "session override";
    case "project":
      return "project override";
    case "project-invalid":
      return "invalid project override";
    case "global":
      return "global override";
    case "global-invalid":
      return "invalid global override";
    case "builtin":
      return "built-in";
  }
  return source;
};

class ProfileRoutesComponent implements Component {
  private readonly details: CompactSubagentToolDetails;
  private readonly expanded: boolean;
  private readonly theme: Theme;

  constructor(details: CompactSubagentToolDetails, expanded: boolean, theme: Theme) {
    this.details = details;
    this.expanded = expanded;
    this.theme = theme;
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const profiles = this.details.profiles ?? [];
    const lines: string[] = [
      this.theme.fg(
        "accent",
        `Profile routes · static eligibility only${this.details.fallbackProfile ? ` · fallback ${this.details.fallbackProfile}` : ""}`,
      ),
    ];
    for (const profile of profiles) {
      const eligible = profile.candidates.filter(
        (candidate) => candidate.status === "eligible",
      ).length;
      const invalid = profile.source.endsWith("-invalid");
      const color = invalid || eligible === 0 ? "warning" : "success";
      const firstCandidate = profile.candidates[0];
      const first = firstCandidate
        ? friendlyCandidateRoute(firstCandidate.candidate, firstCandidate.status === "eligible")
        : undefined;
      lines.push(
        this.theme.fg(
          color,
          `• ${profile.id}${profile.isDefault ? " · when omitted" : ""} · ${profileSource(profile.source)} · ${eligible}/${profile.candidates.length} eligible${first ? ` · ${first}` : " · disabled"}`,
        ),
      );
      if (!this.expanded) continue;
      lines.push(this.theme.fg("dim", `  ${profile.description}`));
      lines.push(
        this.theme.fg(
          "dim",
          `  Defaults · ${profile.defaultContext} · ${profile.defaultWriteIntent} · ${profile.defaultEffort ?? "inherit effort"}`,
        ),
      );
      for (const candidate of profile.candidates) {
        lines.push(
          this.theme.fg(
            candidate.status === "eligible" ? "success" : "warning",
            `  ${candidate.status === "eligible" ? "✓" : "–"} ${candidate.order}. ${friendlyCandidateRoute(candidate.candidate, candidate.status === "eligible")}${candidate.effectiveContext ? ` · effective context=${candidate.effectiveContext}` : ""}`,
          ),
        );
        lines.push(this.theme.fg("dim", `     ${candidate.reason}`));
      }
    }
    if (profiles.length === 0)
      lines.push(this.theme.fg("muted", "No profile route details were persisted."));
    lines.push(
      this.theme.fg(
        "dim",
        "Launch checks pending · executable, authentication, native integration, and private harness are checked at launch.",
      ),
    );
    return lines.flatMap((line) =>
      this.expanded ? wrapTextWithAnsi(line, safeWidth) : [truncateToWidth(line, safeWidth)],
    );
  }

  invalidate(): void {
    // Rendering is a pure projection of immutable result details.
  }
}

const actionSummary = (details: CompactSubagentToolDetails): SemanticOutcomeBanner => {
  const count = details.runCount ?? details.cards?.length ?? 0;
  const failed = details.actionFailures?.length ?? 0;
  const plural = count === 1 ? "" : "s";
  switch (details.action) {
    case "list":
      return {
        color: "accent",
        text: count > 0 ? `${count} session subagent${plural}` : "No session subagents",
      };
    case "status":
      return {
        color: failed > 0 ? "warning" : "accent",
        text: `Status · ${count} found${failed > 0 ? ` · ${failed} missing` : ""}`,
      };
    case "send": {
      // closeOnReport=false targets started their next assignment; others got guidance.
      const cards = details.cards ?? [];
      const retained = cards.filter((card) => card.closeOnReport === false).length;
      const label =
        cards.length > 0 && retained === cards.length
          ? "Next assignments"
          : retained > 0
            ? "Guidance/next assignments"
            : "Guidance";
      return {
        color: failed > 0 ? (count > 0 ? "warning" : "error") : "success",
        text: `${label} · ${count} delivered${failed > 0 ? ` · ${failed} failed` : ""}`,
      };
    }
    case "reply":
      return {
        color: failed > 0 ? "error" : "success",
        text: failed > 0 ? "Reply failed" : `Reply delivered to ${count} subagent${plural}`,
      };
    case "interrupt":
      return {
        color: failed > 0 ? "warning" : "success",
        text: `Interrupt · ${count} paused${failed > 0 ? ` · ${failed} failed` : ""}`,
      };
    case "resume":
      return {
        color: failed > 0 ? "warning" : "success",
        text: `Resume · ${count} updated${failed > 0 ? ` · ${failed} failed` : ""}`,
      };
    case "stop":
      return {
        color: failed > 0 ? "warning" : "success",
        text: `Stop · ${count} updated${failed > 0 ? ` · ${failed} failed` : ""}`,
      };
    case "rename":
      return {
        color: failed > 0 ? "error" : "success",
        text: failed > 0 ? "Rename failed" : "Subagent renamed",
      };
    default:
      return {
        color: failed > 0 ? "warning" : "accent",
        text: `${details.action} · ${count} result${count === 1 ? "" : "s"}${failed > 0 ? ` · ${failed} failed` : ""}`,
      };
  }
};

const renderActionFailures = (
  details: CompactSubagentToolDetails,
  width: number,
  theme: Theme,
): ReadonlyArray<string> =>
  (details.actionFailures ?? []).flatMap((failure) => {
    const code = failure.code ? ` [${sanitizeTerminalLine(failure.code)}]` : "";
    const recovery = failureRecovery(failure.code, failure.message);
    return [
      truncateToWidth(
        theme.fg(
          "error",
          `${managerStateGlyph("failed")} ${sanitizeTerminalLine(failure.id)}${code} · ${sanitizeTerminalLine(failure.message)}`,
        ),
        width,
      ),
      truncateToWidth(theme.fg("accent", `  Next: ${recovery}`), width),
    ];
  });

export type SemanticRunRenderer = (
  cards: ReadonlyArray<SubagentRunCard>,
  expanded: boolean,
  banner: SemanticOutcomeBanner,
  showReports: boolean,
) => Component;

class CompactResultComponent implements Component {
  private readonly details: CompactSubagentToolDetails;
  private readonly expanded: boolean;
  private readonly theme: Theme;
  private readonly renderRuns: SemanticRunRenderer;

  constructor(
    details: CompactSubagentToolDetails,
    expanded: boolean,
    theme: Theme,
    renderRuns: SemanticRunRenderer,
  ) {
    this.details = details;
    this.expanded = expanded;
    this.theme = theme;
    this.renderRuns = renderRuns;
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const cards = this.details.cards ?? [];
    const summary = actionSummary(this.details);
    const totalRuns = this.details.runCount ?? cards.length;
    const omittedRuns = Math.max(0, totalRuns - cards.length);
    const omissionCues = [
      ...(omittedRuns > 0
        ? [
            `${cards.length} of ${totalRuns} shown · ${omittedRuns} omitted · use subagent_status for specific run IDs`,
          ]
        : []),
      ...(this.details.contentOmitted
        ? ["Report content omitted · use subagent_status for individual run IDs"]
        : []),
    ];
    const omissionLines = omissionCues.flatMap((cue) =>
      wrapTextWithAnsi(this.theme.fg("warning", cue), safeWidth),
    );
    return [
      ...this.renderRuns(cards, this.expanded, summary, this.details.action === "status").render(
        safeWidth,
      ),
      ...omissionLines,
      ...renderActionFailures(this.details, safeWidth, this.theme),
    ];
  }

  invalidate(): void {
    // Rendering is a pure projection of immutable result details.
  }
}

export const renderProfileRoutesComponent = (
  details: CompactSubagentToolDetails,
  expanded: boolean,
  theme: Theme,
): Component => new ProfileRoutesComponent(details, expanded, theme);

export const renderCompactResultComponent = (
  details: CompactSubagentToolDetails,
  expanded: boolean,
  theme: Theme,
  renderRuns: SemanticRunRenderer,
): Component => new CompactResultComponent(details, expanded, theme, renderRuns);
