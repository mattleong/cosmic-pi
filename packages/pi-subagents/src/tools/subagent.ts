// Pi tool execution is a Promise-shaped host boundary.
// @effect-diagnostics effect/asyncFunction:off
import { defineTool, type ExtensionAPI, type Theme } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import { withCodePreviewShell } from "pi-code-previews";
import type { SubagentSessionEnvironment } from "../boundary/host-profile-resolution.ts";
import { SubagentBackendRegistry } from "../backend/service.ts";
import { startHostUiTicker } from "../boundary/host-ui.ts";
import type { ProfileId } from "../profiles/model.ts";
import { SubagentProfileService } from "../profiles/service.ts";
import type {
  SubagentContextMode,
  SubagentEffort,
  SubagentRunView,
  SubagentWriteIntent,
} from "../run/model.ts";
import { SubagentService } from "../run/service.ts";
import {
  decodeStartAwaitCardDetails,
  type CompactSubagentToolDetails,
  type SubagentStartAwaitCardDetails,
} from "./details.ts";
import { executeSubagentAction } from "./execute.ts";
import {
  renderSubagentCall,
  renderSubagentResult,
  syncAwaitProgressTicker,
  type SubagentToolRenderContext,
} from "./render.ts";

export {
  awaitResultBanner,
  renderAwaitProgressComponent,
  renderExpandedStartAwaitResult,
  renderStartAwaitOverviewComponent,
} from "./render.ts";
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

export const SUBAGENT_TOOL_NAMES = [
  "subagent_models",
  "subagent_start",
  "subagent_list",
  "subagent_status",
  "subagent_await",
  "subagent_send",
  "subagent_reply",
  "subagent_lifecycle",
  "subagent_rename",
] as const;

export interface SubagentStartFailure {
  readonly index: number;
  readonly name?: string;
  readonly message: string;
  /** Machine-actionable failure code (specific validation code or the error tag). */
  readonly code?: string;
}

export type SubagentStartOutcome =
  | {
      readonly index: number;
      readonly run: SubagentRunView;
    }
  | { readonly index: number; readonly failure: SubagentStartFailure };

export interface SubagentActionFailure {
  readonly id: string;
  readonly message: string;
  /** Machine-actionable failure code (specific validation code or the error tag). */
  readonly code?: string;
}

export interface ProfileCandidateDiscovery {
  readonly order: number;
  readonly candidate: string;
  readonly status: "eligible" | "skipped";
  readonly effectiveContext?: SubagentContextMode | undefined;
  readonly reason: string;
}

export interface SubagentProfileView {
  readonly id: ProfileId;
  readonly description: string;
  readonly defaultContext: "fresh" | "fork";
  readonly defaultWriteIntent: SubagentWriteIntent;
  readonly defaultEffort?: SubagentEffort | undefined;
  readonly candidates: ReadonlyArray<ProfileCandidateDiscovery>;
}

