import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  Container,
  Text,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
} from "@earendil-works/pi-tui";
import { sanitizeTerminalLine, synchronousNow } from "pi-cosmic-core";
import { managerNoticeGlyph, managerStateGlyph, startingSpinnerFrame } from "pi-cosmic-ui/manager";
import { clipWithMarker, safeTextPrefix } from "../run/state.ts";
import { formatRunRoute, shortRunId } from "../ui/run-presentation.ts";
import type { SubagentStartEntry } from "./details.ts";
import { failedStartRecoveryAction, formatFailedStartRecovery } from "./format.ts";
import { renderExpansionAffordance } from "./render-affordance.ts";
import { failureRecovery } from "./render-management.ts";
import type { SubagentStartFailure } from "./model.ts";
import type { SubagentStartSpec } from "./schema.ts";

const requestedName = (agent: SubagentStartSpec, index: number): string =>
  sanitizeTerminalLine(agent.name?.trim() || `launch ${index + 1}`);

const requestedProfile = (agent: SubagentStartSpec): string =>
  sanitizeTerminalLine(agent.profile?.trim() || "generalist");

/** Static request projection: collapsed stays compact; expanded alone reveals bounded tasks. */
export const renderSubagentStartCall = (
  agents: ReadonlyArray<SubagentStartSpec>,
  theme: Theme,
  expanded: boolean,
): Component => {
  const count = agents.length;
  const title = `Start ${count} subagent${count === 1 ? "" : "s"}`;
  const requested = agents
    .map((agent, index) => `${requestedName(agent, index)} [${requestedProfile(agent)}]`)
    .join(", ");
  const summary = sanitizeTerminalLine(requested);
  const clippedSummary =
    summary.length <= 160 ? summary : `${safeTextPrefix(summary, 146)}… [truncated]`;
  const taskAffordance = expanded
    ? ""
    : ` ${renderExpansionAffordance("tasks & launch details", false, theme)}`;
  const header = new Text(
    `${theme.fg("toolTitle", theme.bold(title))}${clippedSummary ? ` ${theme.fg("dim", clippedSummary)}` : ""}${taskAffordance}`,
    0,
    0,
  );
  if (!expanded) return header;
  const container = new Container();
  container.addChild(header);
  for (const [index, agent] of agents.entries()) {
    container.addChild(
      new Text(
        theme.fg(
          "toolOutput",
          `${requestedName(agent, index)} · ${requestedProfile(agent)} · route/model selected at launch`,
        ),
        0,
        0,
      ),
    );
    container.addChild(
      new Text(
        theme.fg(
          "dim",
          `  Task: ${clipWithMarker(sanitizeTerminalLine(agent.task), 512, "… [truncated]")}`,
        ),
        0,
        0,
      ),
    );
  }
  return container;
};

export const renderStartFailures = (
  failures: ReadonlyArray<SubagentStartFailure>,
  expanded: boolean,
  theme: Theme,
): string =>
  failures
    .map((failure) => {
      const name = sanitizeTerminalLine(failure.name ?? `start #${failure.index + 1}`);
      const code = failure.code ? ` [${sanitizeTerminalLine(failure.code)}]` : "";
      const summary = `${theme.fg("error", `${managerStateGlyph("failed")} ${name}`)} · ${theme.fg("error", `failed to start${code}`)}`;
      const raw = sanitizeTerminalLine(failure.message);
      const detail = clipWithMarker(raw, expanded ? 2_048 : 240, "… [truncated]");
      const admitted = failure.admittedRun;
      const recovery = admitted
        ? failedStartRecoveryAction(admitted)
        : failureRecovery(failure.code, failure.message, "start");
      const admittedLine = admitted
        ? `\n${theme.fg("dim", formatFailedStartRecovery(admitted))}`
        : "";
      return `${summary}\n${theme.fg("dim", detail)}${admittedLine}\n${theme.fg("accent", `Next: ${recovery}`)}`;
    })
    .join("\n");

type SelectedStartEntry = Extract<SubagentStartEntry, { readonly routeStatus: "selected" }>;

const selectedRoute = (entry: SubagentStartEntry): entry is SelectedStartEntry =>
  entry.routeStatus === "selected";

const routeLabel = (entry: SubagentStartEntry): string => {
  if (selectedRoute(entry))
    return formatRunRoute(
      entry.host ?? "local",
      entry.runtime ?? "pi",
      entry.model ?? "unknown model",
      entry.effort ?? "off",
      entry.openaiFastMode,
    );
  return entry.status === "pending" ? "resolving route/model" : "no eligible route/model";
};

const receiptPresentation = (entry: SubagentStartEntry) => {
  switch (entry.status) {
    case "pending":
      return { glyph: startingSpinnerFrame(0), color: "warning" } as const;
    case "started":
      return { glyph: managerStateGlyph("done"), color: "success" } as const;
    case "failed":
      return { glyph: managerStateGlyph("failed"), color: "error" } as const;
  }
};

