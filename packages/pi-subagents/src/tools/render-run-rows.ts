import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { sanitizeTerminalLine, synchronousNow } from "pi-cosmic-core";
import {
  animatedRunStateGlyph,
  runStateColor,
  runStateGlyph,
  runStateLabel,
} from "../ui/run-state.ts";
import type { SubagentRunCard } from "./details.ts";
import { formatCost, formatDuration, formatTokenCount, formatUsage } from "../ui/metrics.ts";
import { projectRunCardTree, runCardTreeBranch } from "./run-card-tree.ts";

const MAX_SESSION_DISPLAY_AGE = 7 * 24 * 60 * 60 * 1_000;

const shortRunId = (id: string): string => (id.length <= 14 ? id : `…${id.slice(-13)}`);

const displayAge = (later: number, earlier: number | undefined): string => {
  if (earlier === undefined) return "";
  const age = later - earlier;
  return age >= 0 && age <= MAX_SESSION_DISPLAY_AGE ? formatDuration(age) : "";
};

export const runTiming = (run: {
  readonly endedAt?: number | undefined;
  readonly lastActivityAt?: number | undefined;
  readonly startedAt?: number | undefined;
}): string => {
  const now = synchronousNow();
  const elapsed = displayAge(run.endedAt ?? now, run.startedAt);
  const activeAge = run.endedAt === undefined ? displayAge(now, run.lastActivityAt) : "";
  const active = activeAge ? `active ${activeAge} ago` : "";
  return [elapsed, active].filter(Boolean).join(" · ");
};

export const aggregateRunUsage = (
  runs: ReadonlyArray<{
    readonly usage?:
      | { readonly totalTokens: number; readonly cost?: number | undefined }
      | undefined;
  }>,
  style: "long" | "compact" = "long",
): string => {
  const tokens = runs.reduce((total, run) => total + (run.usage?.totalTokens ?? 0), 0);
  const knownCosts = runs.flatMap((run) => (run.usage?.cost === undefined ? [] : [run.usage.cost]));
  const cost = knownCosts.reduce((total, value) => total + value, 0);
  const costKnown = knownCosts.length > 0;
  // A subtotal over runs with unknown costs is explicitly marked as a lower bound.
  const partial = costKnown && knownCosts.length < runs.length;
  if (tokens <= 0 && (!costKnown || cost === 0)) return "";
  const lowerBound = partial ? (style === "compact" ? "≥" : "≥ ") : "";
  const costPart = costKnown ? ` · ${lowerBound}${formatCost(cost)}` : "";
  return `${formatTokenCount(tokens)} ${style === "compact" ? "tok" : "tokens"}${costPart}`;
};

const padVisible = (value: string, width: number): string =>
  `${value}${" ".repeat(Math.max(0, width - visibleWidth(value)))}`;

const runProfile = (run: SubagentRunCard): string =>
  sanitizeTerminalLine(run.profile ?? "generalist");

const runRoute = (run: SubagentRunCard): string =>
  `${runProfile(run)} → ${run.host ?? "local"}/${run.runtime ?? "pi"} · ${sanitizeTerminalLine(run.model)}:${run.effort}${run.fastMode ? " ⚡" : ""}`;

const themedRunRoute = (run: SubagentRunCard, theme: Theme): string =>
  `${theme.fg("muted", runProfile(run))} ${theme.fg("dim", "→")} ${theme.fg(
    "toolOutput",
    `${run.host ?? "local"}/${run.runtime ?? "pi"} · ${sanitizeTerminalLine(run.model)}:${run.effort}${run.fastMode ? " ⚡" : ""}`,
  )}`;

const renderRouteRail = (run: SubagentRunCard, width: number, theme: Theme): string[] => {
  const prefix = width > 5 ? "     " : "   ";
  const available = Math.max(1, width - visibleWidth(prefix));
  const routeLines = wrapTextWithAnsi(themedRunRoute(run, theme), available);
  return routeLines.map((line) => truncateToWidth(`${prefix}${line}`, width));
};

const runUsage = (run: SubagentRunCard): string => formatUsage(run.usage, "tok");

interface RunIdentity {
  readonly plain: string;
  readonly themed: string;
}

const renderHierarchyRow = (
  run: SubagentRunCard,
  identity: RunIdentity,
  usage: string,
  width: number,
  theme: Theme,
): string => {
  const themedIdentity = identity.themed;
  const timing = runTiming(run);
  const metadata = [
    themedRunRoute(run, theme),
    run.writeIntent === "writer" ? theme.fg("warning", "writer") : undefined,
    usage ? theme.fg("muted", usage) : undefined,
    run.currentTool ? theme.fg("accent", sanitizeTerminalLine(run.currentTool)) : undefined,
    timing ? theme.fg("muted", timing) : undefined,
  ]
    .filter((value): value is string => value !== undefined)
    .join(theme.fg("dim", " · "));
  const combined = `${themedIdentity}${theme.fg("dim", " · ")}${metadata}`;
  if (visibleWidth(combined) <= width) return combined;
  if (width < 12) return truncateToWidth(themedIdentity, width);
  const identityWidth = Math.min(
    visibleWidth(identity.plain),
    Math.max(8, Math.floor(width * 0.42)),
  );
  const metadataWidth = width - identityWidth - 3;
  if (metadataWidth < 8) return truncateToWidth(themedIdentity, width);
  return `${truncateToWidth(themedIdentity, identityWidth)}${theme.fg(
    "dim",
    " · ",
  )}${truncateToWidth(metadata, metadataWidth)}`;
};

