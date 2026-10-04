import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { sanitizeDiagnosticContent, sanitizeTerminalLine, clipText } from "pi-cosmic-core";
import type { SubagentWorkflowMembership } from "../run/model.ts";

export interface SubagentCompletionNotification {
  readonly id: string;
  readonly name: string;
  readonly generation: number;
  readonly outcome: "completed" | "failed";
  readonly finalText?: string | undefined;
  readonly error?: string | undefined;
  readonly warning?: string | undefined;
  readonly retained?: boolean | undefined;
  readonly retryAvailable?: boolean | undefined;
  readonly profile?: string | undefined;
  readonly remainingCandidateCount?: number | undefined;
}

export type SubagentNotification =
  | {
      readonly type: "completed";
      readonly runs: ReadonlyArray<SubagentCompletionNotification>;
    }
  | {
      readonly type: "question";
      readonly id: string;
      readonly name: string;
      readonly requestId: string;
      readonly message: string;
      readonly generation: number;
      /** A workflow agent's question; the workflow keeps waiting until the reply arrives. */
      readonly workflow?: SubagentWorkflowMembership | undefined;
    };

/**
 * One finished workflow run; `content` carries its result or failure for the main agent. A run
 * the user stopped, or one an earlier activation left running at teardown (`interrupted`),
 * informs the next turn instead of starting one.
 */
export interface SubagentWorkflowNotification {
  readonly type: "workflow";
  readonly runId: string;
  readonly name: string;
  readonly outcome: "completed" | "failed" | "stopped" | "interrupted";
  readonly durationMs: number;
  /**
   * Tokens the run's live agents used, and their cost when every one reported it; reused results
   * cost nothing. Unknown for an interrupted run.
   */
  readonly usage?: { readonly totalTokens: number; readonly cost?: number | undefined } | undefined;
  readonly content: string;
  readonly agents: {
    readonly total: number;
    readonly failed: number;
    readonly stopped: number;
    readonly skipped: number;
    readonly reused: number;
  };
  /** Worktree proposals the main agent reviews with subagent_workspace. */
  readonly workspaces: ReadonlyArray<string>;
}

export interface SubagentNotificationDelivery {
  readonly deliveredCompletionKeys?: ReadonlyArray<string> | undefined;
  readonly actionAccepted?: boolean | undefined;
}

export type SubagentNotifier = (
  notification: SubagentNotification | SubagentWorkflowNotification,
) => SubagentNotificationDelivery | undefined;

const MAX_NOTIFICATION_CHARS = 32 * 1024;

/**
 * The secret redaction and control-character cleanup every notification's content gets before
 * the host clips it. Producers that budget their content apply it first, so redaction can't push
 * budgeted text past the clip; applying it again changes nothing.
 */
export const sanitizeNotificationContent = (
  value: string,
  maximumLength = Number.POSITIVE_INFINITY,
): string => sanitizeDiagnosticContent(value, { maximumLength }).trim();

const clip = (value: string, maximumLength = MAX_NOTIFICATION_CHARS): string =>
  clipText(sanitizeNotificationContent(value, maximumLength + 2), maximumLength);

interface CompletionChunk {
  readonly content: string;
  readonly runs: ReadonlyArray<SubagentCompletionNotification>;
}

// Worker errors often carry their own class prefix; a second "Error:" label adds nothing.
const ERROR_LABELLED = /^(?:[A-Z][A-Za-z]*)?Error\b/u;

const failureText = (error: string | undefined): string => {
  const text = error?.trim();
  if (!text) return "Error: Run failed without an error report.";
  return ERROR_LABELLED.test(text) ? text : `Error: ${text}`;
};

const completionBody = (run: SubagentCompletionNotification): string => {
  const warning = run.warning?.trim();
  const primary =
    run.outcome === "failed"
      ? failureText(run.error)
      : run.finalText?.trim() || "Completed without a final report.";
  const retry = run.retryAvailable
    ? `Next: ${run.remainingCandidateCount ?? 1} configured ${run.profile ?? "profile"} candidate${(run.remainingCandidateCount ?? 1) === 1 ? " remains" : "s remain"}. Continue this exact task with subagent_lifecycle({ action: "retry", runIds: ["${run.id}"] }) before launching any generalist replacement.`
    : undefined;
  return [
    primary,
    warning && warning !== run.error?.trim() ? `Warning: ${warning}` : undefined,
    retry,
  ]
    .filter((value): value is string => value !== undefined)
    .join("\n\n");
};

