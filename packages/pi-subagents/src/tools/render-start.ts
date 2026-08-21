import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  Container,
  Text,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
} from "@earendil-works/pi-tui";
import { managerNoticeGlyph, managerStateGlyph, startingSpinnerFrame } from "pi-cosmic-ui/manager";
import { synchronousNow } from "../boundary/native-clock.ts";
import { clipWithMarker, safeTextPrefix } from "../run/state.ts";
import { sanitizeTerminalLine } from "../ui/sanitize.ts";
import type { SubagentRunCard, SubagentStartEntry } from "./details.ts";
import { formatToolModel, formatToolRoute } from "./format.ts";
import { failureRecovery } from "./render-management.ts";
import type { SubagentStartSpec } from "./schema.ts";
import type { SubagentStartFailure } from "./subagent.ts";

const shortRunId = (id: string): string => (id.length <= 14 ? id : `…${id.slice(-13)}`);

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
  const header = new Text(
    `${theme.fg("toolTitle", theme.bold(title))}${clippedSummary ? ` ${theme.fg("dim", clippedSummary)}` : ""}`,
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
      const recovery = failureRecovery(failure.code, failure.message, "start");
      return `${summary}\n${theme.fg("dim", detail)}\n${theme.fg("accent", `Next: ${recovery}`)}`;
    })
    .join("\n");

const selectedRoute = (entry: SubagentStartEntry): boolean =>
  entry.routeStatus === "selected" &&
  entry.host !== undefined &&
  entry.runtime !== undefined &&
  entry.model !== undefined &&
  entry.effort !== undefined;

const hydrateEntry = (
  entry: SubagentStartEntry,
  cards: ReadonlyArray<SubagentRunCard>,
): SubagentStartEntry => {
  if (selectedRoute(entry) || entry.status !== "started") return entry;
  const card = entry.runId
    ? cards.find((candidate) => candidate.id === entry.runId)
    : cards.find((candidate) => candidate.name === entry.name);
  if (!card || card.host === undefined || card.runtime === undefined) return entry;
  return (() => {
    const baseResult = {
      ...entry,
      profile: card.profile ?? entry.profile,
      routeStatus: "selected" as const,
      host: card.host,
      runtime: card.runtime,
      model: card.model,
      effort: card.effort,
    };
    const withFastMode = card.fastMode ? { ...baseResult, fastMode: true as const } : baseResult;
    const withCandidateIndex =
      card.selection.candidateIndex === undefined
        ? withFastMode
        : { ...withFastMode, candidateIndex: card.selection.candidateIndex };
    const withRunId = { ...withCandidateIndex, runId: card.id };
    return withRunId;
  })();
};

const legacyEntries = (
  cards: ReadonlyArray<SubagentRunCard>,
  failures: ReadonlyArray<SubagentStartFailure>,
): ReadonlyArray<SubagentStartEntry> => {
  const failedIndexes = new Set(failures.map((failure) => Math.max(0, Math.floor(failure.index))));
  let nextSuccessIndex = 0;
  const successes = cards.map((card): SubagentStartEntry => {
    while (failedIndexes.has(nextSuccessIndex)) nextSuccessIndex += 1;
    const index = nextSuccessIndex++;
    return (() => {
      const baseResult = {
        index,
        name: card.name,
        profile: card.profile ?? "generalist",
        status: "started" as const,
        routeStatus:
          card.host !== undefined && card.runtime !== undefined
            ? ("selected" as const)
            : ("unavailable" as const),
      };
      const withHost = card.host === undefined ? baseResult : { ...baseResult, host: card.host };
      const withRuntime =
        card.runtime === undefined ? withHost : { ...withHost, runtime: card.runtime };
      const withModelAndEffort = { ...withRuntime, model: card.model, effort: card.effort };
      const withFastMode = card.fastMode
        ? { ...withModelAndEffort, fastMode: true as const }
        : withModelAndEffort;
      const withCandidateIndex =
        card.selection.candidateIndex === undefined
          ? withFastMode
          : { ...withFastMode, candidateIndex: card.selection.candidateIndex };
      const withRunId = { ...withCandidateIndex, runId: card.id };
      return withRunId;
    })();
  });
  return [
    ...successes,
    ...failures.map(
      (failure): SubagentStartEntry => ({
        index: Math.max(0, Math.floor(failure.index)),
        name: failure.name ?? `launch ${failure.index + 1}`,
        profile: "generalist",
        status: "failed",
        routeStatus: "unavailable",
      }),
    ),
  ];
};

const reconcileEntries = (
  explicit: ReadonlyArray<SubagentStartEntry>,
  cards: ReadonlyArray<SubagentRunCard>,
  failures: ReadonlyArray<SubagentStartFailure>,
): ReadonlyArray<SubagentStartEntry> => {
  if (explicit.length === 0) return legacyEntries(cards, failures);
  const recovered = legacyEntries(cards, failures).filter((candidate) =>
    candidate.status === "failed"
      ? !explicit.some((entry) => entry.status === "failed" && entry.index === candidate.index)
      : !explicit.some(
          (entry) =>
            entry.status === "started" &&
            ((entry.runId !== undefined && entry.runId === candidate.runId) ||
              (entry.runId === undefined && entry.name === candidate.name)),
        ),
  );
  return [...explicit, ...recovered];
};

