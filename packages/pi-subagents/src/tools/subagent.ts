// Pi tool execution is a Promise-shaped host boundary.
import { defineTool, type ExtensionAPI, type Theme } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import { withCodePreviewShell } from "pi-code-previews";
import type { SubagentSessionEnvironment } from "../boundary/host-profile-resolution.ts";
import { SubagentBackendRegistry } from "../backend/service.ts";
import { startHostUiTicker } from "../boundary/host-ui.ts";
import type { ProfileCandidate, ProfileId, ProfileRouteSource } from "../profiles/model.ts";
import { SubagentProfileService } from "../profiles/service.ts";
import type {
  SubagentEffort,
  SubagentHost,
  SubagentRuntime,
  SubagentWriteIntent,
} from "../domain/routing.ts";
import type { SubagentRunView } from "../run/model.ts";
import { SUBAGENT_TOOL_NAMES } from "../run/tool-policy.ts";
import { SubagentService } from "../run/service.ts";
import { decodeStartAwaitCardDetails } from "./details.ts";
import { executeSubagentAction } from "./execute.ts";
import { syncAwaitProgressTicker, type SubagentToolRenderContext } from "./render-await.ts";
import { renderSubagentCall, renderSubagentResult } from "./render.ts";
import { renderSubagentStartCall } from "./render-start.ts";

import {
  AwaitParameters,
  LifecycleParameters,
  ListParameters,
  ModelsParameters,
  RenameParameters,
  ReplyParameters,
  SendParameters,
  StartParameters,
  StatusParameters,
  prepareSubagentStartArguments,
} from "./schema.ts";

export type {
  SubagentAwaitInput,
  SubagentLifecycleInput,
  SubagentListInput,
  SubagentModelsInput,
  SubagentRenameInput,
  SubagentReplyInput,
  SubagentSendInput,
  SubagentStartInput,
  SubagentStartSpec,
  SubagentStatusInput,
  SubagentToolInput,
} from "./schema.ts";

export interface SubagentStartFailure {
  readonly index: number;
  readonly name?: string;
  readonly message: string;
  /** Machine-actionable failure code (specific validation code or the error tag). */
  readonly code?: string;
}

export interface SubagentStartResolvedRoute {
  readonly profile: string;
  readonly host: SubagentHost;
  readonly runtime: SubagentRuntime;
  readonly model: string;
  readonly effort: SubagentEffort;
  readonly fastMode: boolean;
  readonly candidateIndex?: number | undefined;
}

export type SubagentStartOutcome =
  | {
      readonly index: number;
      readonly run: SubagentRunView;
    }
  | {
      readonly index: number;
      readonly failure: SubagentStartFailure;
      /** Present only after a concrete route/model was selected and attempted. */
      readonly resolvedRoute?: SubagentStartResolvedRoute | undefined;
    };

export interface SubagentActionFailure {
  readonly id: string;
  readonly message: string;
  /** Machine-actionable failure code (specific validation code or the error tag). */
  readonly code?: string;
}

export interface ProfileCandidateDiscovery extends ProfileCandidate {
  readonly status: "eligible" | "skipped";
  readonly reason: string;
}

export interface SubagentProfileView {
  readonly id: ProfileId;
  readonly description: string;
  readonly source: ProfileRouteSource;
  readonly isDefault: boolean;
  readonly defaultContext: "fresh" | "fork";
  readonly defaultWriteIntent: SubagentWriteIntent;
  readonly defaultEffort?: SubagentEffort | undefined;
  readonly candidates: ReadonlyArray<ProfileCandidateDiscovery>;
}

export interface SubagentToolRuntime {
  readonly environment: SubagentSessionEnvironment;
  readonly startUiTicker?: ((intervalMs: number, tick: () => void) => () => void) | undefined;
  readonly run: <A, E>(
    effect: Effect.Effect<A, E, SubagentService | SubagentProfileService | SubagentBackendRegistry>,
    signal?: AbortSignal,
  ) => Promise<A>;
}

