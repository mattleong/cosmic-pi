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
  nestedSubagentToolNames,
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
  decodeInputEvidence,
  renderSubagentInputContent,
} from "./render.ts";
import { renderSubagentStartCall } from "./render-start.ts";
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
  NESTED_WORKSPACE_PARENT_START_GUIDELINE,
  NORMAL_START_GUIDELINE,
} from "../delegation/prompt.ts";

const quoted = (message: string | undefined) => (message ? `“${message}”` : "");

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
  [SUBAGENT_TOOL_NAME.status]: (args) => ({ tool: SUBAGENT_TOOL_NAME.status, args }),
  [SUBAGENT_TOOL_NAME.await]: (args) => ({ tool: SUBAGENT_TOOL_NAME.await, args }),
  [SUBAGENT_TOOL_NAME.send]: (args) => ({ tool: SUBAGENT_TOOL_NAME.send, args }),
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
  [SUBAGENT_TOOL_NAME.status]: subagentArgumentPreparer(SUBAGENT_TOOL_NAME.status),
  [SUBAGENT_TOOL_NAME.await]: subagentArgumentPreparer(SUBAGENT_TOOL_NAME.await),
  [SUBAGENT_TOOL_NAME.send]: subagentArgumentPreparer(SUBAGENT_TOOL_NAME.send),
  [SUBAGENT_TOOL_NAME.lifecycle]: subagentArgumentPreparer(SUBAGENT_TOOL_NAME.lifecycle),
  [SUBAGENT_TOOL_NAME.workspace]: subagentArgumentPreparer(SUBAGENT_TOOL_NAME.workspace),
};

const SCRIPTED_SUBAGENT_GUIDELINE =
  "Native codemode can script read-only delegation with subagent_start, subagent_await, subagent_status, subagent_models, and lifecycle stop, which return version-3 structured results. Print run IDs as soon as you have them, await every call, and keep steps bounded. Don't rerun a failed script or loop on parent attention. Leave questions, retries, writers, and integration to the main agent.";

// The audience-specific delegation rule from delegation/prompt.ts is prepended at registration.
const START_GUIDELINES = [
  "Give each subagent one bounded slice with a concrete deliverable, and choose its profile by that deliverable. Read-only work is not automatically scouting.",
  "Use profile=worker for implementation you hand off. While shared-checkout writers run, coordinate and review instead of editing; worktree writers leave your cwd free. Set isolation: worktree for writers whose change you'll review and apply as a diff or that run while you edit. Shared-checkout writers in one cwd share it without file claims: give each a disjoint task scope and name the files or areas it owns.",
  "If a start fails, follow its Next step or tell the user; don't run claude, codex, or pi from the shell instead.",
];

