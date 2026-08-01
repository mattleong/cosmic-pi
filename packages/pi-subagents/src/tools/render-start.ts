import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { synchronousNow } from "../boundary/native-clock.ts";
import { animatedRunStateGlyph } from "../ui/run-state.ts";
import { sanitizeTerminalLine } from "../ui/sanitize.ts";
import { safeTextPrefix } from "../run/state.ts";
import type { SubagentRunCard, SubagentStartEntry } from "./details.ts";
import { failureRecovery } from "./render-management.ts";
import { aggregateRunUsage, renderResponsiveRunRows } from "./render-run-rows.ts";
import type { SubagentStartFailure } from "./subagent.ts";

export const renderStartFailures = (
  failures: ReadonlyArray<SubagentStartFailure>,
  expanded: boolean,
  theme: Theme,
): string =>
  failures
    .map((failure) => {
      const name = sanitizeTerminalLine(failure.name ?? `start #${failure.index + 1}`);
      const code = failure.code ? ` [${sanitizeTerminalLine(failure.code)}]` : "";
      const summary = `${theme.fg("error", `× ${name}`)} · ${theme.fg("error", `failed to start${code}`)}`;
      const raw = sanitizeTerminalLine(failure.message);
      const maximum = expanded ? 2_048 : 240;
      const marker = "… [truncated]";
      const detail =
        raw.length <= maximum
          ? raw
          : `${safeTextPrefix(raw, Math.max(0, maximum - marker.length))}${marker}`;
      const recovery = failureRecovery(failure.code, failure.message);
      return `${summary}\n${theme.fg("dim", detail)}\n${theme.fg("accent", `Next: ${recovery}`)}`;
    })
    .join("\n");

class StartProgressComponent implements Component {
  private readonly progress: string;
  private readonly runs: ReadonlyArray<SubagentRunCard>;
  private readonly failures: ReadonlyArray<SubagentStartFailure>;
  private readonly entries: ReadonlyArray<SubagentStartEntry>;
  private readonly theme: Theme;

  constructor(
    progress: string,
    runs: ReadonlyArray<SubagentRunCard>,
    failures: ReadonlyArray<SubagentStartFailure>,
    entries: ReadonlyArray<SubagentStartEntry>,
    theme: Theme,
  ) {
    this.progress = progress;
    this.runs = runs;
    this.failures = failures;
    this.entries = entries;
    this.theme = theme;
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const frame = Math.floor(synchronousNow() / 160);
    const settled = this.entries.filter((entry) => entry.status !== "pending").length;
    const started = this.entries.filter((entry) => entry.status === "started").length;
    const failed = this.entries.filter((entry) => entry.status === "failed").length;
    const progress =
      this.entries.length > 0
        ? `Processed ${settled} of ${this.entries.length} launches · ${started} started · ${failed} failed · ${this.entries.length - settled} pending`
        : this.progress;
    const rows =
      this.entries.length === 0
        ? [
            ...renderResponsiveRunRows(this.runs, safeWidth, this.theme, { frame }),
            ...renderStartFailures(this.failures, false, this.theme)
              .split("\n")
              .filter(Boolean)
              .map((line) => truncateToWidth(line, safeWidth)),
          ]
        : [...this.entries]
            .sort((left, right) => left.index - right.index)
            .flatMap((entry) => {
              if (entry.status === "pending")
                return [
                  truncateToWidth(
                    this.theme.fg(
                      "warning",
                      `${animatedRunStateGlyph("starting", frame)} ${sanitizeTerminalLine(entry.name)}${entry.profile ? ` · [${entry.profile}]` : ""} · pending`,
                    ),
                    safeWidth,
                  ),
                ];
              if (entry.status === "started") {
                const run = this.runs.find((candidate) => candidate.id === entry.runId);
                return run
                  ? renderResponsiveRunRows([run], safeWidth, this.theme, { frame })
                  : [this.theme.fg("success", `✓ ${sanitizeTerminalLine(entry.name)} · started`)];
              }
              const failure = this.failures.find((candidate) => candidate.index === entry.index);
              return failure
                ? renderStartFailures([failure], false, this.theme)
                    .split("\n")
                    .filter(Boolean)
                    .map((line) => truncateToWidth(line, safeWidth))
                : [this.theme.fg("error", `× ${sanitizeTerminalLine(entry.name)} · failed`)];
            });
    const usage = aggregateRunUsage(this.runs);
    return [
      truncateToWidth(
        this.theme.fg("warning", `${animatedRunStateGlyph("starting", frame)} ${progress}`),
        safeWidth,
      ),
      ...(usage ? [this.theme.fg("dim", `Total usage · ${usage}`)] : []),
      ...rows,
    ];
  }

  invalidate(): void {
    // Rendering is derived from the current clock frame.
  }
}

export const renderStartProgressComponent = (
  progress: string,
  runs: ReadonlyArray<SubagentRunCard>,
  failures: ReadonlyArray<SubagentStartFailure>,
  entries: ReadonlyArray<SubagentStartEntry>,
  theme: Theme,
): Component => new StartProgressComponent(progress, runs, failures, entries, theme);
