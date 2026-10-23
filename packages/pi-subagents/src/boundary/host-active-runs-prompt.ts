import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Arr from "effect/Array";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { clipText } from "pi-cosmic-core/display";
import { invokeHostCallback } from "pi-cosmic-core/host-session";
import { sanitizeTerminalLine } from "pi-cosmic-core/security";
import type { SubagentProjection, SubagentRunView } from "../run/model.ts";
import { isActiveRunState, SUBAGENT_ROOT_RUN_ID } from "../run/model.ts";
import { SUBAGENT_TOOL_NAME } from "../run/tool-policy.ts";

export const ACTIVE_RUNS_PROMPT_SECTION = "active_subagents";
const MAX_LISTED_RUNS = 20;

// pi-ai 1.2 honors compat.supportsMidConvoSystemMessages only in these APIs. Google, Vertex, and
// Bedrock always merge system messages into the leading prompt, as do unknown custom APIs here.
const MID_CONVERSATION_SYSTEM_APIS: ReadonlySet<string> = new Set([
  "anthropic-messages",
  "openai-responses",
  "azure-openai-responses",
  "openai-codex-responses",
  "openai-completions",
  "mistral-conversations",
]);

const decodeSystemMessageCompat = Schema.decodeUnknownOption(
  Schema.Struct({
    api: Schema.String,
    compat: Schema.optional(
      Schema.Struct({ supportsMidConvoSystemMessages: Schema.optional(Schema.Boolean) }),
    ),
  }),
);

/**
 * Whether the model receives a changed prompt section as a mid-conversation system message.
 * Otherwise pi-ai merges every system message back into the leading prompt, so each change
 * rewrites the prompt and invalidates the provider's cached prefix.
 */
const keepsMidConversationSystemMessages = (model: ExtensionContext["model"]): boolean =>
  Option.match(decodeSystemMessageCompat(model), {
    onNone: () => false,
    onSome: ({ api, compat }) =>
      compat?.supportsMidConvoSystemMessages === true && MID_CONVERSATION_SYSTEM_APIS.has(api),
  });

const stateLabel = (run: SubagentRunView): string =>
  Match.value(run.state).pipe(
    Match.when("waiting_for_parent", () => "waiting for your reply"),
    Match.when("paused", () => "paused"),
    Match.orElse(() => "running"),
  );

const runIdentity = (run: SubagentRunView): string =>
  `- ${run.id} · ${run.profile ?? "subagent"} · ${clipText(sanitizeTerminalLine(run.name), 60)}`;

const runsSection = (
  projection: SubagentProjection,
  heading: string,
  line: (run: SubagentRunView) => string,
): string | undefined => {
  const active = Arr.filter(
    projection.runs,
    (run) =>
      (run.parentRunId ?? SUBAGENT_ROOT_RUN_ID) === SUBAGENT_ROOT_RUN_ID &&
      isActiveRunState(run.state),
  );
  if (active.length === 0) return undefined;
  const listed = Arr.map(active.slice(0, MAX_LISTED_RUNS), line);
  const more = active.length - listed.length;
  return Arr.join(
    [heading, ...listed, ...(more > 0 ? [`- and ${more} more; see agent_list`] : [])],
    "\n",
  );
};

/**
 * Lists the direct children still active, so the parent remembers them after compaction instead of
 * launching duplicates. Only identity and coarse state appear: the section must stay byte-identical
 * while nothing changes, or every turn would patch the system prompt.
 */
const activeRunsSection = (projection: SubagentProjection): string | undefined =>
  runsSection(
    projection,
    "Subagents you started that are still active. Their reports arrive on their own; check agent_list before starting work that may duplicate theirs.",
    (run) => `${runIdentity(run)} · ${stateLabel(run)}`,
  );

/**
 * The same list for models whose prompt must stay byte-identical between compactions: identity
 * only, as captured after the latest compaction, with no state that would go stale.
 */
const compactionRunsSection = (projection: SubagentProjection): string | undefined =>
  runsSection(
    projection,
    "Subagents you started that were still active after the last context compaction. This list is not updated as they finish; their reports and questions arrive on their own, and agent_list shows current state. Check it before starting work that may duplicate theirs.",
    runIdentity,
  );

interface CompactionSnapshot {
  readonly key: string;
  readonly section: string | undefined;
}

export const registerActiveRunsPrompt = (
  pi: ExtensionAPI,
  projection: () => SubagentProjection | undefined,
): void => {
  let snapshot: CompactionSnapshot | undefined;
  // Captured once per compaction on the current branch, so the leading prompt changes only when
  // compaction has already replaced the cached conversation. Before any compaction the launch
  // receipts in the conversation carry the same information.
  const compactionSection = (
    ctx: ExtensionContext,
    current: SubagentProjection,
  ): string | undefined => {
    const key = invokeHostCallback(() => {
      const compaction = Option.getOrUndefined(
        Arr.findLast(ctx.sessionManager.getBranch(), (entry) => entry.type === "compaction"),
      );
      return compaction && `${ctx.sessionManager.getSessionId()}:${compaction.id}`;
    }, undefined);
    if (key === undefined) return undefined;
    if (snapshot?.key !== key) snapshot = { key, section: compactionRunsSection(current) };
    return snapshot.section;
  };
  pi.on("before_agent_start", (event, ctx) => {
    const options = event.systemPromptOptions;
    const current = projection();
    const section =
      current && options.selectedTools.includes(SUBAGENT_TOOL_NAME.start)
        ? keepsMidConversationSystemMessages(ctx.model)
          ? activeRunsSection(current)
          : compactionSection(ctx, current)
        : undefined;
    if (section) options.sections[ACTIVE_RUNS_PROMPT_SECTION] = section;
    else delete options.sections[ACTIVE_RUNS_PROMPT_SECTION];
    return undefined;
  });
};
