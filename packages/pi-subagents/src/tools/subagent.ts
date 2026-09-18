// Pi tool execution is a Promise-shaped host boundary.
import { defineTool, type ExtensionAPI, type Theme } from "@earendil-works/pi-coding-agent";
import { withCodePreviewShell } from "pi-code-previews";
import { createSubagentCompactSummary } from "./compact-summary.ts";
import { startHostUiTicker } from "pi-cosmic-ui/boundary/host-status";
import { SUBAGENT_TOOL_NAME } from "../run/tool-policy.ts";
import { decodeStartAwaitCardDetails } from "./details-schema.ts";
import { executeSubagentAction, type SubagentToolRuntime } from "./execute.ts";
import { syncAwaitProgressTicker, type SubagentToolRenderContext } from "./render-await.ts";
import { renderSubagentCall, renderSubagentResult } from "./render.ts";
import { renderSubagentStartCall } from "./render-start.ts";

import {
  AwaitParameters,
  ClaimsParameters,
  LifecycleParameters,
  ListParameters,
  ModelsParameters,
  RenameParameters,
  ReplyParameters,
  SendParameters,
  StartParameters,
  StatusParameters,
  WorkspaceParameters,
  prepareSubagentStartArguments,
} from "./schema.ts";

export function registerSubagentTools(pi: ExtensionAPI, runtime: SubagentToolRuntime): void {
  const startUiTicker = runtime.startUiTicker ?? startHostUiTicker;
  const settlePresentation = <A>(release: () => void, operation: () => Promise<A>): Promise<A> => {
    const releaseSafely = () => {
      try {
        release();
      } catch {
        // Presentation teardown cannot replace the tool outcome.
      }
    };
    let pending: Promise<A>;
    try {
      pending = operation();
    } catch (error) {
      releaseSafely();
      throw error;
    }
    return pending.finally(releaseSafely);
  };
  const sharedRenderResult = (
    result: Parameters<typeof renderSubagentResult>[0],
    options: { readonly isPartial: boolean; readonly expanded: boolean },
    theme: Theme,
    context?: SubagentToolRenderContext,
  ) => {
    const details = decodeStartAwaitCardDetails(result.details);
    const panelOwnsLiveHierarchy =
      options.isPartial &&
      (details?.action === "start" || details?.action === "await") &&
      runtime.toolPresentation?.isLiveHierarchyAvailable() === true;
    syncAwaitProgressTicker(
      details,
      options.isPartial && !panelOwnsLiveHierarchy,
      context,
      startUiTicker,
    );
    return renderSubagentResult(result, options.isPartial, options.expanded, theme, {
      panelOwnsLiveHierarchy,
    });
  };

  const models = defineTool({
    name: SUBAGENT_TOOL_NAME.models,
    label: "Inspect Profile Routes",
    description:
      "Static preflight of complete version 6 profile-set candidates in declared order, including host, runtime, model, effort, context, write intent, OpenAI fast mode, closeOnReport, and implementation eligibility. All local and Herdr Pi/Claude/Codex adapters are implemented; runtime authentication, native integration, and private-harness readiness are checked at launch.",
    parameters: ModelsParameters,
    execute: (_id, input, signal, onUpdate, ctx) =>
      executeSubagentAction(pi, runtime, { ...input, action: "models" }, signal, onUpdate, ctx),
    renderCall: (args, theme) =>
      renderSubagentCall("Inspect profile routes", args.profile ?? "all profiles", theme),
    renderResult: sharedRenderResult,
  });

  const start = defineTool({
    name: SUBAGENT_TOOL_NAME.start,
    label: "Start Subagents",
    description:
      "Launch one to thirty-two session-scoped background subagents, subject to the caller's configured direct-child capacity, for bounded independent workstreams such as codebase reconnaissance, research, planning, review, and disjoint implementation. Start is nonblocking. Every task must be self-contained with relevant paths, constraints, evidence, and a concrete deliverable. Each item accepts task, optional profile, optional name, and optional exact-file writes claims. The session uses shared-checkout mode by default or opt-in worktree isolation, with no per-worker override. Worktree writers currently require a root caller; nested read-only and shared-checkout launches remain supported. Shared-checkout writers are exclusive without claims or may share with disjoint claims. Native edit, write, and Bash are unchanged. Ordered readiness failures fall through only before spawn; an unsupported Herdr protocol first retries the same candidate on the local host and forces closeOnReport=true. An admitted failed start reports its run ID and settled cleanup/retry disposition. Post-ownership uncertainty never falls through.",
    promptSnippet:
      "Parallelize independent reconnaissance, research, planning, and review with background subagents",
    promptGuidelines: [
      "Before substantial work, check for independent workstreams. When two or more exist, use subagent_start early to launch one to three read-only subagents in one batch; skip subagent_start only for trivial or tightly serial tasks.",
      "Use subagent_start for bounded slices rather than the whole assignment. Choose the profile by the required deliverable, not whether the task is read-only or comes first: scout locates and explains existing code; planner recommends implementation strategies and ordered changes; reviewer evaluates code, plans, or simplification opportunities before or after implementation. Read-only does not imply scout. Do not assign scouts substantive reviews, safety judgments, or implementation design. Give each subagent a narrow question and concrete deliverable while allowing it to follow relevant evidence as deeply as needed. Use researcher for sourced external research, oracle for inherited-decision analysis, and generalist for work without a matching specialized role.",
      "Use subagent_start with self-contained tasks that include relevant paths, constraints, evidence, and deliverables. The selected version 6 profile-set route supplies runtime, model, effort, context, write intent, OpenAI fast mode, and normal host/close behavior; writes only narrows a writer to exact cooperative file claims. If Herdr reports an unsupported protocol before ownership, subagent_start visibly falls back to the same runtime on the local host and forces closeOnReport=true.",
      "After subagent_start, continue independent work instead of waiting idle. Use subagent_await only when progress or final synthesis depends on a report; unclaimed completion reports are delivered automatically.",
      "Use profile=worker only for explicit implementation handoffs. While shared-checkout writers are active, the parent coordinates and reviews but does not edit. Isolated worktree writers do not share the parent cwd, so the parent may keep editing. Launch multiple shared-cwd writers only with pairwise-disjoint exact writes claims; native tools and Bash are cooperative rather than per-file sandboxed. Worktree reports are proposals, not approval: use subagent_workspace to review, test combined changes, and integrate.",
      "Use subagent_models only to inspect configured profile routing; never substitute a model or bypass a profile whose route has no eligible candidate.",
      "When a profiled run fails and its start receipt or status reports an eligible remaining route candidate, call subagent_lifecycle with action=retry for that run before launching any generalist replacement. Retry creates a new run on the next candidate from the original frozen route and never re-attempts the failed candidate.",
    ],
    parameters: StartParameters,
    prepareArguments: prepareSubagentStartArguments,
    execute: (_id, input, signal, onUpdate, ctx) =>
      settlePresentation(
        runtime.toolPresentation?.beginStart(input.agents.length) ?? (() => undefined),
        () =>
          executeSubagentAction(pi, runtime, { ...input, action: "start" }, signal, onUpdate, ctx),
      ),
    renderCall: (args, theme, context) =>
      renderSubagentStartCall(args.agents, theme, context?.expanded === true),
    renderResult: sharedRenderResult,
  });

  const list = defineTool({
    name: SUBAGENT_TOOL_NAME.list,
    label: "List Subagents",
    description:
      "List every visible session-scoped subagent run as a compact parent-before-child hierarchy.",
    parameters: ListParameters,
    execute: (_id, input, signal, onUpdate, ctx) =>
      executeSubagentAction(pi, runtime, { ...input, action: "list" }, signal, onUpdate, ctx),
    renderCall: (_args, theme) => renderSubagentCall("List subagents", "", theme),
    renderResult: sharedRenderResult,
  });

  const status = defineTool({
    name: SUBAGENT_TOOL_NAME.status,
    label: "Subagent Status",
    description:
      "Inspect up to twelve specific subagent run IDs, including each run's capabilities.",
    parameters: StatusParameters,
    execute: (_id, input, signal, onUpdate, ctx) =>
      executeSubagentAction(pi, runtime, { ...input, action: "status" }, signal, onUpdate, ctx),
    renderCall: (args, theme) =>
      renderSubagentCall(
        `Inspect ${args.runIds.length} subagent${args.runIds.length === 1 ? "" : "s"}`,
        args.runIds.join(", "),
        theme,
      ),
    renderResult: sharedRenderResult,
  });

  const awaitTool = defineTool({
    name: SUBAGENT_TOOL_NAME.await,
    label: "Wait for Subagents",
    description:
      "Wait for selected background subagents when progress or final synthesis depends on their reports, with live progress. Awaited targets control completion and report claims; bounded visible descendants appear only as hierarchy context. Returns early when a target has a real parent question, is paused, or has writer admission paused. Follow the returned parent-action steps, then await again. A retained target in reported state counts as finished for its current assignment.",
    promptSnippet: "Wait at a dependency or synthesis barrier for selected subagent reports",
    promptGuidelines: [
      "Use subagent_await only when progress or final synthesis depends on selected reports; otherwise continue independent work and let unclaimed completion reports arrive automatically. Do not poll subagent_status. When await returns for parent action, execute the ordered recovery it prints, then await again. Reply only to a real parent question. For claim containment, review the audit, optionally grant only intended workspace-relative claims to the confirmed paused offender, resume admission, then lifecycle-resume with authoritative claims. If the backend cannot resume or the write was outside the workspace, stop and confirm cleanup, resume admission, launch a corrected replacement, and await it. For an ordinary pause, resume if supported or stop and replace. Use subagent_status only for troubleshooting or a user-requested snapshot.",
    ],
    parameters: AwaitParameters,
    execute: (_id, input, signal, onUpdate, ctx) =>
      settlePresentation(
        runtime.toolPresentation?.beginAwait(
          [...new Set(input.runIds.map((id) => id.trim()).filter(Boolean))],
          input.until,
        ) ?? (() => undefined),
        () =>
          executeSubagentAction(pi, runtime, { ...input, action: "await" }, signal, onUpdate, ctx),
      ),
    renderCall: (args, theme) =>
      renderSubagentCall(
        args.until === "all_finished" ? "Waiting for subagents" : "Waiting for first subagent",
        "",
        theme,
      ),
    renderResult: sharedRenderResult,
  });

  const send = defineTool({
    name: SUBAGENT_TOOL_NAME.send,
    label: "Send Subagent Guidance",
    description:
      "Send the same guidance message to one or more running subagents. For a reported retained run, this begins its next assignment and report generation. Mixed-target calls report each success and failure.",
    parameters: SendParameters,
    execute: (_id, input, signal, onUpdate, ctx) =>
      executeSubagentAction(pi, runtime, { ...input, action: "send" }, signal, onUpdate, ctx),
    renderCall: (args, theme) =>
      renderSubagentCall(
        `Guide ${args.runIds.length} subagent${args.runIds.length === 1 ? "" : "s"}`,
        `${args.runIds.join(", ")} · “${args.message}”`,
        theme,
      ),
    renderResult: sharedRenderResult,
  });

  const reply = defineTool({
    name: SUBAGENT_TOOL_NAME.reply,
    label: "Reply to Subagent",
    description: "Answer a blocking parent question from one subagent.",
    parameters: ReplyParameters,
    execute: (_id, input, signal, onUpdate, ctx) =>
      executeSubagentAction(pi, runtime, { ...input, action: "reply" }, signal, onUpdate, ctx),
    renderCall: (args, theme) =>
      renderSubagentCall("Reply to subagent", `${args.runId} · “${args.message}”`, theme),
    renderResult: sharedRenderResult,
  });

  const lifecycle = defineTool({
    name: SUBAGENT_TOOL_NAME.lifecycle,
    label: "Manage Subagents",
    description:
      "Interrupt, resume, stop, or explicitly continue failed subagents on their next configured profile candidate. Retry creates a new linked run from the immutable launch-time route, never re-attempts the failed candidate, and fails closed on uncertain execution or cleanup. Use generalist only after retry reports route exhaustion. Interrupt and resume require reported capabilities; stop is available for active runs. Message is accepted only for resume. Mixed-target calls report each success and failure.",
    promptSnippet:
      "Continue failed subagents through their remaining configured profile candidates",
    promptGuidelines: [
      "For a failed profiled run with remaining candidates, use subagent_lifecycle action=retry before starting a generalist replacement. Each retry advances the frozen route by one selected candidate and creates a new run; repeat only on the new failed successor until the route is exhausted.",
      "Never retry when the tool reports uncertain execution or unconfirmed cleanup. Writer retries may repeat partial side effects, so retry them only when the original handoff and current user intent authorize a fresh execution.",
    ],
    parameters: LifecycleParameters,
    execute: (_id, input, signal, onUpdate, ctx) =>
      executeSubagentAction(pi, runtime, input, signal, onUpdate, ctx),
    renderCall: (args, theme) => {
      const action = `${args.action[0]?.toUpperCase() ?? ""}${args.action.slice(1)}`;
      const message = args.action === "resume" && args.message ? ` · “${args.message}”` : "";
      return renderSubagentCall(
        `${action} ${args.runIds.length} subagent${args.runIds.length === 1 ? "" : "s"}`,
        `${args.runIds.join(", ")}${message}`,
        theme,
      );
    },
    renderResult: sharedRenderResult,
  });

  const rename = defineTool({
    name: SUBAGENT_TOOL_NAME.rename,
    label: "Rename Subagent",
    description: "Change one subagent's local display name.",
    parameters: RenameParameters,
    execute: (_id, input, signal, onUpdate, ctx) =>
      executeSubagentAction(pi, runtime, { ...input, action: "rename" }, signal, onUpdate, ctx),
    renderCall: (args, theme) =>
      renderSubagentCall("Rename subagent", `${args.runId} → ${args.name}`, theme),
    renderResult: sharedRenderResult,
  });

  const claims = defineTool({
    name: SUBAGENT_TOOL_NAME.claims,
    label: "Manage Writer Claims",
    description:
      "Inspect, grant, or revoke exact cooperative file claims for active shared-cwd writers, or resume writer admission after reviewing a claim violation. Grant and revoke require either a worker blocked on a parent claim question or the confirmed paused violation offender. In both cases no other tool may be active. Ordinary paused writers and non-offending peers remain ineligible. This coordinates native edit, write, and Bash; it does not replace or sandbox them.",
    promptSnippet: "Coordinate exact file ownership for shared-cwd writer pools",
    promptGuidelines: [
      "When a writer requests another file, grant it with subagent_claims before replying. Only the parent grants or transfers claims.",
      "For a confirmed paused claim offender, inspect the audit and shared tree. Grant only intended workspace-relative missing files, if any. Then call resume_admission, lifecycle-resume with the authoritative claim set and guidance, and await again. Do not use subagent_reply for claim containment.",
      "If the offender cannot resume or targeted an outside-workspace path, stop it and confirm cleanup before resume_admission. Launch a corrected replacement with exact safe claims, then await the replacement. Never reopen admission, resume work, or launch a replacement without the parent choosing that action.",
    ],
    parameters: ClaimsParameters,
    execute: (_id, input, signal, onUpdate, ctx) =>
      executeSubagentAction(
        pi,
        runtime,
        { action: "claims", operation: input },
        signal,
        onUpdate,
        ctx,
      ),
    renderCall: (args, theme) =>
      renderSubagentCall(
        args.action === "list"
          ? "Inspect writer claims"
          : args.action === "resume_admission"
            ? "Resume writer admission"
            : `${args.action === "grant" ? "Grant" : "Revoke"} writer claims`,
        args.action === "list"
          ? (args.runIds ?? []).join(", ")
          : `${args.runId ?? ""}${args.paths !== undefined ? ` · ${args.paths.join(", ")}` : ""}`,
        theme,
      ),
    renderResult: sharedRenderResult,
  });

  const workspace = defineTool({
    name: SUBAGENT_TOOL_NAME.workspace,
    label: "Manage Writer Workspace",
    description:
      "Manage isolated writer proposals as their direct parent. list pages accessible workspaces; review freezes after confirmed process cleanup and returns an immutable diff in pages of at most 16000 characters. Read ALL pages of the same revisionId. prepare builds a separate cwd combining that revision with current parent edits. Run relevant combined tests there before integrate with the exact revisionId and preparationId. Integration applies uncommitted edits and preserves the parent index; stale or conflicting inputs fail closed. revise requests another writer pass and invalidates previous review/preparation; discard deletes a rejected proposal after cleanup. Reports never imply approval. Caller identity is bound by the coordinator, not tool arguments.",
    promptSnippet:
      "Review isolated writer diffs, test combined changes, and integrate uncommitted edits",
    promptGuidelines: [
      "After a worktree writer finishes, use subagent_workspace review and inspect every diff page using the returned revisionId and nextOffset. A report or summary is not a review or approval.",
      "Use subagent_workspace prepare for the reviewed revision, then run relevant tests in its returned combined cwd. Do not edit that prepared tree. Only after review and passing tests, automatically call integrate with that exact revisionId and preparationId. Do not commit or stage parent changes.",
      "If review or tests fail, use subagent_workspace revise with concrete feedback, then await its successor and review the new workspace revision from the beginning. Stale preparation or parent changes require a fresh prepare and test pass. Use discard only for a proposal you intend to delete.",
    ],
    parameters: WorkspaceParameters,
    execute: (_id, input, signal, onUpdate, ctx) =>
      executeSubagentAction(
        pi,
        runtime,
        { action: "workspace", operation: input },
        signal,
        onUpdate,
        ctx,
      ),
    renderCall: (args, theme) =>
      renderSubagentCall(
        "Writer workspace",
        `${args.action ?? ""} ${args.workspaceId ?? ""}`,
        theme,
      ),
    renderResult: sharedRenderResult,
  });

  for (const tool of [
    models,
    start,
    list,
    status,
    awaitTool,
    send,
    reply,
    lifecycle,
    rename,
    claims,
    workspace,
  ]) {
    const project = createSubagentCompactSummary(tool.name);
    pi.registerTool(
      withCodePreviewShell(tool, {
        ...(runtime.scheduleAnimation && { scheduleAnimation: runtime.scheduleAnimation }),
        compactSummary: (input) => {
          const summary = project(input);
          // Compact mode owns every collapsed row, even when projection declines.
          // Hidden original renderers cannot retire a ticker started while expanded.
          if (!input.context.isPartial || !input.context.expanded)
            syncAwaitProgressTicker(undefined, false, input.context, startUiTicker);
          // The live panel intentionally empties the original result, not the call heading.
          if (
            summary?.expandedResultOwnsCall &&
            input.context.isPartial &&
            runtime.toolPresentation?.isLiveHierarchyAvailable() === true
          ) {
            const { expandedResultOwnsCall: _ownedCall, ...retained } = summary;
            return retained;
          }
          return summary;
        },
      }),
    );
  }
}
