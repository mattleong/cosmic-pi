import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { utf8ByteLength, utf8Prefix } from "./text.ts";

export interface AssistantText {
  readonly text: string;
  /** The text exceeded the limit and was cut at a code point boundary. */
  readonly truncated: boolean;
}

/**
 * The text of the latest assistant message on `branch`, its text parts concatenated as Pi does and
 * bounded to `limit` UTF-8 bytes. Like Pi, an aborted message without content doesn't count. The
 * text is empty when that message has no text parts; undefined when there is no assistant message.
 */
export const latestAssistantText = (
  branch: ReadonlyArray<SessionEntry>,
  limit: number,
): AssistantText | undefined => {
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (entry?.type !== "message" || entry.message.role !== "assistant") continue;
    const message = entry.message;
    if (message.stopReason === "aborted" && message.content.length === 0) continue;
    const text = message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
    return utf8ByteLength(text) <= limit
      ? { text, truncated: false }
      : { text: utf8Prefix(text, limit), truncated: true };
  }
  return undefined;
};
