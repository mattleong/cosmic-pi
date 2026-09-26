import type { Theme } from "@earendil-works/pi-coding-agent";
import { sanitizeTerminalLine } from "pi-cosmic-core";
import { formatDuration } from "./metrics.ts";

const MAX_SESSION_DISPLAY_AGE = 7 * 24 * 60 * 60 * 1_000;

export const shortRunId = (id: string): string => (id.length <= 14 ? id : `…${id.slice(-13)}`);

export const formatSessionAge = (later: number, earlier: number | undefined): string => {
  if (earlier === undefined) return "";
  const age = later - earlier;
  return Number.isFinite(age) && age >= 0 && age <= MAX_SESSION_DISPLAY_AGE
    ? formatDuration(age)
    : "";
};

export interface RunRoutePresentationInput {
  readonly profile?: string | undefined;
  readonly host?: string | undefined;
  readonly runtime?: string | undefined;
  readonly model: string;
  readonly effort: string;
  readonly openaiFastMode?: boolean | undefined;
}

export interface RunRoutePresentation {
  readonly profile: string;
  readonly hostRuntime: string;
  readonly model: string;
  readonly narrowModel: string;
}

export const projectRunRoutePresentation = (
  run: RunRoutePresentationInput,
): RunRoutePresentation => {
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

/** The wide `profile → host/runtime · model` line, themed when a theme is supplied. */
export const formatRunRouteLine = (
  run: RunRoutePresentationInput,
  theme?: Pick<Theme, "fg">,
): string => {
  const { profile, hostRuntime, model } = projectRunRoutePresentation(run);
  return theme
    ? `${theme.fg("muted", profile)} ${theme.fg("dim", "→")} ${theme.fg("toolOutput", `${hostRuntime} · ${model}`)}`
    : `${profile} → ${hostRuntime} · ${model}`;
};
