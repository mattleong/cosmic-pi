import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { ChildAgentEvent } from "../run/child-agent.ts";
import type { SubagentUsage } from "../run/model.ts";
import { MAX_PROTOCOL_ID_CHARS } from "../run/limits.ts";

const MAX_NAME_CHARS = 256;
const MAX_TEXT_CHARS = 1024 * 1024;
const ProtocolIdSchema = Schema.String.check(Schema.isMaxLength(MAX_PROTOCOL_ID_CHARS));
const NameSchema = Schema.String.check(Schema.isMaxLength(MAX_NAME_CHARS));
const TextSchema = Schema.String.check(Schema.isMaxLength(MAX_TEXT_CHARS));
const MessageContentSchema = Schema.Union([TextSchema, Schema.Array(Schema.Unknown)]);

const DiscriminantSchema = Schema.Struct({ type: Schema.optional(Schema.String) });
const SystemSchema = Schema.Struct({
  type: Schema.Literal("system"),
  subtype: Schema.optional(Schema.String),
  session_id: Schema.optional(ProtocolIdSchema),
  model: Schema.optional(NameSchema),
});
const InitSchema = Schema.Struct({
  type: Schema.Literal("system"),
  subtype: Schema.Literal("init"),
  session_id: ProtocolIdSchema,
  model: Schema.optional(NameSchema),
});
const AssistantSchema = Schema.Struct({
  type: Schema.Literal("assistant"),
  message: Schema.Struct({ content: MessageContentSchema }),
});
const UserSchema = Schema.Struct({
  type: Schema.Literal("user"),
  message: Schema.Struct({ content: MessageContentSchema }),
});
const ResultUsageSchema = Schema.Struct({
  input_tokens: Schema.optional(Schema.Number),
  output_tokens: Schema.optional(Schema.Number),
  cache_read_input_tokens: Schema.optional(Schema.Number),
  cache_creation_input_tokens: Schema.optional(Schema.Number),
});
const ResultSchema = Schema.Struct({
  type: Schema.Literal("result"),
  subtype: Schema.optional(Schema.String),
  is_error: Schema.optional(Schema.Boolean),
  result: Schema.optional(TextSchema),
  session_id: Schema.optional(ProtocolIdSchema),
  total_cost_usd: Schema.optional(Schema.Number),
  usage: Schema.optional(ResultUsageSchema),
  errors: Schema.optional(Schema.Array(TextSchema)),
});
const IgnoredSchema = Schema.Struct({ type: Schema.String });

const TextBlockSchema = Schema.Struct({ type: Schema.Literal("text"), text: TextSchema });
const ToolUseBlockSchema = Schema.Struct({
  type: Schema.Literal("tool_use"),
  id: ProtocolIdSchema,
  name: NameSchema,
  input: Schema.Unknown,
});
const ToolResultBlockSchema = Schema.Struct({
  type: Schema.Literal("tool_result"),
  tool_use_id: ProtocolIdSchema,
  is_error: Schema.optional(Schema.Boolean),
});
const ContentDiscriminantSchema = Schema.Struct({ type: Schema.optional(Schema.String) });

const validateKnownBlocks = (
  blocks: ReadonlyArray<unknown>,
  role: "assistant" | "user",
): Effect.Effect<void, Schema.SchemaError> =>
  Effect.forEach(
    blocks,
    (block) => {
      if (block === null || typeof block !== "object") return Effect.void;
      return Schema.decodeUnknownEffect(ContentDiscriminantSchema)(block).pipe(
        Effect.flatMap((discriminant) => {
          if (role === "assistant" && discriminant.type === "text")
            return Schema.decodeUnknownEffect(TextBlockSchema)(block).pipe(Effect.asVoid);
          if (role === "assistant" && discriminant.type === "tool_use")
            return Schema.decodeUnknownEffect(ToolUseBlockSchema)(block).pipe(Effect.asVoid);
          if (role === "user" && discriminant.type === "tool_result")
            return Schema.decodeUnknownEffect(ToolResultBlockSchema)(block).pipe(Effect.asVoid);
          return Effect.void;
        }),
      );
    },
    { discard: true },
  );

export type ClaudeInit = Schema.Schema.Type<typeof InitSchema>;

export const decodeClaudeInitOption = (value: unknown): ClaudeInit | undefined => {
  const decoded = Schema.decodeUnknownOption(InitSchema)(value);
  return decoded._tag === "Some" ? decoded.value : undefined;
};

