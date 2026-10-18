import { Type } from "typebox";
import { MAX_IDENTITY_CHARS, MAX_MESSAGE_CHARS } from "../transport/protocol.ts";

const SessionId = Type.String({
  minLength: 1,
  maxLength: MAX_IDENTITY_CHARS,
  description: "The recipient's sessionId from session_list.",
});

export const SessionListParameters = Type.Object({});

export const SessionSendParameters = Type.Object({
  to: SessionId,
  message: Type.String({
    minLength: 1,
    maxLength: MAX_MESSAGE_CHARS,
    description: "Self-contained message text for the other session's agent.",
  }),
});

export const SessionReadParameters = Type.Object({ to: SessionId });
