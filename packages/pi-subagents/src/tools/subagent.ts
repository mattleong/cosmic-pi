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
  decodeInputEvidence,
  renderSubagentInputContent,
} from "./render.ts";
import { renderSubagentStartCall } from "./render-start.ts";
import {
  prepareSubagentStartArguments,
  subagentToolAction,
  SUBAGENT_TOOL_SCHEMAS,
  type SubagentToolInput,
  type SubagentToolParameters,
} from "./schema.ts";
import { countLabel, invokeHostCallback, toPiToolOutputSchema } from "pi-cosmic-core";
import { CONTRACT_SCHEMAS, isSubagentContractTool } from "./contract-schema.ts";
import { NESTED_START_GUIDELINE, NORMAL_START_GUIDELINE } from "../delegation/prompt.ts";

const quoted = (message: string | undefined) => (message ? `“${message}”` : "");

const targetsLabel = (args: SummaryArguments) =>
  countLabel(requestedRunIds(args)?.length ?? 0, "subagent");

type SubagentToolSpec<N extends SubagentToolName> = Pick<
  ToolDefinition<SubagentToolParameters<N>>,
  "label" | "description" | "promptSnippet" | "promptGuidelines" | "prepareArguments" | "renderCall"
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
  [SUBAGENT_TOOL_NAME.list]: (args) => ({ tool: SUBAGENT_TOOL_NAME.list, args }),
  [SUBAGENT_TOOL_NAME.status]: (args) => ({ tool: SUBAGENT_TOOL_NAME.status, args }),
  [SUBAGENT_TOOL_NAME.await]: (args) => ({ tool: SUBAGENT_TOOL_NAME.await, args }),
  [SUBAGENT_TOOL_NAME.send]: (args) => ({ tool: SUBAGENT_TOOL_NAME.send, args }),
  [SUBAGENT_TOOL_NAME.reply]: (args) => ({ tool: SUBAGENT_TOOL_NAME.reply, args }),
  [SUBAGENT_TOOL_NAME.lifecycle]: (args) => ({ tool: SUBAGENT_TOOL_NAME.lifecycle, args }),
  [SUBAGENT_TOOL_NAME.rename]: (args) => ({ tool: SUBAGENT_TOOL_NAME.rename, args }),
  [SUBAGENT_TOOL_NAME.claims]: (args) => ({ tool: SUBAGENT_TOOL_NAME.claims, args }),
  [SUBAGENT_TOOL_NAME.workspace]: (args) => ({ tool: SUBAGENT_TOOL_NAME.workspace, args }),
};

const SCRIPTED_SUBAGENT_GUIDELINE =
  "Native codemode can script read-only delegation with subagent_start, subagent_await, subagent_status, subagent_models, subagent_list, subagent_rename, and lifecycle stop, which return version-1 structured results. Print run IDs as soon as you have them, await every call, and keep steps bounded. Don't rerun a failed script or loop on parent attention. Leave questions, retries, writers, claims, and integration to the main agent.";

// The audience-specific delegation rule from delegation/prompt.ts is prepended at registration.
const START_GUIDELINES = [
  "Give each subagent one bounded slice with a concrete deliverable, and choose its profile by that deliverable. Read-only work is not automatically scouting.",
  "Use profile=worker for implementation you hand off. While shared-checkout writers run, coordinate and review instead of editing; worktree writers leave your cwd free. Run several shared-checkout writers only with pairwise-disjoint `writes` claims.",
];

