import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
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

export const failureRecovery = (code: string | undefined, message: string): string => {
  const key = `${code ?? ""} ${message}`.toLowerCase();
  if (key.includes("notfound") || key.includes("not found"))
    return "Refresh run IDs with subagent_list.";
  if (key.includes("capabil") || key.includes("unsupported"))
    return "Inspect the run's capabilities with subagent_status.";
  if (
    key.includes("profile") ||
    key.includes("candidate") ||
    key.includes("auth") ||
    key.includes("harness") ||
    key.includes("model")
  )
    return "Inspect the effective route with subagent_models or edit it with /subagents profiles.";
  if (key.includes("waiting") || key.includes("question"))
    return "Reply with subagent_reply, then await the run again.";
  return "Review the failure detail and resolve it before retrying.";
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
        `Profile routes · static eligibility only${this.details.defaultProfile ? ` · fallback ${this.details.defaultProfile}` : ""}`,
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
          `• ${profile.id}${profile.isDefault ? " · implicit fallback" : ""} · ${profileSource(profile.source)} · ${eligible}/${profile.candidates.length} eligible${first ? ` · ${first}` : " · disabled"}`,
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
  const count = details.cards?.length ?? details.runCount ?? 0;
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
    case "send":
      return {
        color: failed > 0 ? (count > 0 ? "warning" : "error") : "success",
        text: `Guidance · ${count} delivered${failed > 0 ? ` · ${failed} failed` : ""}`,
      };
    case "reply":
      return {
        color: failed > 0 ? "error" : "success",
        text: failed > 0 ? "Reply failed" : `Reply delivered to ${count} subagent${plural}`,
      };
    case "interrupt":
      return {
        color: failed > 0 ? "warning" : "success",
        text: `Pause · ${count} updated${failed > 0 ? ` · ${failed} failed` : ""}`,
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
          `× ${sanitizeTerminalLine(failure.id)}${code} · ${sanitizeTerminalLine(failure.message)}`,
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
    const omitted = this.details.contentOmitted
      ? {
          color: "warning" as const,
          text: `${summary.text} · Some report content was omitted; query individual run IDs with subagent_status`,
        }
      : summary;
    return [
      ...this.renderRuns(cards, this.expanded, omitted, this.details.action === "status").render(
        safeWidth,
      ),
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
