import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  Container,
  Text,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
} from "@earendil-works/pi-tui";
import { expandedSection, previewIssuesSlot } from "pi-code-previews";
import { sanitizeTerminalLine, synchronousNow, countLabel } from "pi-cosmic-core";
import {
  managerStateGlyph,
  startingSpinnerFrame,
  clipToWidth,
  spinnerFrameAt,
} from "pi-cosmic-ui/manager";
import { clipWithMarker } from "../run/state.ts";
import { formatRunRoute, shortRunId } from "../ui/run-presentation.ts";
import type { SubagentStartEntry } from "./details-schema.ts";
import { failedStartRecoveryAction, formatFailedStartRecovery } from "./format.ts";
import {
  composeToolComponent as renderComponent,
  renderExpansionAffordance,
  renderToolHeader,
  toolStatusLine,
} from "pi-cosmic-ui/tool";
import { failureRecovery } from "./render-management.ts";
import type { SubagentStartFailure } from "./model.ts";
import type { SubagentStartSpec } from "./schema.ts";

const requestedName = (agent: SubagentStartSpec, index: number): string =>
  sanitizeTerminalLine(agent.name?.trim() || `launch ${index + 1}`);

const requestedProfile = (agent: SubagentStartSpec): string =>
  sanitizeTerminalLine(agent.profile?.trim() || "default selection");

/**
 * Static request projection: collapsed stays compact; expanded alone reveals bounded tasks.
 * Preview style's issue lines sit directly under the heading, above the tasks.
 */
