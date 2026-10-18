import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  getCurrentSystemPrompt,
  getCurrentTools,
  type AssistantMessage,
  type Message,
} from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { nodeFsPromises as fs, nodePath as path } from "../support/node-builtins.ts";

const SCRIPTED_PROVIDER = "pi-subagents-scripted";
export const SCRIPTED_MODEL = `${SCRIPTED_PROVIDER}/child`;
export const SCRIPTED_OBSERVATIONS_FILE = "scripted-observations.jsonl";
export const SCRIPT = {
  progressTask: "SCRIPT_PROGRESS_THEN_REPORT",
  progressMessage: "Scripted child progress",
  report: "Scripted child report",
  resumeTask: "SCRIPT_RESUME",
  resumedWithHistory: "Scripted child resumed with its earlier session",
  resumedWithoutHistory: "Scripted child resumed without its earlier session",
  holdTask: "SCRIPT_HOLD_UNTIL_ABORTED",
} as const;

export const ScriptedObservation = Schema.Struct({
  prompt: Schema.String,
  systemPrompt: Schema.String,
  tools: Schema.Array(Schema.String),
});
const encodeObservation = Schema.encodeEffect(Schema.fromJsonString(ScriptedObservation));

const messageText = (message: Message): string => {
  if (message.role === "assistant") return "";
  if (Predicate.isString(message.content)) return message.content;
  return message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
};

const reply = (messages: ReadonlyArray<Message>): Effect.Effect<AssistantMessage> => {
  const last = messages.at(-1);
  if (last?.role === "toolResult") return Effect.succeed(fauxAssistantMessage(SCRIPT.report));
  const prompt = last ? messageText(last) : "";
  if (prompt.includes(SCRIPT.holdTask)) return Effect.never;
  if (prompt.includes(SCRIPT.resumeTask))
    return Effect.succeed(
      fauxAssistantMessage(
        messages.some((message) => messageText(message).includes(SCRIPT.progressTask))
          ? SCRIPT.resumedWithHistory
          : SCRIPT.resumedWithoutHistory,
      ),
    );
  if (prompt.includes(SCRIPT.progressTask))
    return Effect.succeed(
      fauxAssistantMessage(
        fauxToolCall("agent_contact_parent", { kind: "progress", message: SCRIPT.progressMessage }),
        { stopReason: "toolUse" },
      ),
    );
  return Effect.succeed(fauxAssistantMessage("Unscripted prompt."));
};

const observe = (file: string, messages: ReadonlyArray<Message>) =>
  encodeObservation({
    prompt: messageText(messages.at(-1) ?? { role: "user", content: "", timestamp: 0 }),
    systemPrompt: getCurrentSystemPrompt([...messages]),
    tools: getCurrentTools([...messages]).map((tool) => tool.name),
  }).pipe(
    Effect.flatMap((line) => Effect.promise(() => fs.appendFile(file, `${line}\n`))),
    Effect.orDie,
  );

/**
 * Credential-free model for real Pi child processes. Each reply is chosen from the transcript, and
 * each request's prompt, system prompt, and active tools are appended to the agent directory.
 */
export default function scriptedPiProvider(pi: ExtensionAPI): void {
  const observations = path.join(getAgentDir(), SCRIPTED_OBSERVATIONS_FILE);
  const faux = fauxProvider({
    provider: SCRIPTED_PROVIDER,
    models: [{ id: "child", reasoning: true }],
  });
  const step = (
    context: { readonly messages: ReadonlyArray<Message> },
    options?: { readonly signal?: AbortSignal },
  ) =>
    Effect.runPromiseExit(
      observe(observations, context.messages).pipe(Effect.andThen(reply(context.messages))),
      options?.signal ? { signal: options.signal } : undefined,
    ).then((exit) =>
      Exit.isSuccess(exit) ? exit.value : fauxAssistantMessage("", { stopReason: "aborted" }),
    );
  faux.setResponses(Array.from({ length: 64 }, () => step));
  pi.registerProvider(faux.provider);
}