export type ClaudeStreamEnvelope =
  | Schema.Schema.Type<typeof SystemSchema>
  | Schema.Schema.Type<typeof AssistantSchema>
  | Schema.Schema.Type<typeof UserSchema>
  | Schema.Schema.Type<typeof ResultSchema>
  | { readonly type: "ignored"; readonly eventType: string };

export const decodeClaudeStreamEnvelope = (
  value: unknown,
): Effect.Effect<ClaudeStreamEnvelope, Schema.SchemaError> =>
  Effect.gen(function* () {
    const discriminant = yield* Schema.decodeUnknownEffect(DiscriminantSchema)(value);
    switch (discriminant.type) {
      case "system":
        return yield* Schema.decodeUnknownEffect(SystemSchema)(value);
      case "assistant": {
        const envelope = yield* Schema.decodeUnknownEffect(AssistantSchema)(value);
        if (Array.isArray(envelope.message.content))
          yield* validateKnownBlocks(envelope.message.content, "assistant");
        return envelope;
      }
      case "user": {
        const envelope = yield* Schema.decodeUnknownEffect(UserSchema)(value);
        if (Array.isArray(envelope.message.content))
          yield* validateKnownBlocks(envelope.message.content, "user");
        return envelope;
      }
      case "result":
        return yield* Schema.decodeUnknownEffect(ResultSchema)(value);
      default: {
        const ignored = yield* Schema.decodeUnknownEffect(IgnoredSchema)(value);
        return { type: "ignored" as const, eventType: ignored.type };
      }
    }
  });

export interface ClaudeProtocolState {
  readonly tools: ReadonlyMap<string, string>;
}

const resultUsage = (envelope: Schema.Schema.Type<typeof ResultSchema>): SubagentUsage => {
  const input = envelope.usage?.input_tokens ?? 0;
  const output = envelope.usage?.output_tokens ?? 0;
  const cacheRead = envelope.usage?.cache_read_input_tokens ?? 0;
  const cacheWrite = envelope.usage?.cache_creation_input_tokens ?? 0;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    cost: envelope.total_cost_usd ?? 0,
  };
};

export const claudeEnvelopeToAgentEvents = (
  envelope: ClaudeStreamEnvelope,
  state: ClaudeProtocolState,
): ReadonlyArray<ChildAgentEvent> => {
  if (envelope.type === "assistant") {
    if (typeof envelope.message.content === "string")
      return envelope.message.content.trim()
        ? [{ type: "assistant", text: envelope.message.content }]
        : [];
    const events: ChildAgentEvent[] = [];
    for (const block of envelope.message.content) {
      const tool = Schema.decodeUnknownOption(ToolUseBlockSchema)(block);
      if (tool._tag === "Some") {
        const value = tool.value;
        events.push({
          type: "tool_started",
          toolCallId: value.id,
          toolName: value.name,
          args: value.input,
        });
        continue;
      }
      const text = Schema.decodeUnknownOption(TextBlockSchema)(block);
      if (text._tag === "Some" && text.value.text.trim())
        events.push({ type: "assistant", text: text.value.text });
    }
    return events;
  }
  if (envelope.type === "user") {
    if (typeof envelope.message.content === "string") return [];
    const events: ChildAgentEvent[] = [];
    for (const block of envelope.message.content) {
      const result = Schema.decodeUnknownOption(ToolResultBlockSchema)(block);
      if (result._tag === "None") continue;
      const value = result.value;
      const toolName = state.tools.get(value.tool_use_id) ?? "tool";
      events.push({
        type: "tool_finished",
        toolCallId: value.tool_use_id,
        toolName,
        isError: value.is_error ?? false,
      });
    }
    return events;
  }
  if (envelope.type === "result") {
    if (envelope.is_error || (envelope.subtype !== undefined && envelope.subtype !== "success")) {
      const message =
        envelope.errors?.filter((value) => value.trim()).join("\n") ||
        envelope.result ||
        `Claude Code ended with ${envelope.subtype ?? "an error"}.`;
      return [{ type: "failed", message, usage: resultUsage(envelope) }];
    }
    return [
      {
        type: "settled",
        ...(envelope.result?.trim() ? { finalText: envelope.result } : {}),
        usage: resultUsage(envelope),
      },
    ];
  }
  return [];
};