const TOOL_SPECS: SubagentToolSpecs = {
  [SUBAGENT_TOOL_NAME.models]: {
    label: "Inspect Profile Routes",
    description:
      "Show each profile's configured route: its model candidates in fallback order, with runtime, effort, context, write intent, and fast mode, plus the user's custom agents and the candidates their overrides leave eligible. The user configures routes; you can't pick a model. Authentication is checked only at launch.",
    renderCall: (args, theme) =>
      renderSubagentCall("Inspect profile routes", args.profile ?? "all profiles", theme),
  },
  [SUBAGENT_TOOL_NAME.start]: {
    label: "Start Subagents",
    description:
      "Start 1–32 background subagents, up to your direct-child limit. Returns run IDs immediately; each report is delivered to you when its run finishes, and runs end after reporting. Give every agent a self-contained task with the relevant paths, constraints, and deliverable. The profile sets the role and model route (default generalist). Writers use the shared checkout or a private worktree: set isolation per agent, or omit it for the session default; only the main session and worktree writers can start worktree writers. Several shared-checkout writers may run in one cwd; give them disjoint task scopes because nothing enforces file ownership. Subagents started from a codemode script, and their descendants, stay read-only. A start that fails after launch reports whether cleanup finished and whether retry is available.",
    promptSnippet: "Run bounded, independent tasks in background subagents",
    promptGuidelines: START_GUIDELINES,
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
  [SUBAGENT_TOOL_NAME.status]: {
    label: "Subagent Status",
    description:
      "Inspect up to 12 subagent runs, including their claims and which controls each one supports; set includeDeliveredReports to reread a report you already received. Omit runIds to list your visible runs as a parent-before-child tree, without reports.",
    renderCall: (args, theme) =>
      renderSubagentCall(
        args.runIds === undefined ? "List subagents" : `Inspect ${targetsLabel(args)}`,
        "",
        theme,
      ),
  },
  [SUBAGENT_TOOL_NAME.await]: {
    label: "Wait for Subagents",
    description:
      "Wait for selected subagents and return their reports, with live progress. Returns early when a selected run pauses, when any subagent asks you a question, or when the user sends a message; children keep running. Follow the steps in the result, then await again.",
    promptSnippet: "Wait for subagent reports when your next step depends on them",
    promptGuidelines: [
      "After starting subagents, keep working on parts you didn't delegate; don't redo a subagent's slice while it runs. Call subagent_await only when your next step depends on a report; reports arrive on their own, so don't poll subagent_status.",
      "When a subagent tool result lists next steps, follow them in order before continuing. Answer a real parent question with subagent_send.",
    ],
    renderCall: (args, theme) =>
      renderSubagentCall(
        args.until === "all_finished" ? "Waiting for subagents" : "Waiting for first subagent",
        "",
        theme,
      ),
    lease: (presentation, args) => presentation.beginAwait(requestedRunIds(args) ?? [], args.until),
  },
  [SUBAGENT_TOOL_NAME.send]: {
    label: "Message Subagents",
    description:
      "Send the same message to one or more subagents. A target waiting on your question receives it as the answer; a running target receives it as guidance for its current turn. Each target's result says whether it was answered or guided and is reported separately.",
    renderCall: (args, theme) =>
      renderSubagentCall(`Message ${targetsLabel(args)}`, quoted(args.message), theme),
  },
  [SUBAGENT_TOOL_NAME.lifecycle]: {
    label: "Manage Subagents",
    description:
      "Interrupt, resume, or stop subagents, or retry a failed run on its profile's next configured candidate. Resume continues a paused, completed, failed, or stopped run's own session when its backend kept one; a worktree writer resumes in its workspace and reopens its review. Retry starts a new linked run, never reuses the failed candidate, and refuses when execution or cleanup is uncertain. Each target's result is reported separately.",
    promptSnippet: "Interrupt, resume, stop, or retry subagents",
    promptGuidelines: [
      "If a profiled run fails with route candidates left, retry it with action=retry before starting a generalist replacement, and don't replace a profile the user disabled. Never retry when execution or cleanup is uncertain; retry a writer only when a fresh run is still what the user wants.",
      "Resume a failed run only when its session is worth continuing, such as after a transient error; a deterministic failure repeats, so retry or start a new run instead.",
    ],
    renderCall: (args, theme) => {
      const verb = args.action ?? "manage";
      const action = `${verb[0]?.toUpperCase() ?? ""}${verb.slice(1)}`;
      const message = args.action === "resume" ? quoted(args.message) : "";
      return renderSubagentCall(`${action} ${targetsLabel(args)}`, message, theme);
    },
  },
  [SUBAGENT_TOOL_NAME.workspace]: {
    label: "Manage Writer Workspace",
    description:
      "Apply worktree writers' proposals as their direct parent. apply with just workspaceId freezes, prepares, and integrates in one call, without requiring the diff to be read or anything to be tested; its result says whether the diff was reviewed. The careful path: review freezes a finished writer's changes and returns pages that start with a summary of changed files and line counts, then the diff; read every page of one revisionId. prepare builds a separate cwd that combines that revision with your current edits, for testing. apply with that revisionId and preparationId integrates exactly that pair as uncommitted edits, keeps your index, and refuses if anything is stale or conflicts. apply with paths integrates only those changed files and keeps the rest as the proposal. revise asks the writer for another pass, and rebase first rebuilds its tree from your current files; discard deletes a rejected proposal. list marks workspaces left by an ended session: review, prepare, apply, or revise takes over an adoptable one, and discard deletes any of them.",
    promptSnippet: "Apply, or review, test, and apply, worktree writers' proposals",
    promptGuidelines: [
      "A worktree writer's report is a proposal, not approval, and nothing applies it automatically. For small or trusted changes, call apply with the workspaceId; for risky changes, review every page, prepare that revision, run the relevant tests in the prepared cwd without editing it, then apply that exact revisionId and preparationId. Either path needs no user confirmation. Don't stage or commit parent changes.",
      "If review or tests fail, revise with concrete feedback, await the successor, and review or apply its new revision. A stale preparation needs a fresh prepare and test run; when your files moved on under the proposal, revise with rebase. Discard only proposals you mean to delete.",
    ],
    renderCall: (args, theme) => renderSubagentCall("Writer workspace", args.action ?? "", theme),
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
  /** A nested worktree writer also reviews and applies its own worktree writer children. */
  nestedSurface: { readonly workspaceParent: boolean } = { workspaceParent: false },
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
    [SUBAGENT_TOOL_NAME.status]: SUBAGENT_TOOL_SCHEMAS[SUBAGENT_TOOL_NAME.status].parameters,
    [SUBAGENT_TOOL_NAME.await]: SUBAGENT_TOOL_SCHEMAS[SUBAGENT_TOOL_NAME.await].parameters,
    [SUBAGENT_TOOL_NAME.send]: SUBAGENT_TOOL_SCHEMAS[SUBAGENT_TOOL_NAME.send].parameters,
    [SUBAGENT_TOOL_NAME.lifecycle]: SUBAGENT_TOOL_SCHEMAS[SUBAGENT_TOOL_NAME.lifecycle].parameters,
    [SUBAGENT_TOOL_NAME.workspace]: SUBAGENT_TOOL_SCHEMAS[SUBAGENT_TOOL_NAME.workspace].parameters,
  };
  const argumentPreparers: SubagentArgumentPreparers = {
    ...ARGUMENT_PREPARERS,
    [SUBAGENT_TOOL_NAME.start]: subagentArgumentPreparer(SUBAGENT_TOOL_NAME.start, startParameters),
  };
  const buildTool = <N extends SubagentToolName>(name: N) => {
    const { lease, ...spec }: SubagentToolSpec<N> = TOOL_SPECS[name];
    const rootContract = !nested && isSubagentContractTool(name);
    const scriptable = rootContract;
    const tool = defineTool<SubagentToolParameters<N>>({
      ...spec,
      ...(name === SUBAGENT_TOOL_NAME.start && {
        promptGuidelines: [
          nested
            ? nestedSurface.workspaceParent
              ? NESTED_WORKSPACE_PARENT_START_GUIDELINE
              : NESTED_START_GUIDELINE
            : NORMAL_START_GUIDELINE,
          ...(spec.promptGuidelines ?? []),
          ...(agents && agents.length > 0 ? [CUSTOM_AGENT_START_GUIDELINE] : []),
          ...(scriptable ? [SCRIPTED_SUBAGENT_GUIDELINE] : []),
        ],
      }),
      name,
      exposure: scriptable ? "direct" : "model-only",
      ...(rootContract && { outputSchema: toPiToolOutputSchema(CONTRACT_SCHEMAS[name]) }),
      ...(scriptable && {
        namespace: {
          name: "subagents",
          description: "Root-session read-only subagent orchestration",
        },
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
    const project = createSubagentCompactSummary(tool.name);
    const wrapped = shell(tool, {
      ...(runtime.scheduleAnimation && { scheduleAnimation: runtime.scheduleAnimation }),
      expandedContent: {
        renderCall: (args, theme) =>
          tool.name === SUBAGENT_TOOL_NAME.start && "agents" in args && Array.isArray(args.agents)
            ? renderSubagentStartCall(args.agents, theme, true, true)
            : renderSubagentInputContent(decodeInputEvidence(args), theme),
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
  for (const name of nested
    ? nestedSubagentToolNames(nestedSurface.workspaceParent)
    : SUBAGENT_TOOL_NAMES)
    pi.registerTool(buildTool(name));
}