const routeLabel = (entry: SubagentStartEntry): string => {
  if (selectedRoute(entry))
    return formatToolRoute(
      entry.host ?? "local",
      entry.runtime ?? "pi",
      entry.model ?? "unknown model",
      entry.effort ?? "off",
      entry.fastMode,
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

const receiptRow = (entry: SubagentStartEntry, width: number, theme: Theme): string[] => {
  const safeWidth = Math.max(1, width);
  const { glyph, color } = receiptPresentation(entry);
  const name = sanitizeTerminalLine(entry.name);
  const profile = sanitizeTerminalLine(entry.profile || "generalist");
  const route = routeLabel(entry);
  const id = entry.runId ? sanitizeTerminalLine(shortRunId(entry.runId)) : "";
  const raw = `${glyph} ${name} · ${profile} · ${route}${id ? ` · ${id}` : ""}`;
  if (visibleWidth(raw) <= safeWidth)
    return [
      `${theme.fg(color, glyph)} ${theme.fg("toolTitle", name)} · ${theme.fg("muted", profile)} · ${theme.fg("toolOutput", route)}${id ? ` · ${theme.fg("muted", id)}` : ""}`,
    ];

  const lines = [
    `${theme.fg(color, glyph)} ${theme.fg("toolTitle", name)}`,
    `  ${theme.fg("muted", profile)}`,
  ];
  if (selectedRoute(entry)) {
    lines.push(
      `  ${theme.fg("toolOutput", `${entry.host ?? "local"}/${entry.runtime ?? "pi"}`)}`,
      `  ${theme.fg(
        "toolOutput",
        formatToolModel(entry.model ?? "unknown model", entry.effort ?? "off", entry.fastMode),
      )}`,
    );
  } else {
    lines.push(`  ${theme.fg("toolOutput", route)}`);
  }
  if (id) lines.push(`  ${theme.fg("muted", id)}`);
  return lines.map((line) => truncateToWidth(line, safeWidth));
};

const receiptHeader = (
  entries: ReadonlyArray<SubagentStartEntry>,
  partial: boolean,
  fallbackProgress: string,
  exactEntries: boolean,
  theme: Theme,
): string => {
  const total = entries.length;
  const started = entries.filter((entry) => entry.status === "started").length;
  const failed = entries.filter((entry) => entry.status === "failed").length;
  const pending = total - started - failed;
  if (partial) {
    const frame = Math.floor(synchronousNow() / 160);
    const progress =
      exactEntries && total > 0
        ? `Launching ${started + failed} of ${total} · ${started} started · ${failed} failed · ${pending} pending`
        : fallbackProgress;
    return theme.fg("warning", `${startingSpinnerFrame(frame)} ${progress}`);
  }
  if (total === 0)
    return theme.fg("warning", `${managerNoticeGlyph("warning")} Launch receipt unavailable`);
  if (failed === 0)
    return theme.fg(
      "success",
      `${managerStateGlyph("done")} Started ${started} subagent${started === 1 ? "" : "s"}`,
    );
  if (started > 0)
    return theme.fg(
      "warning",
      `${managerNoticeGlyph("warning")} Started ${started} of ${total} subagents · ${failed} failed`,
    );
  return theme.fg(
    "error",
    `${managerStateGlyph("failed")} Failed to start ${failed} subagent${failed === 1 ? "" : "s"}`,
  );
};

class StartReceiptComponent implements Component {
  constructor(
    private readonly progress: string,
    private readonly cards: ReadonlyArray<SubagentRunCard>,
    private readonly failures: ReadonlyArray<SubagentStartFailure>,
    private readonly entries: ReadonlyArray<SubagentStartEntry>,
    private readonly partial: boolean,
    private readonly expanded: boolean,
    private readonly theme: Theme,
  ) {}

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const entries = [...reconcileEntries(this.entries, this.cards, this.failures)]
      .sort((left, right) => left.index - right.index)
      .map((entry) => hydrateEntry(entry, this.cards));
    const started = entries.filter((entry) => entry.status === "started").length;
    const failureDetails = this.expanded
      ? entries.flatMap((entry) => {
          const fallback =
            entry.candidateIndex !== undefined && entry.candidateIndex > 0
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
                  ...wrapTextWithAnsi(
                    this.theme.fg(
                      "accent",
                      `Next: ${failureRecovery(failure.code, failure.message, "start")}`,
                    ),
                    safeWidth,
                  ),
                ]
              : []),
          ];
        })
      : [];
    return [
      truncateToWidth(
        receiptHeader(entries, this.partial, this.progress, this.entries.length > 0, this.theme),
        safeWidth,
      ),
      ...entries.flatMap((entry) => receiptRow(entry, safeWidth, this.theme)),
      ...failureDetails,
      ...(!this.expanded && this.failures.length > 0
        ? [truncateToWidth(this.theme.fg("dim", "▸ failure details · expand to view"), safeWidth)]
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
  progress: string,
  runs: ReadonlyArray<SubagentRunCard>,
  failures: ReadonlyArray<SubagentStartFailure>,
  entries: ReadonlyArray<SubagentStartEntry>,
  expanded: boolean,
  theme: Theme,
): Component => new StartReceiptComponent(progress, runs, failures, entries, true, expanded, theme);

export const renderStartReceiptComponent = (
  runs: ReadonlyArray<SubagentRunCard>,
  failures: ReadonlyArray<SubagentStartFailure>,
  entries: ReadonlyArray<SubagentStartEntry>,
  expanded: boolean,
  theme: Theme,
): Component => new StartReceiptComponent("", runs, failures, entries, false, expanded, theme);