export interface ResponsiveRunRowOptions {
  readonly frame?: number;
  readonly status?: (run: SubagentRunCard) => string;
  readonly fullId?: boolean;
  readonly hierarchy?:
    | {
        readonly awaitedRunIds?: ReadonlySet<string> | undefined;
      }
    | undefined;
}

export const renderResponsiveRunRows = (
  runs: ReadonlyArray<SubagentRunCard>,
  width: number,
  theme: Theme,
  options: ResponsiveRunRowOptions = {},
): string[] => {
  const safeWidth = Math.max(1, width);
  const treeRows = options.hierarchy ? projectRunCardTree(runs) : undefined;
  const displayRuns = treeRows?.map((row) => row.run) ?? runs;
  const identities = displayRuns.map((run, index): RunIdentity => {
    const glyph =
      options.frame === undefined
        ? runStateGlyph(run.state)
        : animatedRunStateGlyph(run.state, options.frame);
    const id = sanitizeTerminalLine(options.fullId ? run.id : shortRunId(run.id));
    const row = treeRows?.[index];
    const branch = row ? runCardTreeBranch(row) : "";
    const awaited = options.hierarchy?.awaitedRunIds?.has(run.id) ? "◎ " : "";
    const identity = `${branch}${awaited}${glyph} ${sanitizeTerminalLine(run.name)}`;
    return {
      plain: `${identity} · ${id}`,
      themed: `${theme.fg(runStateColor(run.state), identity)}${theme.fg("dim", " · ")}${theme.fg("muted", id)}`,
    };
  });
  const intents = displayRuns.map((run) =>
    sanitizeTerminalLine(run.writeIntent ?? "intent unknown"),
  );
  const states = displayRuns.map((run) =>
    sanitizeTerminalLine(
      options.status?.(run) ??
        [runStateLabel(run.state), run.currentTool, runTiming(run)].filter(Boolean).join(" · "),
    ),
  );
  const usages = displayRuns.map(runUsage);
  if (treeRows)
    return displayRuns.map((run, index) =>
      renderHierarchyRow(
        run,
        identities[index] ?? { plain: "", themed: "" },
        usages[index] ?? "",
        safeWidth,
        theme,
      ),
    );
  const routes = displayRuns.map(runRoute);
  const intentWidth = intents.reduce((max, intent) => Math.max(max, visibleWidth(intent)), 0);
  const minimumIdentityWidth = options.hierarchy ? 24 : 16;
  const identityWidth = Math.min(
    Math.max(minimumIdentityWidth, ...identities.map((identity) => visibleWidth(identity.plain))),
    Math.max(minimumIdentityWidth, Math.floor(safeWidth * (options.hierarchy ? 0.4 : 0.28))),
  );
  const stateWidth = Math.min(
    Math.max(14, ...states.map((state) => visibleWidth(state))),
    Math.max(14, Math.floor(safeWidth * 0.28)),
  );
  const hasUsage = usages.some(Boolean);
  const usageWidth = hasUsage
    ? Math.min(
        Math.max(...usages.map((usage) => visibleWidth(usage))),
        Math.max(8, Math.floor(safeWidth * 0.18)),
      )
    : 0;
  const routeWidth =
    safeWidth - identityWidth - intentWidth - stateWidth - usageWidth - (hasUsage ? 12 : 9);
  if (
    safeWidth >= 88 &&
    routeWidth >= 12 &&
    routes.every((route) => visibleWidth(route) <= routeWidth)
  )
    return displayRuns.map((run, index) => {
      const color = runStateColor(run.state);
      const identity = truncateToWidth(identities[index]?.themed ?? "", identityWidth);
      const route = themedRunRoute(run, theme);
      const intent = theme.fg(
        run.writeIntent === "writer" ? "warning" : "muted",
        intents[index] ?? "",
      );
      const usage = theme.fg("muted", truncateToWidth(usages[index] ?? "", usageWidth));
      const state = theme.fg(color, truncateToWidth(states[index] ?? "", stateWidth));
      const usageColumn = hasUsage ? ` · ${padVisible(usage, usageWidth)}` : "";
      return `${padVisible(identity, identityWidth)} · ${padVisible(route, routeWidth)} · ${padVisible(intent, intentWidth)}${usageColumn} · ${padVisible(state, stateWidth)}`;
    });
  return displayRuns.flatMap((run, index) => {
    const color = runStateColor(run.state);
    const identity = identities[index] ?? { plain: "", themed: "" };
    const compactStatus = [
      runStateLabel(run.state),
      run.currentTool ? sanitizeTerminalLine(run.currentTool) : undefined,
      run.writeIntent === "writer" ? "writer" : undefined,
      usages[index],
    ]
      .filter(Boolean)
      .join(" · ");
    const compactMinimumIdentityWidth = Math.min(24, Math.max(8, Math.floor(safeWidth * 0.45)));
    const maximumStatusWidth = safeWidth - compactMinimumIdentityWidth - 3;
    const identityLine = (() => {
      if (maximumStatusWidth < 7) return truncateToWidth(identity.themed, safeWidth);
      const compactStatusWidth = Math.min(
        visibleWidth(compactStatus),
        Math.max(7, Math.floor(safeWidth * 0.36)),
        maximumStatusWidth,
      );
      const compactIdentityWidth = safeWidth - compactStatusWidth - 3;
      return `${truncateToWidth(
        identity.themed,
        compactIdentityWidth,
      )} · ${truncateToWidth(theme.fg(color, compactStatus), compactStatusWidth)}`;
    })();
    return [identityLine, ...renderRouteRail(run, safeWidth, theme)];
  });
};
