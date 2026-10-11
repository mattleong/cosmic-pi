import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as Predicate from "effect/Predicate";
import {
  clipText,
  invokeHostCallback,
  sanitizeDiagnosticContent,
  sanitizeTerminalLine,
} from "pi-cosmic-core";
import type { SubagentWorkflowMembership } from "../run/model.ts";

export interface SubagentCompletionNotification {
  readonly id: string;
  readonly name: string;
  readonly generation: number;
  readonly outcome: "completed" | "failed";
  readonly finalText?: string | undefined;
  readonly error?: string | undefined;
  readonly warning?: string | undefined;
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
      readonly workflow?: SubagentWorkflowMembership | undefined;
    };

export interface SubagentWorkflowNotification {
  readonly type: "workflow";
  readonly runId: string;
  readonly name: string;
  readonly outcome: "completed" | "failed" | "stopped" | "interrupted";
  readonly durationMs: number;
  readonly usage?: { readonly totalTokens: number; readonly cost?: number | undefined } | undefined;
  readonly content: string;
  readonly agents: {
    readonly total: number;
    readonly failed: number;
    readonly stopped: number;
    readonly skipped: number;
    readonly reused: number;
  };
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
    .filter(Predicate.isNotUndefined)
    .join("\n\n");
};

const completionHeading = (run: SubagentCompletionNotification): string =>
  run.outcome === "failed" ? `failed outcome ${run.generation}` : `report ${run.generation}`;

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
  const [single] = runs;
  if (runs.length === 1 && single !== undefined) {
    const prefix =
      single.outcome === "failed"
        ? `Background subagent ${single.name} (${single.id}) failed.`
        : `Background subagent ${single.name} (${single.id}) completed.`;
    const maximumBodyLength = Math.max(0, MAX_NOTIFICATION_CHARS - prefix.length - 2);
    const content = `${prefix}\n\n${boundedCompletion(single, completionBody(single), maximumBodyLength)}`;
    return [{ content: clip(content), runs: [single] }];
  }

  const chunks: CompletionChunk[] = [];
  let chunkRuns: SubagentCompletionNotification[] = [];
  let sections: string[] = [];
  const failed = runs.filter((run) => run.outcome === "failed").length;
  const completed = runs.length - failed;
  const headerFor = (chunkIndex: number): string => {
    const continuation = chunkIndex === 0 ? "" : ` (continued ${chunkIndex + 1})`;
    const outcomes = [
      completed > 0 ? `${completed} completed` : undefined,
      failed > 0 ? `${failed} failed` : undefined,
    ]
      .filter(Predicate.isNotUndefined)
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

  const room = () =>
    MAX_NOTIFICATION_CHARS -
    headerFor(chunks.length).length -
    2 -
    sections.join("\n\n").length -
    (sections.length > 0 ? 2 : 0);
  for (const run of runs) {
    const section = completionSection(run);
    if (sections.length > 0 && section.length > room()) flush();
    chunkRuns.push(run);
    sections.push(boundedCompletion(run, section, Math.max(0, room())));
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

const displayName = (name: string): string => clipText(sanitizeTerminalLine(name), 60);

export const workflowNotificationWakesAgent = (
  notification: SubagentWorkflowNotification,
): boolean => notification.outcome === "completed" || notification.outcome === "failed";

const steer = (
  pi: ExtensionAPI,
  message: Omit<Parameters<ExtensionAPI["sendMessage"]>[0], "display">,
  triggerTurn = true,
): boolean =>
  invokeHostCallback(() => {
    pi.sendMessage({ ...message, display: true }, { deliverAs: "steer", triggerTurn });
    return true;
  }, false);

const sendWorkflow = (
  pi: ExtensionAPI,
  notification: SubagentWorkflowNotification,
): SubagentNotificationDelivery => ({
  actionAccepted: steer(
    pi,
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
    },
    workflowNotificationWakesAgent(notification),
  ),
});

export function makeHostNotifier(pi: ExtensionAPI): SubagentNotifier {
  return (notification) => {
    if (notification.type === "workflow") return sendWorkflow(pi, notification);
    if (notification.type === "completed") {
      const deliveredCompletionKeys: string[] = [];
      for (const chunk of completionChunks(notification.runs)) {
        const accepted = steer(pi, {
          customType: "pi-subagents-completed",
          content: chunk.content,
          details: {
            version: 1,
            kind: "completed",
            total: chunk.runs.length,
            failed: chunk.runs.filter((run) => run.outcome === "failed").length,
            warnings: chunk.runs.filter((run) => Boolean(run.warning?.trim())).length,
            ...(chunk.runs.length === 1 &&
              chunk.runs[0] !== undefined && { name: displayName(chunk.runs[0].name) }),
          },
        });
        if (!accepted) break;
        for (const run of chunk.runs) deliveredCompletionKeys.push(`${run.id}:${run.generation}`);
      }
      return { deliveredCompletionKeys };
    }
    return {
      actionAccepted: steer(pi, {
        customType: "pi-subagents-question",
        details: { version: 1, kind: "question", name: displayName(notification.name) },
        content: clip(questionContent(notification)),
      }),
    };
  };
}