const completionHeading = (run: SubagentCompletionNotification): string =>
  run.outcome === "failed"
    ? `failed outcome ${run.generation}`
    : `report ${run.generation}${run.retained ? " · retained" : ""}`;

const completionSection = (run: SubagentCompletionNotification): string =>
  `## ${run.name} (${run.id}) · ${completionHeading(run)}\n\n${completionBody(run)}`;

const boundedCompletion = (
  run: SubagentCompletionNotification,
  text: string,
  maximumLength: number,
): string => {
  if (text.length <= maximumLength) return clip(text, maximumLength);
  const noun = run.outcome === "failed" ? "Outcome" : "Report";
  const marker = `\n\n[${noun} truncated; use subagent_status or subagent_await for ${run.id}.]`;
  return `${clip(text, Math.max(0, maximumLength - marker.length))}${marker}`;
};

const completionChunks = (
  runs: ReadonlyArray<SubagentCompletionNotification>,
): ReadonlyArray<CompletionChunk> => {
  if (runs.length === 1) {
    const run = runs[0]!;
    const prefix =
      run.outcome === "failed"
        ? `Background subagent ${run.name} (${run.id}) failed.`
        : run.retained
          ? `Background subagent ${run.name} (${run.id}) reported generation ${run.generation} and remains available for guidance.`
          : `Background subagent ${run.name} (${run.id}) completed.`;
    const maximumBodyLength = Math.max(0, MAX_NOTIFICATION_CHARS - prefix.length - 2);
    const content = `${prefix}\n\n${boundedCompletion(run, completionBody(run), maximumBodyLength)}`;
    return [{ content: clip(content), runs: [run] }];
  }

  const chunks: CompletionChunk[] = [];
  let chunkRuns: SubagentCompletionNotification[] = [];
  let sections: string[] = [];
  const failed = runs.filter((run) => run.outcome === "failed").length;
  const retained = runs.filter((run) => run.outcome !== "failed" && run.retained).length;
  const closed = runs.length - retained - failed;
  const headerFor = (chunkIndex: number): string => {
    const continuation = chunkIndex === 0 ? "" : ` (continued ${chunkIndex + 1})`;
    const outcomes = [
      closed > 0 ? `${closed} completed` : undefined,
      failed > 0 ? `${failed} failed` : undefined,
      retained > 0 ? `${retained} reported and retained` : undefined,
    ]
      .filter((value): value is string => value !== undefined)
      .join(" · ");
    return `${runs.length} background subagents finished${continuation} · ${outcomes}.`;
  };
  const flush = () => {
    if (chunkRuns.length === 0) return;
    const header = headerFor(chunks.length);
    chunks.push({ content: `${header}\n\n${sections.join("\n\n")}`, runs: chunkRuns });
    chunkRuns = [];
    sections = [];
  };

  for (const run of runs) {
    let header = headerFor(chunks.length);
    const unboundedSection = completionSection(run);
    const occupied = header.length + 2 + sections.join("\n\n").length;
    const separator = sections.length > 0 ? 2 : 0;
    if (
      sections.length > 0 &&
      occupied + separator + unboundedSection.length > MAX_NOTIFICATION_CHARS
    ) {
      flush();
      header = headerFor(chunks.length);
    }
    const currentSectionsLength = sections.join("\n\n").length;
    const maximumSectionLength = Math.max(
      0,
      MAX_NOTIFICATION_CHARS -
        header.length -
        2 -
        currentSectionsLength -
        (sections.length ? 2 : 0),
    );
    chunkRuns.push(run);
    sections.push(boundedCompletion(run, unboundedSection, maximumSectionLength));
  }
  flush();
  return chunks;
};

