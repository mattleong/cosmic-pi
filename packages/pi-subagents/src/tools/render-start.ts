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
import type { SubagentStartEntry } from "./details-schema.ts";
import { failedStartRecoveryAction, formatFailedStartRecovery } from "./format.ts";
import {
  composeToolComponent as renderComponent,
  renderExpansionAffordance,
} from "pi-cosmic-ui/tool";
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
  contentOnly = false,
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
  if (!contentOnly) container.addChild(header);
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

type SelectedStartEntry = Extract<SubagentStartEntry, { readonly routeStatus: "selected" }>;

const selectedRoute = (entry: SubagentStartEntry): entry is SelectedStartEntry =>
  entry.routeStatus === "selected";

const routeLabel = (entry: SubagentStartEntry): string => {
  if (selectedRoute(entry)) return formatRunRoute(entry);
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
  contentOnly = false,
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
  const recoveryStatus =
    recovery && !contentOnly
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
          const routeValue = `${theme.fg("muted", profile)} ${theme.fg("dim", "→")} ${theme.fg("toolOutput", route)}`;
          lines.push(
            ...wrapTextWithAnsi(routeValue, Math.max(1, safeWidth - 5)).map(
              (line, index) => `${theme.fg("dim", index === 0 ? "  ╰─ " : "     ")}${line}`,
            ),
          );
          if (id) lines.push(`  ${theme.fg("muted", id)}`);
          if (recovery && !contentOnly)
            lines.push(
              `  ${theme.fg("muted", `cleanup ${recovery.cleanupDisposition} · retry ${recovery.retryDisposition}`)}`,
            );
          return lines.map((line) => truncateToWidth(line, safeWidth));
        })();
  const warningLines =
    !contentOnly && selectedRoute(entry) && entry.warning
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

export const renderStartReceiptComponent = (
  failures: ReadonlyArray<SubagentStartFailure>,
  entries: ReadonlyArray<SubagentStartEntry>,
  expanded: boolean,
  theme: Theme,
  partial = false,
  contentOnly = false,
): Component =>
  renderComponent((width) => {
    const safeWidth = Math.max(1, width);
    const started = entries.filter((entry) => entry.status === "started").length;
    const failureOf = (entry: SubagentStartEntry) =>
      failures.find((failure) => failure.index === entry.index);
    const failureDetails = expanded
      ? entries.flatMap((entry) => {
          const fallback =
            selectedRoute(entry) && entry.candidateIndex !== undefined && entry.candidateIndex > 0
              ? `${entry.status === "started" ? "Selected" : "Attempted"} candidate ${entry.candidateIndex + 1} after ${entry.candidateIndex} earlier candidate${entry.candidateIndex === 1 ? " was" : "s were"} unavailable.`
              : undefined;
          const failure = !contentOnly && entry.status === "failed" ? failureOf(entry) : undefined;
          return [
            ...(fallback ? wrapTextWithAnsi(theme.fg("dim", `  ${fallback}`), safeWidth) : []),
            ...(failure
              ? [
                  ...wrapTextWithAnsi(
                    theme.fg(
                      "error",
                      `Failure — ${sanitizeTerminalLine(entry.name)}${failure.code ? ` [${sanitizeTerminalLine(failure.code)}]` : ""}`,
                    ),
                    safeWidth,
                  ),
                  ...wrapTextWithAnsi(
                    theme.fg(
                      "dim",
                      clipWithMarker(sanitizeTerminalLine(failure.message), 2_048, "… [truncated]"),
                    ),
                    safeWidth,
                  ),
                  ...(failure.admittedRun
                    ? wrapTextWithAnsi(
                        theme.fg("dim", formatFailedStartRecovery(failure.admittedRun)),
                        safeWidth,
                      )
                    : []),
                  ...wrapTextWithAnsi(
                    theme.fg(
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
    const showAllEntries = partial || expanded;
    const collapsedOutcomes = showAllEntries
      ? []
      : entries.flatMap((entry) => {
          if (entry.status === "failed")
            return receiptRow(entry, safeWidth, theme, failureOf(entry));
          if (!selectedRoute(entry) || !entry.warning) return [];
          return [
            truncateToWidth(
              theme.fg(
                "warning",
                `${managerNoticeGlyph("warning")} ${sanitizeTerminalLine(entry.name)} · ${sanitizeTerminalLine(entry.warning)}`,
              ),
              safeWidth,
            ),
          ];
        });
    return [
      ...(!contentOnly ? [truncateToWidth(receiptHeader(entries, partial, theme), safeWidth)] : []),
      ...(showAllEntries
        ? entries.flatMap((entry) =>
            receiptRow(entry, safeWidth, theme, failureOf(entry), contentOnly),
          )
        : collapsedOutcomes),
      ...failureDetails,
      ...(!partial &&
      !expanded &&
      entries.some(
        (entry) =>
          entry.status === "failed" || (selectedRoute(entry) && entry.warning !== undefined),
      )
        ? [truncateToWidth(renderExpansionAffordance("launch details", false, theme), safeWidth)]
        : []),
      ...(!partial && started > 0
        ? [truncateToWidth(theme.fg("dim", "→ /subagents for live status"), safeWidth)]
        : []),
    ];
  });