const receiptRow = (
  entry: SubagentStartEntry,
  width: number,
  theme: Theme,
  failure?: SubagentStartFailure,
): string[] => {
  const safeWidth = Math.max(1, width);
  const { glyph, color } = receiptPresentation(entry);
  const name = sanitizeTerminalLine(entry.name);
  const profile = sanitizeTerminalLine(entry.profile || "generalist");
  const route = routeLabel(entry);
  const recovery = entry.status === "failed" ? failure?.admittedRun : undefined;
  const id =
    entry.status === "started"
      ? sanitizeTerminalLine(shortRunId(entry.runId))
      : recovery
        ? sanitizeTerminalLine(shortRunId(recovery.runId))
        : "";
  const recoveryStatus = recovery
    ? ` · cleanup ${recovery.cleanupDisposition} · retry ${recovery.retryDisposition}`
    : "";
  const raw = `${glyph} ${name} · ${profile} · ${route}${id ? ` · ${id}` : ""}${recoveryStatus}`;
  const routeLines =
    visibleWidth(raw) <= safeWidth
      ? [
          `${theme.fg(color, glyph)} ${theme.fg("toolTitle", name)} · ${theme.fg("muted", profile)} · ${theme.fg("toolOutput", route)}${id ? ` · ${theme.fg("muted", id)}` : ""}${recoveryStatus ? theme.fg(recovery?.retryDisposition === "eligible" ? "accent" : "warning", recoveryStatus) : ""}`,
        ]
      : (() => {
          const lines = [`${theme.fg(color, glyph)} ${theme.fg("toolTitle", name)}`];
          const routeValue = selectedRoute(entry)
            ? `${theme.fg("muted", profile)} ${theme.fg("dim", "→")} ${theme.fg(
                "toolOutput",
                formatRunRoute(
                  entry.host ?? "local",
                  entry.runtime ?? "pi",
                  entry.model ?? "unknown model",
                  entry.effort ?? "off",
                  entry.openaiFastMode,
                ),
              )}`
            : `${theme.fg("muted", profile)} ${theme.fg("dim", "→")} ${theme.fg("toolOutput", route)}`;
          lines.push(
            ...wrapTextWithAnsi(routeValue, Math.max(1, safeWidth - 5)).map(
              (line, index) => `${theme.fg("dim", index === 0 ? "  ╰─ " : "     ")}${line}`,
            ),
          );
          if (id) lines.push(`  ${theme.fg("muted", id)}`);
          if (recovery)
            lines.push(
              `  ${theme.fg("muted", `cleanup ${recovery.cleanupDisposition} · retry ${recovery.retryDisposition}`)}`,
            );
          return lines.map((line) => truncateToWidth(line, safeWidth));
        })();
  const warningLines =
    selectedRoute(entry) && entry.warning
      ? wrapTextWithAnsi(
          theme.fg(
            "warning",
            `  ${managerNoticeGlyph("warning")} ${sanitizeTerminalLine(entry.warning)}`,
          ),
          safeWidth,
        )
      : [];
  return [...routeLines, ...warningLines];
};

const receiptHeader = (
  entries: ReadonlyArray<SubagentStartEntry>,
  partial: boolean,
  theme: Theme,
): string => {
  const total = entries.length;
  const started = entries.filter((entry) => entry.status === "started").length;
  const failed = entries.filter((entry) => entry.status === "failed").length;
  const pending = total - started - failed;
  const warnings = entries.filter(
    (entry) => selectedRoute(entry) && entry.warning !== undefined,
  ).length;
  if (partial) {
    const frame = Math.floor(synchronousNow() / 160);
    const progress = `Launching ${started + failed} of ${total} · ${started} started · ${failed} failed · ${pending} pending`;
    return theme.fg("warning", `${startingSpinnerFrame(frame)} ${progress}`);
  }
  if (total === 0)
    return theme.fg("warning", `${managerNoticeGlyph("warning")} Launch receipt unavailable`);
  if (failed === 0)
    return theme.fg(
      warnings > 0 ? "warning" : "success",
      `${warnings > 0 ? managerNoticeGlyph("warning") : managerStateGlyph("done")} ${started} started${warnings > 0 ? ` · ${warnings} route warning${warnings === 1 ? "" : "s"}` : ""}`,
    );
  if (started > 0)
    return theme.fg(
      "warning",
      `${managerNoticeGlyph("warning")} ${started}/${total} started · ${failed} failed`,
    );
  return theme.fg(
    "error",
    `${managerStateGlyph("failed")} Failed to start ${failed} subagent${failed === 1 ? "" : "s"}`,
  );
};