const questionContent = (
  notification: Extract<SubagentNotification, { readonly type: "question" }>,
): string => {
  const reply = `subagent_reply({ runId: "${notification.id}", message: "..." })`;
  const workflow = notification.workflow;
  if (!workflow)
    return `Subagent ${notification.name} (${notification.id}) is waiting for a parent reply.\n\nQuestion: ${notification.message}\n\nReply with ${reply}, then call subagent_await again.`;
  const label = workflow.name ? `${workflow.name} (${workflow.workflowId})` : workflow.workflowId;
  return `Workflow ${label} agent ${notification.name} (${notification.id}) is waiting for a parent reply.\n\nQuestion: ${notification.message}\n\nReply with ${reply}; the workflow continues automatically after the reply.`;
};

/** A display name for compact rows, bounded like the transcript's other one-line labels. */
const displayName = (name: string): string => clipText(sanitizeTerminalLine(name), 60);

/**
 * Whether a workflow notification joins the agent run under way or starts one. A run the user
 * stopped, or one torn down before it finished, informs the next turn instead of prompting work.
 */
export const workflowNotificationWakesAgent = (
  notification: SubagentWorkflowNotification,
): boolean => notification.outcome === "completed" || notification.outcome === "failed";

const sendWorkflow = (
  pi: ExtensionAPI,
  notification: SubagentWorkflowNotification,
): SubagentNotificationDelivery => {
  try {
    pi.sendMessage(
      {
        customType: "pi-subagents-workflow",
        content: clip(notification.content),
        details: {
          version: 1,
          kind: "workflow",
          name: displayName(notification.name),
          outcome: notification.outcome,
          durationMs: Math.max(0, Math.round(notification.durationMs)),
          ...(notification.usage !== undefined && {
            totalTokens: Math.max(0, Math.round(notification.usage.totalTokens)),
          }),
          ...(notification.usage?.cost !== undefined && {
            cost: Math.max(0, notification.usage.cost),
          }),
          agents: notification.agents.total,
          failed: notification.agents.failed,
          stopped: notification.agents.stopped,
          skipped: notification.agents.skipped,
          reused: notification.agents.reused,
        },
        display: true,
      },
      // A result joins an active turn or wakes an idle parent, like completions.
      { deliverAs: "steer", triggerTurn: workflowNotificationWakesAgent(notification) },
    );
    return { actionAccepted: true };
  } catch {
    // A replaced or closing session leaves the result for the workflow service to retry.
    return { actionAccepted: false };
  }
};

export function makeHostNotifier(pi: ExtensionAPI): SubagentNotifier {
  return (notification) => {
    if (notification.type === "workflow") return sendWorkflow(pi, notification);
    if (notification.type === "completed") {
      const deliveredCompletionKeys: string[] = [];
      for (const chunk of completionChunks(notification.runs)) {
        try {
          pi.sendMessage(
            {
              customType: "pi-subagents-completed",
              content: chunk.content,
              details: {
                version: 1,
                kind: "completed",
                total: chunk.runs.length,
                failed: chunk.runs.filter((run) => run.outcome === "failed").length,
                warnings: chunk.runs.filter((run) => Boolean(run.warning?.trim())).length,
                ...(chunk.runs.length === 1 && { name: displayName(chunk.runs[0]!.name) }),
              },
              display: true,
            },
            // Terminal outcomes intentionally join an active orchestration run or wake an idle
            // parent. Host acceptance is synchronous; model consumption may occur later.
            { deliverAs: "steer", triggerTurn: true },
          );
          for (const run of chunk.runs) deliveredCompletionKeys.push(`${run.id}:${run.generation}`);
        } catch {
          // Host acceptance may have happened before a throw. Leave this chunk and later chunks
          // unacknowledged so the service owns the uncertain retry.
          break;
        }
      }
      return { deliveredCompletionKeys };
    }

    const content = clip(questionContent(notification));
    try {
      pi.sendMessage(
        {
          customType: "pi-subagents-question",
          details: { version: 1, kind: "question", name: displayName(notification.name) },
          content,
          display: true,
        },
        { deliverAs: "steer", triggerTurn: true },
      );
      return { actionAccepted: true };
    } catch {
      // Session shutdown can race with an actionable notification. The service retains it.
      return { actionAccepted: false };
    }
  };
}
