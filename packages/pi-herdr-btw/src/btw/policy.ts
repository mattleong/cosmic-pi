import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Str from "effect/String";

const RIGHT_SPLIT_MINIMUM_WIDTH = 100;

export const selectSplitDirection = (width: number): "right" | "down" =>
  width >= RIGHT_SPLIT_MINIMUM_WIDTH ? "right" : "down";

const safeNamePart = (value: string): string =>
  Fn.pipe(
    value,
    Str.toLowerCase,
    Str.replaceAll(/[^a-z0-9_-]+/gu, "-"),
    Str.replaceAll(/-+/gu, "-"),
    Str.replaceAll(/^-|-$/gu, ""),
  );

export const sideSessionAgentName = (sessionId: string, paneId: string): string => {
  const session = Fn.pipe(safeNamePart(sessionId), Str.slice(0, 12)) || "session";
  const pane = Fn.pipe(safeNamePart(paneId), Str.slice(-8)) || "pane";
  return Fn.pipe(`btw-${session}-${pane}`, Str.slice(0, 32), Str.replaceAll(/-$/gu, ""));
};

export const parentBtwDisplayName = (cwd: string): string => {
  const directoryName = Arr.lastNonEmpty(
    Fn.pipe(cwd, Str.replaceAll(/\/+$/gu, ""), Str.split("/")),
  );
  return `BTW · ${directoryName === "" ? "Pi" : directoryName}`;
};

export const sideSessionPrompt = (prompt: string): string => `Side-session request:\n${prompt}`;
