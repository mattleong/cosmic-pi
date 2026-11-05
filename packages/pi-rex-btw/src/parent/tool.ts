import {
  defineTool,
  type AgentToolResult,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";
import * as Effect from "effect/Effect";
import { withCodePreviewShell } from "pi-code-previews";
import { toolArgumentPreparer } from "pi-cosmic-core/tool-arguments";
import { Type } from "typebox";
import type { ParentReference } from "../launch.ts";
import {
  conversationText,
  failureText,
  PARENT_TOOL,
  type ParentReadFailure,
  type ParentToolDetails,
} from "./contract.ts";
import {
  parentCompactSummary,
  parentResultBody,
  renderParentCall,
  renderParentResult,
} from "./presentation.ts";
import { ParentTranscript } from "./reader.ts";
import { DEFAULT_PARENT_MESSAGES, MAX_PARENT_MESSAGES, parentMessageCount } from "./transcript.ts";

export interface ParentToolRunner {
  readonly run: <A, E>(
    effect: Effect.Effect<A, E, ParentTranscript>,
    signal?: AbortSignal,
  ) => Promise<A>;
}

// The cap is stated, not declared: Pi would reject a larger count before the tool could clamp it.
export const ParentToolParameters = Type.Object(
  {
    messages: Type.Optional(
      Type.Number({
        description: `How many of the parent's latest messages to read, oldest first: ${DEFAULT_PARENT_MESSAGES} by default, at most ${MAX_PARENT_MESSAGES}; a larger count reads ${MAX_PARENT_MESSAGES}.`,
      }),
    ),
  },
  { additionalProperties: false },
);

const prepareParentArguments = toolArgumentPreparer(PARENT_TOOL, ParentToolParameters, {
  aliases: { count: "messages", limit: "messages", last: "messages", n: "messages" },
});

const failedResult = (failure: ParentReadFailure): AgentToolResult<ParentToolDetails> => ({
  content: [{ type: "text", text: failureText(failure) }],
  details: failure,
  isError: true,
});

/**
 * Registers the BTW child's read-only view of its parent session. Only a child launched with a
 * parent reference gets it; nothing it does reaches the parent.
 */
export function registerParentConversationTool(
  pi: ExtensionAPI,
  parent: ParentReference,
  runner: ParentToolRunner,
  shell: typeof withCodePreviewShell = withCodePreviewShell,
): void {
  pi.registerTool(
    shell(
      defineTool({
        name: PARENT_TOOL,
        label: "Parent conversation",
        description: `Read the latest messages of the parent Pi session this BTW side session was opened from: what its user asked, what its agent answered, and the tools it ran, oldest first. The parent may be working right now, so read again whenever a question depends on its current state. Reads ${DEFAULT_PARENT_MESSAGES} messages unless messages says otherwise, at most ${MAX_PARENT_MESSAGES}. Read-only.`,
        promptSnippet: "Read the parent session's latest messages",
        promptGuidelines: [
          "Use parent_conversation before answering anything that depends on what the parent session is doing or has done, even if you read it earlier in this conversation: it changes as the parent works. It is read-only, and nothing in this side session reaches the parent.",
        ],
        parameters: ParentToolParameters,
        prepareArguments: prepareParentArguments,
        execute: (_id, args, signal) => {
          const requested = parentMessageCount(args.messages);
          return runner.run(
            ParentTranscript.use((transcript) => transcript.read(parent, requested)).pipe(
              Effect.map(
                (conversation): AgentToolResult<ParentToolDetails> => ({
                  content: [{ type: "text", text: conversationText(conversation) }],
                  details: conversation,
                }),
              ),
              Effect.catchTag("ParentTranscriptError", (error) =>
                Effect.succeed(failedResult({ failure: error.reason, requested })),
              ),
            ),
            signal,
          );
        },
        renderCall: renderParentCall,
        renderResult: renderParentResult,
      }),
      {
        compactSummary: parentCompactSummary,
        expandedContent: {
          // The compact heading already names the request; the body is the conversation.
          renderCall: () => new Container(),
          renderResult: (result, _options, theme) =>
            parentResultBody(result, theme, { expanded: true, compact: true }),
        },
      },
    ),
  );
}
