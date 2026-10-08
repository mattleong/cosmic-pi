// The child-only result tool is Promise-shaped because Pi tool execution is.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { type CompactAnimationScheduler, withCodePreviewShell } from "pi-code-previews";
import type { TSchema } from "typebox";
import {
  LOCAL_PI_RESULT_CONTRACT_FLAG,
  LocalPiResultContractDocument,
  MAX_STRUCTURED_RESULT_WIRE_CHARS,
  type LocalPiContact,
  type LocalPiParentControl,
} from "../backend/local-pi-protocol.ts";
import { canonicalResultJson } from "../domain/result-contract.ts";
import { SUBAGENT_RESULT_TOOL_NAME } from "../run/tool-policy.ts";
import {
  RESULT_ACCEPTED_TEXT,
  RESULT_TOOL_LABEL,
  resultCompactSummary,
  resultExpandedContent,
  resultToolRenderers,
} from "../tools/result-presentation.ts";
import { makeParentCorrelations, parentContactRejection } from "./host-child-correlation.ts";
import { ParentContactError } from "./local-pi-ipc.ts";

/** Reminders a child gets for stopping without a result, before it settles and fails. */
export const MAX_RESULT_REMINDERS = 2;
export const RESULT_REMINDER_MESSAGE_TYPE = "pi-subagents-result-reminder";
const MAX_CONTRACT_FILE_CHARS = 64 * 1024;
const REMINDER = `You stopped without calling ${SUBAGENT_RESULT_TOOL_NAME}. The program that started you receives only that call's arguments. Call it now with your final result; do not redo earlier work.`;

const decodeContractDocument = Schema.decodeUnknownOption(
  Schema.fromJsonString(LocalPiResultContractDocument),
);
const decodeJson = Schema.decodeUnknownOption(Schema.Json);

type StructuredResultAck = Extract<
  LocalPiParentControl,
  { readonly type: "structured_result_ack" }
>;

/** One activation's parent channel, as the child bridge owns it. */
export interface ChildResultTransport {
  readonly isCurrent: () => boolean;
  readonly send: (contact: LocalPiContact) => Effect.Effect<void, ParentContactError>;
  readonly run: (
    effect: Effect.Effect<void, ParentContactError>,
    signal: AbortSignal | undefined,
  ) => Promise<void>;
  readonly scheduleAnimation: CompactAnimationScheduler;
}

export interface ChildResults {
  /**
   * Reads this launch's result contract, or returns undefined synchronously when there is none.
   * Pi applies CLI flags only after extension factories finish, so call it at session start.
   */
  readonly load: () => PromiseLike<LocalPiResultContractDocument> | undefined;
  /** Registers the private result tool for one activation. */
  readonly register: (
    contract: LocalPiResultContractDocument,
    transport: ChildResultTransport,
  ) => void;
  /** Settles the waiting submission the parent answered. */
  readonly acknowledge: (ack: StructuredResultAck) => void;
  /** Fails every waiting submission, for a disconnect or a replaced session. */
  readonly rejectPending: (message: string) => void;
}

/**
 * The private result tool as a child registers it. `submit` resolves once the parent accepted the
 * value's canonical JSON; the presentation gallery renders this exact definition.
 */