export type SubagentToolDetails = CompactSubagentToolDetails | SubagentStartAwaitCardDetails;

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
    name: "subagent_models",
    label: "Subagent Models",
    description:
      "Static preflight of complete version 4 profile candidates in declared order, including host, runtime, model, effort, context, write intent, closeOnReport, and implementation eligibility. All local and Herdr Pi/Claude/Codex adapters are implemented; runtime authentication, native integration, and private-harness readiness are checked at launch.",
    parameters: ModelsParameters,
    execute: (_id, input, signal, onUpdate, ctx) =>
      executeSubagentAction(pi, runtime, { ...input, action: "models" }, signal, onUpdate, ctx),
    renderCall: (args, theme) => renderSubagentCall("subagent_models", args.profile ?? "", theme),
    renderResult: sharedRenderResult,
  });

  const start = defineTool({
    name: "subagent_start",
    label: "Start Subagents",
    description:
      "Launch one to twelve session-scoped background subagents from one agents array using configured version 4 profile routes. Every task must be self-contained with relevant paths, constraints, evidence to inspect, and a concrete deliverable. Each item accepts only task, optional profile, and optional name. The selected profile supplies host, runtime, model, effort, context, write intent, and closeOnReport. Ordered readiness failures fall through only before spawn; post-ownership uncertainty never falls through. Successful launches remain active when a peer launch fails.",
    promptSnippet: "Launch delegated subagents using a task profile",
    promptGuidelines: [
      "Use subagent_start for delegated work that can proceed independently; make every task self-contained with relevant paths, constraints, evidence, and its expected deliverable. Start is always background and nonblocking; use subagent_await separately.",
      "Use subagent_start only for profile routing. Each agent item accepts task, optional profile, and optional name; the version 4 route exclusively supplies host, runtime, model, effort, context, write intent, and closeOnReport.",
      "Choose a profile by task: scout for local reconnaissance, researcher for sourced external research, planner for plans, worker for implementation, reviewer for independent review, oracle for inherited-decision analysis, and delegate for general work.",
      "Keep only one writer in the shared cwd, counting the main agent itself; do not edit while a writer subagent is active.",
      "Parallelize read-only research, inspection, and review; serialize writes unless isolated worktrees are introduced later.",
      "Use subagent_models only to inspect configured profile routing; never substitute a model or bypass a profile whose route has no eligible candidate.",
    ],
    parameters: StartParameters,
    prepareArguments: prepareSubagentStartArguments,
    execute: (_id, input, signal, onUpdate, ctx) =>
      executeSubagentAction(pi, runtime, { ...input, action: "start" }, signal, onUpdate, ctx),
    renderCall: (args, theme) =>
      renderSubagentCall(
        "subagent_start",
        args.agents
          .map((agent, index) => agent.name ?? `#${index + 1} ${agent.task.slice(0, 40)}`)
          .join(", "),
        theme,
      ),
    renderResult: sharedRenderResult,
  });

  const list = defineTool({
    name: "subagent_list",
    label: "List Subagents",
    description: "List every session-scoped subagent run in compact form.",
    parameters: ListParameters,
    execute: (_id, input, signal, onUpdate, ctx) =>
      executeSubagentAction(pi, runtime, { ...input, action: "list" }, signal, onUpdate, ctx),
    renderCall: (_args, theme) => renderSubagentCall("subagent_list", "", theme),
    renderResult: sharedRenderResult,
  });

  const status = defineTool({
    name: "subagent_status",
    label: "Subagent Status",
    description:
      "Inspect up to twelve specific subagent run IDs, including each run's capabilities.",
    parameters: StatusParameters,
    execute: (_id, input, signal, onUpdate, ctx) =>
      executeSubagentAction(pi, runtime, { ...input, action: "status" }, signal, onUpdate, ctx),
    renderCall: (args, theme) =>
      renderSubagentCall("subagent_status", args.runIds.join(", "), theme),
    renderResult: sharedRenderResult,
  });

  const awaitTool = defineTool({
    name: "subagent_await",
    label: "Await Subagents",
    description:
      "Wait for selected background subagents to finish with live progress. Returns early if a subagent needs a parent reply, then call it again after subagent_reply. A retained run in reported state counts as finished for its current assignment.",
    promptSnippet: "Wait for background subagents and collect their final reports",
    promptGuidelines: [
      "Do not poll subagent_status. After independent work, call subagent_await to collect results; if it returns for a parent question, use subagent_reply and then call subagent_await again. Use subagent_status only for troubleshooting or a user-requested snapshot.",
    ],
    parameters: AwaitParameters,
    execute: (_id, input, signal, onUpdate, ctx) =>
      executeSubagentAction(pi, runtime, { ...input, action: "await" }, signal, onUpdate, ctx),
    renderCall: (args, theme) =>
      renderSubagentCall("subagent_await", args.runIds.join(", "), theme),
    renderResult: sharedRenderResult,
  });

  const send = defineTool({
    name: "subagent_send",
    label: "Send Subagent Guidance",
    description:
      "Send the same guidance message to one or more running subagents. For a reported retained run, this begins its next assignment and report generation. Mixed-target calls report each success and failure.",
    parameters: SendParameters,
    execute: (_id, input, signal, onUpdate, ctx) =>
      executeSubagentAction(pi, runtime, { ...input, action: "send" }, signal, onUpdate, ctx),
    renderCall: (args, theme) => renderSubagentCall("subagent_send", args.runIds.join(", "), theme),
    renderResult: sharedRenderResult,
  });

  const reply = defineTool({
    name: "subagent_reply",
    label: "Reply to Subagent",
    description: "Answer a blocking parent question from one subagent.",
    parameters: ReplyParameters,
    execute: (_id, input, signal, onUpdate, ctx) =>
      executeSubagentAction(pi, runtime, { ...input, action: "reply" }, signal, onUpdate, ctx),
    renderCall: (args, theme) => renderSubagentCall("subagent_reply", args.runId, theme),
    renderResult: sharedRenderResult,
  });

  const lifecycle = defineTool({
    name: "subagent_lifecycle",
    label: "Subagent Lifecycle",
    description:
      "Interrupt, resume, or stop one or more subagents. Message is valid only for resume. Mixed-target calls report each success and failure.",
    parameters: LifecycleParameters,
    execute: (_id, input, signal, onUpdate, ctx) =>
      executeSubagentAction(pi, runtime, input, signal, onUpdate, ctx),
    renderCall: (args, theme) =>
      renderSubagentCall("subagent_lifecycle", `${args.action} ${args.runIds.join(", ")}`, theme),
    renderResult: sharedRenderResult,
  });

  const rename = defineTool({
    name: "subagent_rename",
    label: "Rename Subagent",
    description: "Change one subagent's local display name.",
    parameters: RenameParameters,
    execute: (_id, input, signal, onUpdate, ctx) =>
      executeSubagentAction(pi, runtime, { ...input, action: "rename" }, signal, onUpdate, ctx),
    renderCall: (args, theme) =>
      renderSubagentCall("subagent_rename", `${args.runId} → ${args.name}`, theme),
    renderResult: sharedRenderResult,
  });

  for (const tool of [models, start, list, status, awaitTool, send, reply, lifecycle, rename])
    pi.registerTool(withCodePreviewShell(tool));
}
