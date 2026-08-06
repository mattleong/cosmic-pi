const RIGHT_SPLIT_MINIMUM_WIDTH = 100;

export const selectSplitDirection = (width: number): "right" | "down" =>
  width >= RIGHT_SPLIT_MINIMUM_WIDTH ? "right" : "down";

const safeNamePart = (value: string): string =>
  value
    .toLowerCase()
    .replaceAll(/[^a-z0-9_-]+/gu, "-")
    .replaceAll(/-+/gu, "-")
    .replaceAll(/^-|-$/gu, "");

export const makeAgentName = (sessionId: string, paneId: string): string => {
  const session = safeNamePart(sessionId).slice(0, 12) || "session";
  const pane = safeNamePart(paneId).slice(-8) || "pane";
  return `fork-${session}-${pane}`.slice(0, 32).replaceAll(/-$/gu, "");
};

export const initialForkPrompt = (prompt: string): string => `Initial fork request:\n${prompt}`;