export const subagentResultTool = (
  document: LocalPiResultContractDocument,
  submit: (valueJson: string, signal: AbortSignal | undefined) => Promise<void>,
  scheduleAnimation?: CompactAnimationScheduler,
) =>
  withCodePreviewShell(
    {
      ...resultToolRenderers,
      name: SUBAGENT_RESULT_TOOL_NAME,
      label: RESULT_TOOL_LABEL,
      // Final submission must end the child turn; nested codemode calls cannot carry terminate.
      exposure: "model-only" as const,
      description:
        "Return your final result to the program that started you. The arguments are your return value. Call once, after all work is done.",
      promptGuidelines: [
        `Call ${SUBAGENT_RESULT_TOOL_NAME} exactly once as your last action; its arguments are your return value.`,
      ],
      // SAFETY: Pi validates arguments against raw JSON Schema; the root compiled and bounded it.
      parameters: document.parameters as TSchema,
      ...(document.strictSafe && {
        constrainedSampling: { type: "json_schema" as const, strict: "prefer" as const },
      }),
      executionMode: "sequential",
      execute(_toolCallId, params, signal) {
        const value = decodeJson(params);
        if (Option.isNone(value))
          return Promise.reject(new Error("The result must be a JSON value."));
        const valueJson = canonicalResultJson(value.value);
        if (valueJson.length > MAX_STRUCTURED_RESULT_WIRE_CHARS)
          return Promise.reject(
            new Error(`Results are limited to ${MAX_STRUCTURED_RESULT_WIRE_CHARS} characters.`),
          );
        return submit(valueJson, signal).then(() => ({
          content: [{ type: "text" as const, text: RESULT_ACCEPTED_TEXT }],
          details: {},
          terminate: true,
        }));
      },
    },
    {
      compactSummary: resultCompactSummary,
      expandedContent: resultExpandedContent,
      ...(scheduleAnimation && { scheduleAnimation }),
    },
  );

/**
 * Owns one child process's result state. Each parent prompt is a new assignment, and resuming a
 * paused run prompts the same process again, so acceptance and the reminder budget reset per
 * prompt. They do not reset on `agent_start`, which also fires for each reminder continuation.
 */
export function registerChildResults(
  pi: ExtensionAPI,
  readContractFile: (path: string) => PromiseLike<string>,
): ChildResults {
  pi.registerFlag(LOCAL_PI_RESULT_CONTRACT_FLAG, {
    description: "Private result contract file for this subagent",
    type: "string",
  });
  const pending = makeParentCorrelations<void>();
  let contract: LocalPiResultContractDocument | undefined;
  let accepted = false;
  let reminders = 0;
  let nextRequest = 1;

  pi.on("before_agent_start", () => {
    accepted = false;
    reminders = 0;
  });
  pi.on("agent_before_settle", (event) => {
    if (!contract || accepted || event.outcome !== "completed") return;
    if (reminders >= MAX_RESULT_REMINDERS) return;
    reminders += 1;
    return {
      entries: [
        {
          type: "custom_message",
          customType: RESULT_REMINDER_MESSAGE_TYPE,
          content: REMINDER,
          display: true,
        },
      ],
      continue: true,
    };
  });

  const load = (): PromiseLike<LocalPiResultContractDocument> | undefined => {
    const path = pi.getFlag(LOCAL_PI_RESULT_CONTRACT_FLAG);
    if (!Predicate.isString(path) || path.length === 0) return undefined;
    return readContractFile(path).then((source) => {
      const decoded =
        source.length <= MAX_CONTRACT_FILE_CHARS ? decodeContractDocument(source) : Option.none();
      if (Option.isNone(decoded)) throw new Error("The subagent result contract is unreadable.");
      contract = decoded.value;
      return decoded.value;
    });
  };

  const submit = (transport: ChildResultTransport, valueJson: string, signal?: AbortSignal) => {
    if (!transport.isCurrent())
      return Promise.reject(new Error("Result delivery is unavailable for this session."));
    const requestId = `result-${process.pid}-${nextRequest++}`;
    const delivery = pending.await(
      requestId,
      transport.send({ channel: "pi-subagents", type: "structured_result", requestId, valueJson }),
    );
    return transport.run(delivery, signal).catch((error) => {
      throw parentContactRejection(error);
    });
  };

  const register: ChildResults["register"] = (document, transport) =>
    pi.registerTool(
      subagentResultTool(
        document,
        (valueJson, signal) =>
          submit(transport, valueJson, signal).then(() => {
            accepted = true;
          }),
        transport.scheduleAnimation,
      ),
    );

  const acknowledge = (ack: StructuredResultAck): void =>
    void pending.settle(
      ack.requestId,
      ack.ok
        ? Effect.void
        : Effect.fail(
            new ParentContactError({ message: ack.message ?? "The result was rejected." }),
          ),
    );

  return { load, register, acknowledge, rejectPending: pending.rejectAll };
}
