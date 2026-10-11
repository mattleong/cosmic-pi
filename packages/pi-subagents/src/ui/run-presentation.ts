import type { Theme } from "@earendil-works/pi-coding-agent";
import { formatElapsed, formatRelativeAge, sanitizeTerminalLine } from "pi-cosmic-core";

const MAX_SESSION_DISPLAY_AGE = 7 * 24 * 60 * 60 * 1_000;

export const shortRunId = (id: string): string => (id.length <= 14 ? id : `…${id.slice(-13)}`);

export const duplicateRunNames = (
  runs: Iterable<{ readonly name: string }>,
): ReadonlySet<string> => {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const { name } of runs) (seen.has(name) ? duplicates : seen).add(name);
  return duplicates;
};

const sessionSpan = (later: number, earlier: number | undefined): number | undefined => {
  if (earlier === undefined) return undefined;
  const age = later - earlier;
  return Number.isFinite(age) && age >= 0 && age <= MAX_SESSION_DISPLAY_AGE ? age : undefined;
};

export const formatSessionAge = (later: number, earlier: number | undefined): string => {
  const span = sessionSpan(later, earlier);
  return span === undefined ? "" : formatElapsed(span);
};

export const formatSessionActivity = (now: number, earlier: number | undefined): string => {
  const span = sessionSpan(now, earlier);
  return span === undefined ? "" : formatRelativeAge(span);
};

interface RunRoutePresentationInput {
  readonly profile?: string | undefined;
  readonly host?: string | undefined;
  readonly runtime?: string | undefined;
  readonly model: string;
  readonly effort: string;
  readonly openaiFastMode?: boolean | undefined;
}

export const projectRunRoutePresentation = (run: RunRoutePresentationInput) => {
  const profile = sanitizeTerminalLine(run.profile ?? "generalist");
  const hostRuntime = `${sanitizeTerminalLine(run.host ?? "local")}/${sanitizeTerminalLine(run.runtime ?? "pi")}`;
  const providerModel = sanitizeTerminalLine(run.model);
  const providerSeparator = providerModel.indexOf("/");
  const modelName =
    providerSeparator < 0 ? providerModel : providerModel.slice(providerSeparator + 1);
  const effort = sanitizeTerminalLine(run.effort);
  const fast = run.openaiFastMode ? " ⚡" : "";
  return {
    profile,
    hostRuntime,
    model: `${providerModel}:${effort}${fast}`,
    narrowModel: `${modelName}:${effort}${fast}`,
  };
};

export const formatRunRoute = (run: RunRoutePresentationInput): string => {
  const route = projectRunRoutePresentation(run);
  return `${route.hostRuntime} · ${route.model}`;
};

export const formatRunRouteLine = (
  run: RunRoutePresentationInput,
  theme?: Pick<Theme, "fg">,
): string => {
  const { profile, hostRuntime, model } = projectRunRoutePresentation(run);
  return theme
    ? `${theme.fg("muted", profile)} ${theme.fg("dim", "→")} ${theme.fg("toolOutput", `${hostRuntime} · ${model}`)}`
    : `${profile} → ${hostRuntime} · ${model}`;
};