export const renderSubagentStartCall = (
  agents: ReadonlyArray<SubagentStartSpec>,
  theme: Theme,
  expanded: boolean,
  contentOnly = false,
  context?: { readonly state: object },
): Component => {
  const requested = agents
    .map((agent, index) => `${requestedName(agent, index)} [${requestedProfile(agent)}]`)
    .join(", ");
  const container = new Container();
  if (!contentOnly) {
    container.addChild(
      new Text(
        renderToolHeader(
          {
            title:
              agents.length === 0
                ? "Start subagents"
                : `Start ${countLabel(agents.length, "subagent")}`,
            subtitle: requested,
          },
          theme,
        ),
        0,
        0,
      ),
    );
    if (context) container.addChild(previewIssuesSlot(context));
  }
  if (!expanded) {
    container.addChild(
      new Text(renderExpansionAffordance("tasks & launch details", false, theme), 0, 0),
    );
    return container;
  }
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

interface ReceiptRowOptions {
  /** Expanded rows show run IDs and cleanup state; collapsed rows only tell names apart. */
  readonly expanded: boolean;
  readonly sharedNames: ReadonlySet<string>;
  readonly failure?: SubagentStartFailure | undefined;
}

const receiptRunId = (entry: SubagentStartEntry, options: ReceiptRowOptions): string => {
  const runId =
    entry.status === "started"
      ? entry.runId
      : entry.status === "failed"
        ? options.failure?.admittedRun?.runId
        : undefined;
  if (runId === undefined) return "";
  if (options.expanded) return sanitizeTerminalLine(runId);
  return options.sharedNames.has(entry.name) ? sanitizeTerminalLine(shortRunId(runId)) : "";
};

const receiptRow = (
  entry: SubagentStartEntry,
  width: number,
  theme: Theme,
  options: ReceiptRowOptions,
): string[] => {
  const safeWidth = Math.max(1, width);
  const { glyph, color } = receiptPresentation(entry);
  const name = sanitizeTerminalLine(entry.name);
  const profile = sanitizeTerminalLine(entry.profile || "generalist");
  const route = routeLabel(entry);
  const id = receiptRunId(entry, options);
  const raw = `${glyph} ${name} · ${profile} · ${route}${id ? ` · ${id}` : ""}`;
  if (visibleWidth(raw) <= safeWidth)
    return [
      `${theme.fg(color, glyph)} ${theme.fg("toolTitle", name)} · ${theme.fg("muted", profile)} · ${theme.fg("toolOutput", route)}${id ? ` · ${theme.fg("muted", id)}` : ""}`,
    ];
  const lines = [`${theme.fg(color, glyph)} ${theme.fg("toolTitle", name)}`];
  const routeValue = `${theme.fg("muted", profile)} ${theme.fg("dim", "→")} ${theme.fg("toolOutput", route)}`;
  lines.push(
    ...wrapTextWithAnsi(routeValue, Math.max(1, safeWidth - 5)).map(
      (line, index) => `${theme.fg("dim", index === 0 ? "  ╰─ " : "     ")}${line}`,
    ),
  );
  if (id) lines.push(`  ${theme.fg("muted", id)}`);
  return lines.map((line) => clipToWidth(line, safeWidth));
};

/** Routine launch counts as muted text; failures are the shell's issue lines. */
const receiptCounters = (
  entries: ReadonlyArray<SubagentStartEntry>,
  partial: boolean,
  theme: Theme,
): string => {
  const total = entries.length;
  const started = entries.filter((entry) => entry.status === "started").length;
  const failed = entries.filter((entry) => entry.status === "failed").length;
  const pending = total - started - failed;
  if (partial)
    return toolStatusLine(
      theme,
      "running",
      [
        `Launching ${started + failed} of ${total}`,
        `${started} started`,
        ...(failed > 0 ? [`${failed} failed`] : []),
        ...(pending > 0 ? [`${pending} pending`] : []),
      ].join(" · "),
      spinnerFrameAt(synchronousNow()),
    );
  if (total === 0) return theme.fg("muted", "No launch receipt");
  return theme.fg(
    "muted",
    [`${started}/${total} started`, ...(failed > 0 ? [`${failed} failed`] : [])].join(" · "),
  );
};

/** One failed launch's evidence and the agent's next step, under its own label. */
const launchFailureSection = (
  entry: SubagentStartEntry,
  failure: SubagentStartFailure,
  theme: Theme,
): Component =>
  expandedSection(
    theme,
    `${sanitizeTerminalLine(entry.name)} couldn't start`,
    new Text(
      [
        theme.fg(
          "toolOutput",
          clipWithMarker(sanitizeTerminalLine(failure.message), 2_048, "… [truncated]"),
        ),
        ...(failure.admittedRun
          ? [theme.fg("dim", formatFailedStartRecovery(failure.admittedRun))]
          : []),
        theme.fg(
          "dim",
          `Next: ${
            failure.admittedRun
              ? failedStartRecoveryAction(failure.admittedRun)
              : failureRecovery(failure.code, failure.message, "start")
          }`,
        ),
      ].join("\n"),
      0,
      0,
    ),
  );

const sharedEntryNames = (entries: ReadonlyArray<SubagentStartEntry>): ReadonlySet<string> => {
  const seen = new Set<string>();
  const shared = new Set<string>();
  for (const entry of entries) (seen.has(entry.name) ? shared : seen).add(entry.name);
  return shared;
};

/** Collapsed receipts list this many launches; the call's affordance reveals the rest. */
const COLLAPSED_ROWS = 6;

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
    const sharedNames = sharedEntryNames(entries);
    const failureOf = (entry: SubagentStartEntry) =>
      failures.find((failure) => failure.index === entry.index);
    const shown = expanded ? entries : entries.slice(0, COLLAPSED_ROWS);
    const rows = shown.flatMap((entry) => {
      const failure = failureOf(entry);
      const row = receiptRow(entry, safeWidth, theme, { expanded, sharedNames, failure });
      if (!expanded) return row;
      const fallback =
        selectedRoute(entry) && entry.candidateIndex !== undefined && entry.candidateIndex > 0
          ? `${entry.status === "started" ? "Selected" : "Attempted"} candidate ${entry.candidateIndex + 1} after ${countLabel(entry.candidateIndex, "earlier candidate")} ${entry.candidateIndex === 1 ? "was" : "were"} unavailable.`
          : undefined;
      return [
        ...row,
        ...(fallback ? wrapTextWithAnsi(theme.fg("dim", `  ${fallback}`), safeWidth) : []),
        ...(!contentOnly && entry.status === "failed" && failure
          ? launchFailureSection(entry, failure, theme).render(safeWidth)
          : []),
      ];
    });
    const hidden = entries.length - shown.length;
    return [
      ...(!contentOnly ? [clipToWidth(receiptCounters(entries, partial, theme), safeWidth)] : []),
      ...rows,
      ...(hidden > 0
        ? [
            clipToWidth(
              theme.fg("dim", `… ${countLabel(hidden, "more launch", "more launches")}`),
              safeWidth,
            ),
          ]
        : []),
      ...(!partial && started > 0
        ? [clipToWidth(theme.fg("dim", "→ /subagents for live status"), safeWidth)]
        : []),
    ];
  });
