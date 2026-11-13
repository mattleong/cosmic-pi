import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import * as Schema from "effect/Schema";
import { contentText } from "pi-cosmic-core/message-text";
import { stripTerminalControls } from "pi-cosmic-core/security";
import { indentedBody } from "./agent-text.ts";

const Envelope = Schema.Struct({
  customType: Schema.optional(Schema.String),
  content: Schema.optional(Schema.Union([Schema.String, Schema.Array(Schema.Unknown)])),
  details: Schema.optional(Schema.Unknown),
});

/** A custom message as Pi hands it to a message renderer; its details are decoded by each owner. */
export const decodeMessageEnvelope = Schema.decodeUnknownOption(Envelope, {
  onExcessProperty: "ignore",
});

/** A message as its recipient received it, the expanded body of one without a display copy. */
export const receivedMessageBody = (
  theme: Pick<Theme, "fg">,
  content: (typeof Envelope.Type)["content"],
): Component => indentedBody(theme, new Text(stripTerminalControls(contentText(content)), 0, 0));
