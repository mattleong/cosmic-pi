import { toolArgumentPreparer, type ToolFieldAliases } from "pi-cosmic-core/tool-arguments";
import { Type, type Static, type TObject } from "typebox";
import { Check } from "typebox/value";
import { MAX_IDENTITY_CHARS, MAX_MESSAGE_CHARS } from "../transport/protocol.ts";
import type { SessionToolName } from "./contract.ts";

const strictObjectOptions = { additionalProperties: false } as const;

const SessionId = Type.String({
  minLength: 1,
  maxLength: MAX_IDENTITY_CHARS,
  description: "The recipient's sessionId from session_list.",
});

export const SessionListParameters = Type.Object({});

// The length cap is stated, not declared: Pi would reject a longer message before the tool's own
// refusal could tell the model to shorten it.
export const SessionSendParameters = Type.Object(
  {
    to: SessionId,
    message: Type.String({
      minLength: 1,
      description: `Self-contained message text for the other session's agent, at most ${MAX_MESSAGE_CHARS.toLocaleString("en-US")} characters.`,
    }),
  },
  strictObjectOptions,
);

export const SessionReadParameters = Type.Object({ to: SessionId }, strictObjectOptions);

// Field names models trained on other harnesses send for these tools.
const SESSION_FIELD_ALIASES: ToolFieldAliases = {
  session: "to",
  session_id: "to",
  sessionId: "to",
  target: "to",
  recipient: "to",
  text: "message",
  content: "message",
  body: "message",
  prompt: "message",
};

/** Pi `prepareArguments` hook for one session tool: dropped placeholders and precise errors. */
const sessionArgumentPreparer = <P extends TObject>(name: SessionToolName, parameters: P) =>
  toolArgumentPreparer(name, parameters, (value): value is Static<P> => Check(parameters, value), {
    aliases: SESSION_FIELD_ALIASES,
  });

export const prepareSessionListArguments = sessionArgumentPreparer(
  "session_list",
  SessionListParameters,
);
export const prepareSessionSendArguments = sessionArgumentPreparer(
  "session_send",
  SessionSendParameters,
);
export const prepareSessionReadArguments = sessionArgumentPreparer(
  "session_read",
  SessionReadParameters,
);
