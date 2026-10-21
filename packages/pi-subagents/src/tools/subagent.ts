import {
  defineTool,
  type ExtensionAPI,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { expandedSection, withCodePreviewShell } from "pi-code-previews";
import { Container } from "@earendil-works/pi-tui";
import { createSubagentCompactSummary } from "./compact-summary.ts";
import { isTypedReceipt, requestedRunIds, type SummaryArguments } from "./compact-heading.ts";
import { startHostUiTicker } from "pi-cosmic-ui/boundary/host-status";
import type { SubagentToolPresentation } from "../boundary/host-activity-widget.ts";
import type { SubagentErrorReceiptOwner } from "../boundary/host-tool-result.ts";
import {
  NESTED_SUBAGENT_TOOL_NAMES,
  SUBAGENT_TOOL_NAME,
  SUBAGENT_TOOL_NAMES,
  type SubagentToolName,
} from "../run/tool-policy.ts";
import { decodeStartAwaitCardDetails } from "./details-decode.ts";
import { executeSubagentAction, type SubagentToolRuntime } from "./execute.ts";
import { hasReturnedFailureEvidence } from "./outcome.ts";
import { syncAwaitProgressTicker, type SubagentToolRenderContext } from "./render-await.ts";
import {
  renderSubagentCall,
  renderSubagentResult,
  renderSubagentExpandedContent,
  decodeCallArguments,
  renderSubagentInputContent,
} from "./render.ts";
import { renderSubagentStartCall } from "./render-start.ts";
import { registerAgentTools, ROOT_SCRIPT_NAMESPACE } from "./agent.ts";
import { executeAgentActionEffect } from "./execute-agents.ts";
import {
  startToolParameters,
  subagentArgumentPreparer,
  subagentToolAction,
  SUBAGENT_TOOL_SCHEMAS,
  type SubagentToolInput,
  type SubagentToolParameters,
} from "./schema.ts";
import { countLabel, invokeHostCallback, toPiToolOutputSchema } from "pi-cosmic-core";
import { CONTRACT_SCHEMAS, isSubagentContractTool } from "./contract-schema.ts";
import {
  CUSTOM_AGENT_START_GUIDELINE,
  NESTED_START_GUIDELINE,
  NORMAL_START_GUIDELINE,
} from "../delegation/prompt.ts";

const targetsLabel = (args: SummaryArguments) =>
  countLabel(requestedRunIds(args)?.length ?? 0, "subagent");

type SubagentToolSpec<N extends SubagentToolName> = Pick<
  ToolDefinition<SubagentToolParameters<N>>,
  "label" | "description" | "promptSnippet" | "promptGuidelines" | "renderCall"
> & {
  readonly lease?: (
    presentation: SubagentToolPresentation,
    args: Parameters<ToolDefinition<SubagentToolParameters<N>>["execute"]>[1],
  ) => () => void;
};

type SubagentToolSpecs = { readonly [N in SubagentToolName]: SubagentToolSpec<N> };

type SubagentToolInputs = {
  readonly [N in SubagentToolName]: (
    args: Parameters<ToolDefinition<SubagentToolParameters<N>>["execute"]>[1],
  ) => SubagentToolInput;
};

const TOOL_INPUTS: SubagentToolInputs = {
  [SUBAGENT_TOOL_NAME.models]: (args) => ({ tool: SUBAGENT_TOOL_NAME.models, args }),
  [SUBAGENT_TOOL_NAME.start]: (args) => ({ tool: SUBAGENT_TOOL_NAME.start, args }),
  [SUBAGENT_TOOL_NAME.await]: (args) => ({ tool: SUBAGENT_TOOL_NAME.await, args }),
  [SUBAGENT_TOOL_NAME.lifecycle]: (args) => ({ tool: SUBAGENT_TOOL_NAME.lifecycle, args }),
  [SUBAGENT_TOOL_NAME.workspace]: (args) => ({ tool: SUBAGENT_TOOL_NAME.workspace, args }),
};

type SubagentToolParameterSet = {
  readonly [N in SubagentToolName]: SubagentToolParameters<N>;
};

type SubagentArgumentPreparers = {
  readonly [N in SubagentToolName]: NonNullable<
    ToolDefinition<SubagentToolParameters<N>>["prepareArguments"]
  >;
};

const ARGUMENT_PREPARERS: SubagentArgumentPreparers = {
  [SUBAGENT_TOOL_NAME.models]: subagentArgumentPreparer(SUBAGENT_TOOL_NAME.models),
  [SUBAGENT_TOOL_NAME.start]: subagentArgumentPreparer(SUBAGENT_TOOL_NAME.start),
  [SUBAGENT_TOOL_NAME.await]: subagentArgumentPreparer(SUBAGENT_TOOL_NAME.await),
  [SUBAGENT_TOOL_NAME.lifecycle]: subagentArgumentPreparer(SUBAGENT_TOOL_NAME.lifecycle),
  [SUBAGENT_TOOL_NAME.workspace]: subagentArgumentPreparer(SUBAGENT_TOOL_NAME.workspace),
};

const SCRIPTED_SUBAGENT_GUIDELINE =
  "Native codemode can script read-only delegation with agent_start, agent_await, agent_list, agent_read, agent_profiles, and agent_lifecycle stop, which return structured results. Print run IDs as soon as you have them, await every call, and keep steps bounded. Don't rerun a failed script or loop on parent attention. Leave questions, retries, writers, and integration to the main agent.";

const DELIVERABLE_GUIDELINE =
  "Give each subagent one bounded slice with a concrete deliverable, and choose its profile by that deliverable. Read-only work is not automatically scouting.";
const FAILED_START_GUIDELINE =
  "If a start fails, follow its Next step or tell the user; don't run claude, codex, or pi from the shell instead.";
const FAILED_RUN_GUIDELINE =
  "If a profiled run fails and names its next candidate, start a new run with that model before a generalist replacement; don't replace a profile the user disabled or relaunch work whose outcome is uncertain.";
const SHARED_CHECKOUT_SCOPES =
  "Shared-checkout writers in one cwd share it without file claims: give each a disjoint task scope and name the files or areas it owns.";

// The audience-specific delegation rule from delegation/prompt.ts is prepended at registration.
const START_GUIDELINES = [
  DELIVERABLE_GUIDELINE,
  `Use profile=worker for implementation you hand off. While shared-checkout writers run, coordinate and review instead of editing; worktree writers leave your cwd free. Omit isolation so each writer uses the session's workspace setting; set it only when the user asks for a shared checkout or a worktree. ${SHARED_CHECKOUT_SCOPES}`,
  FAILED_START_GUIDELINE,
  FAILED_RUN_GUIDELINE,
];

// Only the root starts worktree writers or applies their proposals.
const NESTED_START_GUIDELINES = [
  DELIVERABLE_GUIDELINE,
  `Use profile=worker for implementation you hand off. Writers you start share your working directory; while they run, coordinate and review instead of editing. ${SHARED_CHECKOUT_SCOPES}`,
  FAILED_START_GUIDELINE,
];

const TOOL_SPECS: SubagentToolSpecs = {
  [SUBAGENT_TOOL_NAME.models]: {
    label: "Inspect Profile Routes",
    description:
      "Show each profile's configured route: its model candidates in fallback order, with runtime, effort, context, write intent, and fast mode, plus the user's custom agents and the candidates their overrides leave eligible. Launches use these routes by default; a start item's model overrides one launch, only when the user asks for a specific model or a failed run names its next candidate. Authentication is checked only at launch.",
    promptSnippet: "Show subagent profile routes and custom agents",
    renderCall: (args, theme) =>
      renderSubagentCall("Inspect profile routes", args.profile ?? "all profiles", theme),
  },
  [SUBAGENT_TOOL_NAME.start]: {
    label: "Start Subagents",
    description:
      "Start background subagents, up to your direct-child limit. Returns run IDs immediately; each report is delivered to you as a saved file when its run finishes, and runs end after reporting. Give every agent a self-contained task with the relevant paths, constraints, and deliverable. The profile sets the role and model route (default generalist). Only the main session can start worktree writers. Subagents started from a codemode script, and their descendants, stay read-only.",
    promptSnippet: "Run bounded, independent tasks in background subagents",
    renderCall: (args, theme, context) =>
      renderSubagentStartCall(
        Array.isArray(args.agents) ? args.agents : [],
        theme,
        context.expanded,
        false,
        context,
      ),
    lease: (presentation, args) => presentation.beginStart(args.agents.length),
  },
  [SUBAGENT_TOOL_NAME.await]: {
    label: "Wait for Subagents",
    description:
      "Wait for subagents you started, or their descendants, and return their report files, and reports short enough to fit inline, with live progress. Returns early when a selected run pauses, when any subagent asks you a question, or when the user sends a message; children keep running. Follow the steps in the result, then await again.",
    promptSnippet: "Wait for subagent reports when your next step depends on them",
    promptGuidelines: [
      "After starting subagents, keep working on parts you didn't delegate; don't redo a subagent's slice while it runs. Call agent_await only when your next step depends on a report; reports arrive on their own, so don't poll agent_list or agent_read.",
      "When a subagent tool result lists next steps, follow them in order before continuing. When a subagent asks you a question, answer it with agent_send.",
      "A finished subagent's report arrives as the path of a saved file, followed by the whole report when it fits. When the report itself isn't there, read that file with your read tool before relying on it.",
    ],
    renderCall: (args, theme, context) =>
      renderSubagentCall(
        context.isPartial
          ? args.until === "all_finished"
            ? "Waiting for subagents"
            : "Waiting for first subagent"
          : args.until === "all_finished"
            ? "Waited for subagents"
            : "Waited for first subagent",
        "",
        theme,
      ),
    lease: (presentation, args) => presentation.beginAwait(requestedRunIds(args) ?? [], args.until),
  },
  [SUBAGENT_TOOL_NAME.lifecycle]: {
    label: "Manage Subagents",
    description:
      "Interrupt or stop subagents you started, or their descendants. Each target's result is reported separately.",
    promptSnippet: "Interrupt or stop subagents",
    renderCall: (args, theme) => {
      const verb = args.action ?? "manage";
      const action = `${verb[0]?.toUpperCase() ?? ""}${verb.slice(1)}`;
      return renderSubagentCall(`${action} ${targetsLabel(args)}`, "", theme);
    },
  },
  [SUBAGENT_TOOL_NAME.workspace]: {
    label: "Manage Writer Worktrees",
    description:
      "Apply worktree writers' proposals as their direct parent. apply integrates the current proposal as uncommitted edits, keeps your index, and refuses if anything is stale or conflicts. To check first, review pages a summary and the diff, prepare builds a cwd combining it with your current edits for testing, and apply then integrates that preparation. revise asks the writer for another pass, rebase first rebuilding its tree from your current files; discard deletes a proposal. list marks worktrees left by ended sessions; review, prepare, apply, or revise takes over an adoptable one, and discard works on any orphan.",
    promptSnippet: "Apply, or review, test, and apply, worktree writers' proposals",
    promptGuidelines: [
      "Nothing applies a worktree writer's proposal automatically, and neither path needs user confirmation: apply small or trusted changes directly; for risky ones, review every page, prepare, run the relevant tests in the prepared cwd without editing it, then apply. Don't stage or commit parent changes.",
      "If review or tests fail, revise with concrete feedback and await the successor. If your files moved on under the proposal, revise with rebase.",
    ],
    renderCall: (args, theme) => renderSubagentCall("Writer worktree", args.action ?? "", theme),
  },
};

const settlePresentation = <A>(release: () => void, operation: () => Promise<A>): Promise<A> => {
  const releaseSafely = () => invokeHostCallback(release, undefined);
  let pending: Promise<A>;
  try {
    pending = operation();
  } catch (error) {
    releaseSafely();
    throw error;
  }
  return pending.finally(releaseSafely);
};

export function registerSubagentTools(
  pi: ExtensionAPI,
  runtime: SubagentToolRuntime,
  receiptOwner?: SubagentErrorReceiptOwner,
  shell: typeof withCodePreviewShell = withCodePreviewShell,
): void {
  const startUiTicker = runtime.startUiTicker ?? startHostUiTicker;
  const panelOwnsHierarchy = (
    result: Parameters<typeof renderSubagentResult>[0],
    isPartial: boolean,
    context: SubagentToolRenderContext | undefined,
  ): boolean => {
    const details = decodeStartAwaitCardDetails(result.details);
    const owned =
      isPartial &&
      details !== undefined &&
      runtime.toolPresentation?.isLiveHierarchyAvailable() === true;
    syncAwaitProgressTicker(details, isPartial && !owned, context, startUiTicker);
    return owned;
  };

  const nested = runtime.proxyCall !== undefined;
  const agents = nested ? undefined : (runtime.agents ?? []);
  const startParameters = startToolParameters(agents);
  const toolParameters: SubagentToolParameterSet = {
    [SUBAGENT_TOOL_NAME.models]: SUBAGENT_TOOL_SCHEMAS[SUBAGENT_TOOL_NAME.models].parameters,
    [SUBAGENT_TOOL_NAME.start]: startParameters,
    [SUBAGENT_TOOL_NAME.await]: SUBAGENT_TOOL_SCHEMAS[SUBAGENT_TOOL_NAME.await].parameters,
    [SUBAGENT_TOOL_NAME.lifecycle]: SUBAGENT_TOOL_SCHEMAS[SUBAGENT_TOOL_NAME.lifecycle].parameters,
    [SUBAGENT_TOOL_NAME.workspace]: SUBAGENT_TOOL_SCHEMAS[SUBAGENT_TOOL_NAME.workspace].parameters,
  };
  const argumentPreparers: SubagentArgumentPreparers = {
    ...ARGUMENT_PREPARERS,
    [SUBAGENT_TOOL_NAME.start]: subagentArgumentPreparer(SUBAGENT_TOOL_NAME.start, startParameters),
  };
  const buildTool = <N extends SubagentToolName>(name: N) => {
    const { lease, ...spec }: SubagentToolSpec<N> = TOOL_SPECS[name];
    // Root contract tools are the script-callable ones.
    const scriptable = !nested && isSubagentContractTool(name);
    const tool = defineTool<SubagentToolParameters<N>>({
      ...spec,
      ...(name === SUBAGENT_TOOL_NAME.start && {
        promptGuidelines: [
          nested ? NESTED_START_GUIDELINE : NORMAL_START_GUIDELINE,
          ...(nested ? NESTED_START_GUIDELINES : START_GUIDELINES),
          ...(agents && agents.length > 0 ? [CUSTOM_AGENT_START_GUIDELINE] : []),
          ...(scriptable ? [SCRIPTED_SUBAGENT_GUIDELINE] : []),
        ],
      }),
      name,
      // The root declares agent_profiles only once tool search loads it, and agent_worktree once a
      // worktree exists (application/register.ts); scripts still reach agent_profiles.
      exposure:
        !nested && name === SUBAGENT_TOOL_NAME.models
          ? "deferred"
          : scriptable
            ? "direct"
            : "model-only",
      ...(!nested && name === SUBAGENT_TOOL_NAME.workspace && { defaultActive: false }),
      ...(scriptable && {
        outputSchema: toPiToolOutputSchema(CONTRACT_SCHEMAS[name]),
        namespace: ROOT_SCRIPT_NAMESPACE,
      }),
      parameters: toolParameters[name],
      prepareArguments: argumentPreparers[name],
      execute: (id, args, ...rest) => {
        const input = TOOL_INPUTS[name](args);
        return settlePresentation(
          (runtime.toolPresentation && lease?.(runtime.toolPresentation, args)) ??
            (() => undefined),
          () =>
            executeSubagentAction(
              pi,
              runtime,
              input,
              ...rest,
              receiptOwner?.receipts.isNested(receiptOwner.owner, id) ?? false,
            ),
        ).then((result) => {
          receiptOwner?.receipts.retain(
            receiptOwner.owner,
            name,
            id,
            subagentToolAction(input),
            result,
          );
          return result;
        });
      },
      renderResult: (result, options, theme, context) =>
        renderSubagentResult(result, options.isPartial, options.expanded, theme, {
          panelOwnsLiveHierarchy: panelOwnsHierarchy(result, options.isPartial, context),
          isError: context.isError,
        }),
    });
    const project = createSubagentCompactSummary(name);
    const wrapped = shell(tool, {
      ...(runtime.scheduleAnimation && { scheduleAnimation: runtime.scheduleAnimation }),
      expandedContent: {
        renderCall: (args, theme) =>
          tool.name === SUBAGENT_TOOL_NAME.start && "agents" in args && Array.isArray(args.agents)
            ? renderSubagentStartCall(args.agents, theme, true, true)
            : renderSubagentInputContent(decodeCallArguments(args), theme),
        renderResult: (result, options, theme, context) => {
          const panelOwnsLiveHierarchy = panelOwnsHierarchy(result, options.isPartial, context);
          const summary = project({
            phase: options.isPartial ? "running" : "settled",
            args: context.args,
            result,
            context,
          });
          if (!summary)
            return renderSubagentResult(
              { content: result.content },
              options.isPartial,
              true,
              theme,
            );
          const content = renderSubagentExpandedContent(result, options.isPartial, theme, {
            panelOwnsLiveHierarchy,
            isError: context.isError,
          });
          if (!isTypedReceipt(result)) return content;
          if (!context.isError && !hasReturnedFailureEvidence(result.details)) return content;
          const container = new Container();
          container.addChild(content);
          container.addChild(
            expandedSection(
              theme,
              "Output",
              renderSubagentResult({ content: result.content }, options.isPartial, true, theme),
            ),
          );
          return container;
        },
      },
      compactSummary: (input) => {
        const summary = project(input);
        if (!input.context.isPartial || !input.context.expanded)
          syncAwaitProgressTicker(undefined, false, input.context, startUiTicker);
        return summary;
      },
    });
    return wrapped;
  };
  for (const name of nested ? NESTED_SUBAGENT_TOOL_NAMES : SUBAGENT_TOOL_NAMES)
    pi.registerTool(buildTool(name));
  if (!nested)
    registerAgentTools(
      pi,
      {
        execute: (input, scripted, signal) =>
          runtime.run(
            executeAgentActionEffect(input, { kind: "main" }, scripted, runtime.environment.cwd),
            signal,
          ),
        isScripted: (id) => receiptOwner?.receipts.isNested(receiptOwner.owner, id) ?? false,
        ...(runtime.scheduleAnimation && { scheduleAnimation: runtime.scheduleAnimation }),
      },
      shell,
    );
}
