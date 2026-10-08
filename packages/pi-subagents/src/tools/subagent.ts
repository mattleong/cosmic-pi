// Pi tool execution is a Promise-shaped host boundary.
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
  SUBAGENT_TOOL_NAME,
  SUBAGENT_TOOL_NAMES,
  type SubagentToolName,
} from "../run/tool-policy.ts";
import { decodeStartAwaitCardDetails } from "./details-schema.ts";
import { executeSubagentAction, type SubagentToolRuntime } from "./execute.ts";
import { hasReturnedFailureEvidence } from "./outcome.ts";
import { syncAwaitProgressTicker, type SubagentToolRenderContext } from "./render-await.ts";
import {
  renderSubagentCall,
  renderSubagentResult,
  renderSubagentExpandedContent,
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

// Pi renders calls while arguments stream in, so any field may still be absent.
const quoted = (message: string | undefined) => (message ? `“${message}”` : "");

/** A call's targets, counted as execution reads them. */
const targetsLabel = (args: SummaryArguments) =>
  countLabel(requestedRunIds(args)?.length ?? 0, "subagent");

type SubagentToolSpec<N extends SubagentToolName> = Pick<
  ToolDefinition<SubagentToolParameters<N>>,
  "label" | "description" | "promptSnippet" | "promptGuidelines" | "prepareArguments" | "renderCall"
> & {
  /** Presentation lease held for the whole execution, including proxy calls. */
  readonly lease?: (
    presentation: SubagentToolPresentation,
    // Pi's own TypeBox copy types execute args, so derive them from its definition.
    args: Parameters<ToolDefinition<SubagentToolParameters<N>>["execute"]>[1],
  ) => () => void;
};

type SubagentToolSpecs = { readonly [N in SubagentToolName]: SubagentToolSpec<N> };

/** Offered only while root scripts can reach the orchestration tools. */
const SCRIPTED_WORKFLOW_GUIDELINE =
  "For bounded root-session read-only workflows, native codemode can script subagent_start, subagent_await, subagent_status, lifecycle stop, subagent_models, subagent_list, and subagent_rename using version-1 structured results. List and rename never return report text; models reports static eligibility, not authentication readiness. Print launch IDs immediately, await every call, and use bounded steps. Do not replay a failed script or loop on parent attention. Hand questions, retries, implementation, claims, and integration back to the main agent. The main agent chooses the appropriate profile for each workflow assignment.";

const TOOL_SPECS: SubagentToolSpecs = {
  [SUBAGENT_TOOL_NAME.models]: {
    label: "Inspect Profile Routes",
    description:
      "Static preflight of complete version 6 profile-set candidates in declared order, including host, runtime, model, effort, context, write intent, OpenAI fast mode, closeOnReport, and implementation eligibility. Local Pi/Claude/Codex adapters are implemented; runtime authentication and native integration readiness are checked at launch.",
    renderCall: (args, theme) =>
      renderSubagentCall("Inspect profile routes", args.profile ?? "all profiles", theme),
  },
  [SUBAGENT_TOOL_NAME.start]: {
    label: "Start Subagents",
    description:
      "Launch one to thirty-two session-scoped background subagents, subject to the caller's configured direct-child capacity, for bounded independent workstreams such as codebase reconnaissance, research, planning, review, and disjoint implementation. Start is nonblocking. Every task must be self-contained with relevant paths, constraints, evidence, and a concrete deliverable. Each item accepts task, optional profile, optional name, and optional exact-file writes claims. The session uses shared-checkout mode by default or opt-in worktree isolation, with no per-worker override. Worktree writers currently require a root caller; nested read-only and shared-checkout launches remain supported. Script-started trees stay read-only, including model-issued descendants and retry successors; the root main agent may authorize separate writer work outside those trees. Shared-checkout writers are exclusive without claims or may share with disjoint claims. Native edit, write, and Bash are unchanged. Ordered readiness failures advance through the declared local route only before spawn. All runs close after reporting. An admitted failed start reports its run ID and settled cleanup/retry disposition. Post-ownership uncertainty never falls through.",
    promptSnippet:
      "Parallelize independent reconnaissance, research, planning, and review with background subagents",
    promptGuidelines: [
      "Before substantial work, check for independent workstreams. When two or more exist, use subagent_start early to launch one to three read-only subagents in one batch; skip subagent_start only for trivial or tightly serial tasks.",
      "Use subagent_start for bounded slices rather than the whole assignment. Choose the profile by the required deliverable, not whether the task is read-only or comes first: scout locates and explains existing code; planner recommends implementation strategies and ordered changes; reviewer evaluates code, plans, or simplification opportunities before or after implementation. Read-only does not imply scout. Do not assign scouts substantive reviews, safety judgments, or implementation design. Give each subagent a narrow question and concrete deliverable while allowing it to follow relevant evidence as deeply as needed. Use researcher for sourced external research, oracle for inherited-decision analysis, and generalist for work without a matching specialized role.",
      "Use subagent_start with self-contained tasks that include relevant paths, constraints, evidence, and deliverables. The selected version 6 profile-set route supplies runtime, model, effort, context, write intent, OpenAI fast mode, and local execution with closeOnReport=true; writes only narrows a writer to exact cooperative file claims.",
      "After subagent_start, continue independent work instead of waiting idle. Use subagent_await only when progress or final synthesis depends on a report; unclaimed completion reports are delivered automatically.",
      "Use profile=worker only for explicit implementation handoffs. While shared-checkout writers are active, the parent coordinates and reviews but does not edit. Isolated worktree writers do not share the parent cwd, so the parent may keep editing. Launch multiple shared-cwd writers only with pairwise-disjoint exact writes claims; native tools and Bash are cooperative rather than per-file sandboxed. Worktree reports are proposals, not approval: use subagent_workspace to review, test combined changes, and integrate.",
      "Use subagent_models only to inspect configured profile routing; never substitute a model or bypass a profile whose route has no eligible candidate.",
      "When a profiled run fails and its start receipt or status reports an eligible remaining route candidate, call subagent_lifecycle with action=retry for that run before launching any generalist replacement. Retry creates a new run on the next candidate from the original frozen route and never re-attempts the failed candidate.",
    ],
    prepareArguments: prepareSubagentStartArguments,
    // Pi renders calls while arguments stream in, before `agents` exists.
    renderCall: (args, theme, context) =>
      renderSubagentStartCall(
        Array.isArray(args.agents) ? args.agents : [],
        theme,
        context?.expanded === true,
        false,
        context,
      ),
    lease: (presentation, args) => presentation.beginStart(args.agents.length),
  },
  [SUBAGENT_TOOL_NAME.list]: {
    label: "List Subagents",
    description:
      "List every visible session-scoped subagent run as a compact parent-before-child hierarchy.",
    renderCall: (_args, theme) => renderSubagentCall("List subagents", "", theme),
  },
  [SUBAGENT_TOOL_NAME.status]: {
    label: "Subagent Status",
    description:
      "Inspect up to twelve specific subagent run IDs, including each run's capabilities. includeDeliveredReports reads back the latest retained report without another notification or completion claim; competing ownership still redacts it.",
    renderCall: (args, theme) => renderSubagentCall(`Inspect ${targetsLabel(args)}`, "", theme),
  },
  [SUBAGENT_TOOL_NAME.await]: {
    label: "Wait for Subagents",
    description:
      "Wait for selected background subagents when progress or final synthesis depends on their reports, with live progress. Awaited targets control completion and report claims; bounded visible descendants appear only as hierarchy context. Returns early when a target has a real parent question, is paused, or has writer admission paused. Follow the returned parent-action steps, then await again.",
    promptSnippet: "Wait at a dependency or synthesis barrier for selected subagent reports",
    promptGuidelines: [
      "Use subagent_await only when progress or final synthesis depends on selected reports; otherwise continue independent work and let unclaimed completion reports arrive automatically. Do not poll subagent_status. When await returns for parent action, execute the ordered recovery it prints, then await again. Reply only to a real parent question. For claim containment, review the audit, optionally grant only intended workspace-relative claims to the confirmed paused offender, resume admission, then lifecycle-resume with authoritative claims. If the backend cannot resume or the write was outside the workspace, stop and confirm cleanup, resume admission, launch a corrected replacement, and await it. For an ordinary pause, resume if supported or stop and replace. Use subagent_status only for troubleshooting or a user-requested snapshot.",
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
      "Send the same guidance message to one or more running subagents. Mixed-target calls report each success and failure.",
    renderCall: (args, theme) =>
      renderSubagentCall(`Guide ${targetsLabel(args)}`, quoted(args.message), theme),
  },
  [SUBAGENT_TOOL_NAME.reply]: {
    label: "Reply to Subagent",
    description: "Answer a blocking parent question from one subagent.",
    renderCall: (args, theme) =>
      renderSubagentCall("Reply to subagent", quoted(args.message), theme),
  },
  [SUBAGENT_TOOL_NAME.lifecycle]: {
    label: "Manage Subagents",
    description:
      "Interrupt, resume, stop, or explicitly continue failed subagents on their next configured profile candidate. Retry creates a new linked run from the immutable launch-time route, never re-attempts the failed candidate, and fails closed on uncertain execution or cleanup. Use generalist only after retry reports route exhaustion. Interrupt and resume require reported capabilities; stop is available for active runs. Message is accepted only for resume. Mixed-target calls report each success and failure.",
    promptSnippet:
      "Continue failed subagents through their remaining configured profile candidates",
    promptGuidelines: [
      "For a failed profiled run with remaining candidates, use subagent_lifecycle action=retry before starting a generalist replacement. Each retry advances the frozen route by one selected candidate and creates a new run; repeat only on the new failed successor until the route is exhausted.",
      "Never retry when the tool reports uncertain execution or unconfirmed cleanup. Writer retries may repeat partial side effects, so retry them only when the original handoff and current user intent authorize a fresh execution.",
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
    description: "Change one subagent's local display name.",
    renderCall: (args, theme) =>
      renderSubagentCall("Rename subagent", args.name ? `to ${args.name}` : "", theme),
  },
  [SUBAGENT_TOOL_NAME.claims]: {
    label: "Manage Writer Claims",
    description:
      "Inspect, grant, or revoke exact cooperative file claims for active shared-cwd writers, or resume writer admission after reviewing a claim violation. Grant and revoke require either a worker blocked on a parent claim question or the confirmed paused violation offender. In both cases no other tool may be active. Ordinary paused writers and non-offending peers remain ineligible. This coordinates native edit, write, and Bash; it does not replace or sandbox them.",
    promptSnippet: "Coordinate exact file ownership for shared-cwd writer pools",
    promptGuidelines: [
      "When a writer requests another file, grant it with subagent_claims before replying. Only the parent grants or transfers claims.",
      "For a confirmed paused claim offender, inspect the audit and shared tree. Grant only intended workspace-relative missing files, if any. Then call resume_admission, lifecycle-resume with the authoritative claim set and guidance, and await again. Do not use subagent_reply for claim containment.",
      "If the offender cannot resume or targeted an outside-workspace path, stop it and confirm cleanup before resume_admission. Launch a corrected replacement with exact safe claims, then await the replacement. Never reopen admission, resume work, or launch a replacement without the parent choosing that action.",
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
      "Manage isolated writer proposals as their direct parent. list pages accessible workspaces and root-only unavailable-artifact diagnostics, which grant no recovery authority; review freezes after confirmed process cleanup and returns an immutable diff in pages of at most 16000 characters. Read ALL pages of the same revisionId. prepare builds a separate cwd combining that revision with current parent edits. Run relevant combined tests there before integrate with the exact revisionId and preparationId. Integration applies uncommitted edits and preserves the parent index; stale or conflicting inputs fail closed. revise requests another writer pass and invalidates previous review/preparation; discard deletes a rejected proposal after cleanup. Reports never imply approval. Caller identity is bound by the coordinator, not tool arguments.",
    promptSnippet:
      "Review isolated writer diffs, test combined changes, and integrate uncommitted edits",
    promptGuidelines: [
      "After a worktree writer finishes, use subagent_workspace review and inspect every diff page using the returned revisionId and nextOffset. A report or summary is not a review or approval.",
      "Use subagent_workspace prepare for the reviewed revision, then run relevant tests in its returned combined cwd. Do not edit that prepared tree. Only after review and passing tests, automatically call integrate with that exact revisionId and preparationId. Do not commit or stage parent changes.",
      "If review or tests fail, use subagent_workspace revise with concrete feedback, then await its successor and review the new workspace revision from the beginning. Stale preparation or parent changes require a fresh prepare and test pass. Use discard only for a proposal you intend to delete.",
    ],
    renderCall: (args, theme) => renderSubagentCall("Writer workspace", args.action ?? "", theme),
  },
};

/** `shell` is the root's replay-staging wrapper; proxied child registrations use the plain one. */
export function registerSubagentTools(
  pi: ExtensionAPI,
  runtime: SubagentToolRuntime,
  receiptOwner?: SubagentErrorReceiptOwner,
  shell: typeof withCodePreviewShell = withCodePreviewShell,
): void {
  const startUiTicker = runtime.startUiTicker ?? startHostUiTicker;
  const settlePresentation = <A>(release: () => void, operation: () => Promise<A>): Promise<A> => {
    // Presentation teardown cannot replace the tool outcome.
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
  /** Syncs the progress ticker and reports whether the activity widget owns the live hierarchy. */
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

  const register = <N extends SubagentToolName>(name: N) => {
    const { lease, ...spec }: SubagentToolSpec<N> = TOOL_SPECS[name];
    // Native codemode may batch the root orchestration tools; proxied child registrations stay
    // model-only. Ultracode gates only subagent_workflow. Judgment tools remain model-issued;
    // the structured contract stays for model calls too.
    const rootContract = !runtime.proxyCall && isSubagentContractTool(name);
    const scriptable = rootContract;
    const tool = defineTool<SubagentToolParameters<N>>({
      ...spec,
      ...(scriptable &&
        name === SUBAGENT_TOOL_NAME.start && {
          promptGuidelines: [...(spec.promptGuidelines ?? []), SCRIPTED_WORKFLOW_GUIDELINE],
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
      execute: (_id, args, ...rest) =>
        settlePresentation(
          (runtime.toolPresentation && lease?.(runtime.toolPresentation, args)) ??
            (() => undefined),
          () =>
            // SAFETY: Pi validated args against this tool's catalog schema, typed by its TypeBox copy.
            executeSubagentAction(
              pi,
              runtime,
              { tool: name, args } as SubagentToolInput,
              ...rest,
              receiptOwner?.receipts.isNested(receiptOwner.owner, _id) ?? false,
            ),
        ),
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
            : renderSubagentInputContent(args, theme),
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
          // A rejected call's text is its whole result; the content already labels it.
          if (!isTypedReceipt(result.details)) return content;
          if (!context.isError && !hasReturnedFailureEvidence(result.details)) return content;
          // The typed projection is bounded; keep all returned recovery evidence and earlier
          // content middleware accessible for classified errors and for pending delivery,
          // which is returned failure evidence without Pi's error flag.
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
        // Compact mode owns every collapsed row, even when projection declines.
        // Hidden original renderers cannot retire a ticker started while expanded.
        if (!input.context.isPartial || !input.context.expanded)
          syncAwaitProgressTicker(undefined, false, input.context, startUiTicker);
        return summary;
      },
    });
    pi.registerTool({
      ...wrapped,
      execute: (id, args, ...rest) =>
        wrapped.execute(id, args, ...rest).then((result) => {
          // Retain only the FINAL registered result, including decoded local proxy details.
          // SAFETY: Pi validated this correlated name/args pair with the catalog schema.
          const input = { tool: name, args } as SubagentToolInput;
          receiptOwner?.receipts.retain(
            receiptOwner.owner,
            name,
            id,
            subagentToolAction(input),
            result.details,
          );
          return result;
        }),
    });
  };
  for (const name of SUBAGENT_TOOL_NAMES) register(name);
}