const TOOL_SPECS: SubagentToolSpecs = {
  [SUBAGENT_TOOL_NAME.models]: {
    label: "Inspect Profile Routes",
    description:
      "Show each profile's configured route: its model candidates in fallback order, with runtime, effort, context, write intent, and fast mode. The user configures routes; you can't pick a model. Authentication is checked only at launch.",
    renderCall: (args, theme) =>
      renderSubagentCall("Inspect profile routes", args.profile ?? "all profiles", theme),
  },
  [SUBAGENT_TOOL_NAME.start]: {
    label: "Start Subagents",
    description:
      "Start 1–32 background subagents, up to your direct-child limit. Returns run IDs immediately; each report is delivered to you when its run finishes, and runs end after reporting. Give every agent a self-contained task with the relevant paths, constraints, and deliverable. The profile sets the role and model route (default generalist). Writers use the shared checkout or isolated worktrees, per the session setting; only the main session can start worktree writers. A shared-checkout writer without `writes` claims has the checkout to itself; parallel writers need disjoint exact claims. Subagents started from a codemode script, and their descendants, stay read-only. A start that fails after launch reports whether cleanup finished and whether retry is available.",
    promptSnippet: "Run bounded, independent tasks in background subagents",
    promptGuidelines: START_GUIDELINES,
    prepareArguments: prepareSubagentStartArguments,
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
  [SUBAGENT_TOOL_NAME.list]: {
    label: "List Subagents",
    description: "List your visible subagent runs as a parent-before-child tree, without reports.",
    renderCall: (_args, theme) => renderSubagentCall("List subagents", "", theme),
  },
  [SUBAGENT_TOOL_NAME.status]: {
    label: "Subagent Status",
    description:
      "Inspect up to 12 subagent runs, including which controls each one supports. Set includeDeliveredReports to reread a report you already received.",
    renderCall: (args, theme) => renderSubagentCall(`Inspect ${targetsLabel(args)}`, "", theme),
  },
  [SUBAGENT_TOOL_NAME.await]: {
    label: "Wait for Subagents",
    description:
      "Wait for selected subagents and return their reports, with live progress. Returns early when a run asks you a question, pauses, or has writer admission paused; follow the steps in the result, then await again.",
    promptSnippet: "Wait for subagent reports when your next step depends on them",
    promptGuidelines: [
      "After starting subagents, keep working on parts you didn't delegate; don't redo a subagent's slice while it runs. Call subagent_await only when your next step depends on a report; reports arrive on their own, so don't poll subagent_status.",
      "When a subagent tool result lists next steps, follow them in order before continuing. Use subagent_reply only for a real parent question.",
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
    label: "Send Subagent Guidance",
    description:
      "Send the same guidance to one or more running subagents. Each target's result is reported separately.",
    renderCall: (args, theme) =>
      renderSubagentCall(`Guide ${targetsLabel(args)}`, quoted(args.message), theme),
  },
  [SUBAGENT_TOOL_NAME.reply]: {
    label: "Reply to Subagent",
    description: "Answer a subagent's blocking question.",
    renderCall: (args, theme) =>
      renderSubagentCall("Reply to subagent", quoted(args.message), theme),
  },
  [SUBAGENT_TOOL_NAME.lifecycle]: {
    label: "Manage Subagents",
    description:
      "Interrupt, resume, or stop subagents, or retry a failed run on its profile's next configured candidate. Retry starts a new linked run, never reuses the failed candidate, and refuses when execution or cleanup is uncertain. Each target's result is reported separately.",
    promptSnippet: "Interrupt, resume, stop, or retry subagents",
    promptGuidelines: [
      "If a profiled run fails with route candidates left, retry it with action=retry before starting a generalist replacement, and don't replace a profile the user disabled. Never retry when execution or cleanup is uncertain; retry a writer only when a fresh run is still what the user wants.",
    ],
    renderCall: (args, theme) => {
      const verb = args.action ?? "manage";
      const action = `${verb[0]?.toUpperCase() ?? ""}${verb.slice(1)}`;
      const message = args.action === "resume" ? quoted(args.message) : "";
      return renderSubagentCall(`${action} ${targetsLabel(args)}`, message, theme);
    },
  },
  [SUBAGENT_TOOL_NAME.rename]: {
    label: "Rename Subagent",
    description: "Change one subagent's display name.",
    renderCall: (args, theme) =>
      renderSubagentCall("Rename subagent", args.name ? `to ${args.name}` : "", theme),
  },
  [SUBAGENT_TOOL_NAME.claims]: {
    label: "Manage Writer Claims",
    description:
      "Inspect, grant, or revoke exact file claims for shared-checkout writers, or reopen writer admission after a claim violation. Grant and revoke work only for a writer waiting on your claim question or the paused offender of a violation, while no other tool call is running. Claims coordinate writers; they don't sandbox file access.",
    promptSnippet: "Coordinate exact file ownership for shared-checkout writers",
    promptGuidelines: [
      "Only you grant claims: when a writer asks for another file, grant it with subagent_claims before replying. For a claim violation, follow the recovery steps in the tool result instead of using subagent_reply.",
    ],
    renderCall: (args, theme) =>
      renderSubagentCall(
        args.action === "list"
          ? "Inspect writer claims"
          : args.action === "resume_admission"
            ? "Resume writer admission"
            : `${args.action === "grant" ? "Grant" : "Revoke"} writer claims`,
        args.action === "list" ? "" : (args.paths ?? []).join(", "),
        theme,
      ),
  },
  [SUBAGENT_TOOL_NAME.workspace]: {
    label: "Manage Writer Workspace",
    description:
      "Review and integrate worktree writers' proposals as their direct parent. review freezes a finished writer's changes and returns the diff in pages; read every page of one revisionId. prepare builds a separate cwd that combines that revision with your current edits, for testing. integrate applies the exact revisionId and preparationId as uncommitted edits, keeps your index, and refuses if anything is stale or conflicts. revise asks the writer for another pass; discard deletes a rejected proposal.",
    promptSnippet: "Review, test, and integrate worktree writers' proposals",
    promptGuidelines: [
      "A worktree writer's report is a proposal, not approval. Review every diff page of its revision, prepare it, and run the relevant tests in the prepared cwd without editing it; then integrate that exact revisionId and preparationId without asking first. Don't stage or commit parent changes.",
      "If review or tests fail, revise with concrete feedback, await the successor, and review its new revision from the beginning. A stale preparation needs a fresh prepare and test run. Discard only proposals you mean to delete.",
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
  const buildTool = <N extends SubagentToolName>(name: N) => {
    const { lease, ...spec }: SubagentToolSpec<N> = TOOL_SPECS[name];
    const rootContract = !nested && isSubagentContractTool(name);
    const scriptable = rootContract;
    const tool = defineTool<SubagentToolParameters<N>>({
      ...spec,
      ...(name === SUBAGENT_TOOL_NAME.start && {
        promptGuidelines: [
          nested ? NESTED_START_GUIDELINE : NORMAL_START_GUIDELINE,
          ...(spec.promptGuidelines ?? []),
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
      parameters: SUBAGENT_TOOL_SCHEMAS[name].parameters,
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
  for (const name of nested ? NESTED_SUBAGENT_TOOL_NAMES : SUBAGENT_TOOL_NAMES)
    pi.registerTool(buildTool(name));
}