class StartReceiptComponent implements Component {
  private readonly failures: ReadonlyArray<SubagentStartFailure>;
  private readonly entries: ReadonlyArray<SubagentStartEntry>;
  private readonly partial: boolean;
  private readonly expanded: boolean;
  private readonly theme: Theme;

  constructor(
    failures: ReadonlyArray<SubagentStartFailure>,
    entries: ReadonlyArray<SubagentStartEntry>,
    partial: boolean,
    expanded: boolean,
    theme: Theme,
  ) {
    this.failures = failures;
    this.entries = entries;
    this.partial = partial;
    this.expanded = expanded;
    this.theme = theme;
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const entries = this.entries;
    const started = entries.filter((entry) => entry.status === "started").length;
    const failureDetails = this.expanded
      ? entries.flatMap((entry) => {
          const fallback =
            selectedRoute(entry) && entry.candidateIndex !== undefined && entry.candidateIndex > 0
              ? `${entry.status === "started" ? "Selected" : "Attempted"} candidate ${entry.candidateIndex + 1} after ${entry.candidateIndex} earlier candidate${entry.candidateIndex === 1 ? " was" : "s were"} unavailable.`
              : undefined;
          const failure =
            entry.status === "failed"
              ? this.failures.find((candidate) => candidate.index === entry.index)
              : undefined;
          return [
            ...(fallback ? wrapTextWithAnsi(this.theme.fg("dim", `  ${fallback}`), safeWidth) : []),
            ...(failure
              ? [
                  ...wrapTextWithAnsi(
                    this.theme.fg(
                      "error",
                      `Failure — ${sanitizeTerminalLine(entry.name)}${failure.code ? ` [${sanitizeTerminalLine(failure.code)}]` : ""}`,
                    ),
                    safeWidth,
                  ),
                  ...wrapTextWithAnsi(
                    this.theme.fg(
                      "dim",
                      clipWithMarker(sanitizeTerminalLine(failure.message), 2_048, "… [truncated]"),
                    ),
                    safeWidth,
                  ),
                  ...(failure.admittedRun
                    ? wrapTextWithAnsi(
                        this.theme.fg("dim", formatFailedStartRecovery(failure.admittedRun)),
                        safeWidth,
                      )
                    : []),
                  ...wrapTextWithAnsi(
                    this.theme.fg(
                      "accent",
                      `Next: ${
                        failure.admittedRun
                          ? failedStartRecoveryAction(failure.admittedRun)
                          : failureRecovery(failure.code, failure.message, "start")
                      }`,
                    ),
                    safeWidth,
                  ),
                ]
              : []),
          ];
        })
      : [];
    const showAllEntries = this.partial || this.expanded;
    const collapsedOutcomes =
      this.partial || this.expanded
        ? []
        : entries.flatMap((entry) => {
            if (entry.status === "failed")
              return receiptRow(
                entry,
                safeWidth,
                this.theme,
                this.failures.find((failure) => failure.index === entry.index),
              );
            if (!selectedRoute(entry) || !entry.warning) return [];
            return [
              truncateToWidth(
                this.theme.fg(
                  "warning",
                  `${managerNoticeGlyph("warning")} ${sanitizeTerminalLine(entry.name)} · ${sanitizeTerminalLine(entry.warning)}`,
                ),
                safeWidth,
              ),
            ];
          });
    return [
      truncateToWidth(receiptHeader(entries, this.partial, this.theme), safeWidth),
      ...(showAllEntries
        ? entries.flatMap((entry) =>
            receiptRow(
              entry,
              safeWidth,
              this.theme,
              this.failures.find((failure) => failure.index === entry.index),
            ),
          )
        : collapsedOutcomes),
      ...failureDetails,
      ...(!this.partial &&
      !this.expanded &&
      entries.some(
        (entry) =>
          entry.status === "failed" || (selectedRoute(entry) && entry.warning !== undefined),
      )
        ? [
            truncateToWidth(
              renderExpansionAffordance("launch details", false, this.theme),
              safeWidth,
            ),
          ]
        : []),
      ...(!this.partial && started > 0
        ? [truncateToWidth(this.theme.fg("dim", "→ /subagents for live status"), safeWidth)]
        : []),
    ];
  }

  invalidate(): void {
    // Partial header animation is derived from the current clock frame.
  }
}

export const renderStartProgressComponent = (
  failures: ReadonlyArray<SubagentStartFailure>,
  entries: ReadonlyArray<SubagentStartEntry>,
  expanded: boolean,
  theme: Theme,
): Component => new StartReceiptComponent(failures, entries, true, expanded, theme);

export const renderStartReceiptComponent = (
  failures: ReadonlyArray<SubagentStartFailure>,
  entries: ReadonlyArray<SubagentStartEntry>,
  expanded: boolean,
  theme: Theme,
): Component => new StartReceiptComponent(failures, entries, false, expanded, theme);