export function registerSubagentTools(pi: ExtensionAPI, runtime: SubagentToolRuntime): void {
  const startUiTicker = runtime.startUiTicker ?? startHostUiTicker;
  const sharedRenderResult = (
    result: Parameters<typeof renderSubagentResult>[0],
    options: { readonly isPartial: boolean; readonly expanded: boolean },
    theme: Theme,
    context?: SubagentToolRenderContext,
  ) => {
    syncAwaitProgressTicker(
      decodeStartAwaitCardDetails(result.details),
      options.isPartial,
      context,
      startUiTicker,
    );
    return renderSubagentResult(result, options.isPartial, options.expanded, theme);
  };

  const models = defineTool({
    name: SUBAGENT_TOOL_NAMES[0],
    label: "Inspect Profile Routes",
    description:
      "Static preflight of complete version 4 profile candidates in declared order, including host, runtime, model, effort, context, write intent, fast mode, closeOnReport, and implementation eligibility. All local and Herdr Pi/Claude/Codex adapters are implemented; runtime authentication, native integration, and private-harness readiness are checked at launch.",
    parameters: ModelsParameters,
    execute: (_id, input, signal, onUpdate, ctx) =>
      executeSubagentAction(pi, runtime, { ...input, action: "models" }, signal, onUpdate, ctx),
    renderCall: (args, theme) =>
      renderSubagentCall("Inspect profile routes", args.profile ?? "all profiles", theme),
    renderResult: sharedRenderResult,
  });

  const start = defineTool({
    name: SUBAGENT_TOOL_NAMES[1],
    label: "Start Subagents",
    description:
      "Launch one to twelve session-scoped background subagents for bounded, independent workstreams such as codebase reconnaissance, external research, planning, and independent review. Start is nonblocking: launch a batch early and continue working. Every task must be self-contained with relevant paths, constraints, evidence to inspect, and a concrete deliverable. Each item accepts only task, optional profile, and optional name. The selected profile supplies host, runtime, model, effort, context, write intent, fast mode, and closeOnReport. Ordered readiness failures fall through only before spawn; post-ownership uncertainty never falls through. Successful launches remain active when a peer launch fails.",
    promptSnippet:
      "Parallelize independent reconnaissance, research, planning, and review with background subagents",
    promptGuidelines: [
      "Before substantial work, check for independent workstreams. When two or more exist, use subagent_start early to launch one to three read-only subagents in one batch; skip subagent_start only for trivial or tightly serial tasks.",
      "Use subagent_start for bounded slices rather than the whole assignment: give each scout one narrow reconnaissance question and a concrete deliverable while allowing it to follow relevant evidence as deeply as needed; use researcher for sourced external research, planner for implementation planning, reviewer for independent verification, oracle for inherited-decision analysis, and generalist for other read-only work.",
      "Use subagent_start with self-contained tasks that include relevant paths, constraints, evidence, and deliverables. Each agent item accepts task, optional profile, and optional name; the selected version 4 profile exclusively supplies host, runtime, model, effort, context, write intent, fast mode, and closeOnReport.",
      "After subagent_start, continue independent work instead of waiting idle. Use subagent_await only when progress or final synthesis depends on a report; unclaimed completion reports are delivered automatically.",
      "Use subagent_start with profile=worker only for an explicit implementation handoff while the main agent does not edit. Keep one writer in the shared cwd, counting the main agent, and serialize writers unless isolated worktrees are available.",
      "Use subagent_models only to inspect configured profile routing; never substitute a model or bypass a profile whose route has no eligible candidate.",
      "When a profiled run fails and its status reports remaining route candidates, call subagent_lifecycle with action=retry for that run before launching any generalist replacement. Retry creates a new run on the next candidate from the original frozen route and never re-attempts the failed candidate.",
    ],
    parameters: StartParameters,
    prepareArguments: prepareSubagentStartArguments,
    execute: (_id, input, signal, onUpdate, ctx) =>
      executeSubagentAction(pi, runtime, { ...input, action: "start" }, signal, onUpdate, ctx),
    renderCall: (args, theme, context) =>
      renderSubagentStartCall(args.agents, theme, context?.expanded === true),
    renderResult: sharedRenderResult,
  });

  const list = defineTool({
    name: SUBAGENT_TOOL_NAMES[2],
    label: "List Subagents",
    description: "List every session-scoped subagent run in compact form.",
    parameters: ListParameters,
    execute: (_id, input, signal, onUpdate, ctx) =>
      executeSubagentAction(pi, runtime, { ...input, action: "list" }, signal, onUpdate, ctx),
    renderCall: (_args, theme) => renderSubagentCall("List subagents", "", theme),
    renderResult: sharedRenderResult,
  });

  const status = defineTool({
    name: SUBAGENT_TOOL_NAMES[3],
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
    name: SUBAGENT_TOOL_NAMES[4],
    label: "Await Subagents",
    description:
      "Wait for selected background subagents when progress or final synthesis depends on their reports, with live progress. Returns early if a subagent needs a parent reply, then call it again after subagent_reply. A retained run in reported state counts as finished for its current assignment.",
    promptSnippet: "Wait at a dependency or synthesis barrier for selected subagent reports",
    promptGuidelines: [
      "Use subagent_await only when progress or final synthesis depends on selected reports; otherwise continue independent work and let unclaimed completion reports arrive automatically. Do not poll subagent_status. If subagent_await returns for a parent question, use subagent_reply and then call subagent_await again; use subagent_status only for troubleshooting or a user-requested snapshot.",
    ],
    parameters: AwaitParameters,
    execute: (_id, input, signal, onUpdate, ctx) =>
      executeSubagentAction(pi, runtime, { ...input, action: "await" }, signal, onUpdate, ctx),
    renderCall: (args, theme) =>
      renderSubagentCall(
        `Await ${args.runIds.length} subagent${args.runIds.length === 1 ? "" : "s"}`,
        `${args.until === "all_finished" ? "until all finish" : "until first finishes"} · ${args.runIds.join(", ")}`,
        theme,
      ),
    renderResult: sharedRenderResult,
  });

  const send = defineTool({
    name: SUBAGENT_TOOL_NAMES[5],
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
    name: SUBAGENT_TOOL_NAMES[6],
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
    name: SUBAGENT_TOOL_NAMES[7],
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
    name: SUBAGENT_TOOL_NAMES[8],
    label: "Rename Subagent",
    description: "Change one subagent's local display name.",
    parameters: RenameParameters,
    execute: (_id, input, signal, onUpdate, ctx) =>
      executeSubagentAction(pi, runtime, { ...input, action: "rename" }, signal, onUpdate, ctx),
    renderCall: (args, theme) =>
      renderSubagentCall("Rename subagent", `${args.runId} → ${args.name}`, theme),
    renderResult: sharedRenderResult,
  });

  for (const tool of [models, start, list, status, awaitTool, send, reply, lifecycle, rename])
    pi.registerTool(withCodePreviewShell(tool));
}
