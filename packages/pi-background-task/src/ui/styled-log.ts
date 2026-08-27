import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { sanitizeTerminalStyledFragments } from "pi-cosmic-core";
import type { BackgroundLogEvent, BackgroundLogStream } from "../task/model.ts";

export interface StyledLogLine {
  readonly stream: BackgroundLogStream;
  readonly text: string;
}

const closeVisualStyle = (line: string): string =>
  line.includes("\u001b[") && !line.endsWith("\u001b[0m") ? `${line}\u001b[0m` : line;

/**
 * Render chronological stdout/stderr events into independently safe styled rows. Core-owned
 * parser and SGR state are retained per stream, so interleaved pipe chunks cannot split or leak
 * controls; manager framing closes each visible group before its border.
 */
export function styledBackgroundLogLines(
  events: ReadonlyArray<BackgroundLogEvent>,
): ReadonlyArray<StyledLogLine> {
  const fragments = sanitizeTerminalStyledFragments(
    events.map(({ stream, text }) => ({
      channel: stream,
      text,
    })),
  );
  const lines: StyledLogLine[] = [];
  let groupStream: BackgroundLogStream | undefined;
  let group: string[] = [];
  const flush = () => {
    if (groupStream === undefined || group.length === 0) return;
    const styled = group.join("");
    const width = styled
      .split("\n")
      .reduce((maximum, line) => Math.max(maximum, visibleWidth(line)), 1);
    for (const line of wrapTextWithAnsi(styled, width)) {
      if (visibleWidth(line) > 0) lines.push({ stream: groupStream, text: closeVisualStyle(line) });
    }
    group = [];
  };

  for (const fragment of fragments) {
    if (groupStream !== undefined && fragment.channel !== groupStream) flush();
    groupStream = fragment.channel;
    if (fragment.text.length === 0) continue;
    group.push(group.length === 0 ? `${fragment.reopenSgr}${fragment.text}` : fragment.text);
  }
  flush();
  return lines;
}
