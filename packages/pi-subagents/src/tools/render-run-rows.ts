import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { synchronousNow } from "../boundary/native-clock.ts";
import {
  animatedRunStateGlyph,
  runStateColor,
  runStateGlyph,
  runStateLabel,
} from "../ui/run-state.ts";
import { sanitizeTerminalLine } from "../ui/sanitize.ts";
import type { SubagentRunCard } from "./details.ts";
import { formatCost, formatDuration, formatTokenCount } from "./format.ts";

const MAX_SESSION_DISPLAY_AGE = 7 * 24 * 60 * 60 * 1_000;

const shortRunId = (id: string): string => (id.length <= 14 ? id : `…${id.slice(-13)}`);

const displayAge = (later: number, earlier: number | undefined): string => {
  if (earlier === undefined) return "";
  const age = later - earlier;
  return age >= 0 && age <= MAX_SESSION_DISPLAY_AGE ? formatDuration(age) : "";
};

export const runTiming = (run: SubagentRunCard): string => {
  const now = synchronousNow();
  const elapsed = displayAge(run.endedAt ?? now, run.startedAt);
  const activeAge = run.endedAt === undefined ? displayAge(now, run.lastActivityAt) : "";
  const active = activeAge ? `active ${activeAge} ago` : "";
  return [elapsed, active].filter(Boolean).join(" · ");
};

export const aggregateRunUsage = (runs: ReadonlyArray<SubagentRunCard>): string => {
  const tokens = runs.reduce((total, run) => total + (run.usage?.totalTokens ?? 0), 0);
  const cost = runs.reduce((total, run) => total + (run.usage?.cost ?? 0), 0);
  return tokens > 0 || cost > 0 ? `${formatTokenCount(tokens)} tokens · ${formatCost(cost)}` : "";
};

const padVisible = (value: string, width: number): string =>
  `${value}${" ".repeat(Math.max(0, width - visibleWidth(value)))}`;

const runRoute = (run: SubagentRunCard, width: number): string => {
  const hostRoute = `${run.host ?? "local"}/${run.runtime ?? "pi"} · `;
  const suffix = `:${run.effort}${run.fastMode ? " ⚡" : ""}`;
  const profile = run.profile ? `[${sanitizeTerminalLine(run.profile)}] ` : "";
  const fixedWidth = visibleWidth(profile) + visibleWidth(hostRoute) + visibleWidth(suffix);
  const modelWidth = Math.max(1, width - fixedWidth);
  return truncateToWidth(
    `${profile}${hostRoute}${truncateToWidth(sanitizeTerminalLine(run.model), modelWidth)}${suffix}`,
    width,
  );
};

const runUsage = (run: SubagentRunCard): string =>
  run.usage && (run.usage.totalTokens > 0 || run.usage.cost > 0)
    ? `${formatTokenCount(run.usage.totalTokens)} tok · ${formatCost(run.usage.cost)}`
    : "";

export interface ResponsiveRunRowOptions {
  readonly frame?: number;
  readonly status?: (run: SubagentRunCard) => string;
  readonly fullId?: boolean;
}

export const renderResponsiveRunRows = (
  runs: ReadonlyArray<SubagentRunCard>,
  width: number,
  theme: Theme,
  options: ResponsiveRunRowOptions = {},
): string[] => {
  const safeWidth = Math.max(1, width);
  const identities = runs.map((run) => {
    const glyph =
      options.frame === undefined
        ? runStateGlyph(run.state)
        : animatedRunStateGlyph(run.state, options.frame);
    const id = options.fullId ? run.id : shortRunId(run.id);
    return `${glyph} ${sanitizeTerminalLine(run.name)} · ${sanitizeTerminalLine(id)}`;
  });
  const intents = runs.map((run) => sanitizeTerminalLine(run.writeIntent ?? "intent unknown"));
  const states = runs.map((run) =>
    sanitizeTerminalLine(
      options.status?.(run) ??
        [runStateLabel(run.state), run.currentTool, runTiming(run)].filter(Boolean).join(" · "),
    ),
  );
  const intentWidth = intents.reduce((max, intent) => Math.max(max, visibleWidth(intent)), 0);
  const identityWidth = Math.min(
    Math.max(16, ...identities.map((identity) => visibleWidth(identity))),
    Math.max(16, Math.floor(safeWidth * 0.28)),
  );
  const stateWidth = Math.min(
    Math.max(14, ...states.map((state) => visibleWidth(state))),
    Math.max(14, Math.floor(safeWidth * 0.28)),
  );
  const routeWidth = safeWidth - identityWidth - intentWidth - stateWidth - 9;
  if (safeWidth >= 88 && routeWidth >= 12)
    return runs.map((run, index) => {
      const color = runStateColor(run.state);
      const identity = theme.fg(color, truncateToWidth(identities[index] ?? "", identityWidth));
      const route = theme.fg("toolOutput", runRoute(run, routeWidth));
      const intent = theme.fg(
        run.writeIntent === "writer" ? "warning" : "muted",
        intents[index] ?? "",
      );
      const state = theme.fg(color, truncateToWidth(states[index] ?? "", stateWidth));
      return `${padVisible(identity, identityWidth)} · ${padVisible(route, routeWidth)} · ${padVisible(intent, intentWidth)} · ${padVisible(state, stateWidth)}`;
    });
  return runs.flatMap((run, index) => {
    const color = runStateColor(run.state);
    const identity = theme.fg(color, identities[index] ?? "");
    const intentText = intents[index] ?? "";
    const compactRouteWidth = Math.max(1, safeWidth - visibleWidth(intentText) - 3);
    const route = theme.fg("toolOutput", runRoute(run, compactRouteWidth));
    const metadata = `${route} · ${theme.fg(run.writeIntent === "writer" ? "warning" : "muted", intentText)}`;
    const status = [states[index] ?? "", runUsage(run)].filter(Boolean).join(" · ");
    return [
      truncateToWidth(identity, safeWidth),
      truncateToWidth(metadata, safeWidth),
      truncateToWidth(theme.fg(color, status), safeWidth),
    ];
  });
};
