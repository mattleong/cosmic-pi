import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { processError, type SubagentProcessError } from "../run/errors.ts";
import type {
  ClaudeInputTerminationReason,
  PendingUserReplay,
} from "./local-claude-input-delivery.ts";
import type { ClaudeProtocolEvent } from "./local-claude-protocol.ts";

export interface ClaudeInputFailureSnapshot {
  readonly operation: PendingUserReplay["operation"];
  /** Elapsed delivery ownership; not proof of when the native write completed. */
  readonly waitElapsedMillis: number;
  readonly lastInbound: ClaudeProtocolEvent["type"] | "protocol-error" | "exit" | "none";
  readonly lastInboundAgeMillis: number | null;
  readonly activeToolCategory:
    | "none"
    | "shell"
    | "file"
    | "native-agent"
    | "supervisor"
    | "other"
    | "mixed";
  readonly activeToolCount: number;
  readonly cliVersion: string | null;
  readonly terminationReason: ClaudeInputTerminationReason;
}

const boundedMillis = (value: number) => Math.max(0, Math.min(86_400_000, Math.floor(value)));
const toolCategory = (name: string): ClaudeInputFailureSnapshot["activeToolCategory"] => {
  if (name === "Bash") return "shell";
  if (["Edit", "Write", "Read", "NotebookEdit", "Glob", "Grep"].includes(name)) return "file";
  if (["Agent", "Task", "TaskOutput", "TaskStop", "SendMessage"].includes(name))
    return "native-agent";
  if (name.startsWith("mcp__pi_subagents_supervisor__")) return "supervisor";
  return "other";
};

/** Metadata-only failure evidence. Never stores a raw frame, input, ID, path, or digest. */
export const makeLocalClaudeDiagnostics = (activeTools: () => Iterable<string>) => {
  let lastInbound: ClaudeInputFailureSnapshot["lastInbound"] = "none";
  let lastInboundAt: number | undefined;
  let cliVersion: string | null = null;
  const observe = (category: ClaudeInputFailureSnapshot["lastInbound"], version?: string) =>
    Clock.currentTimeMillis.pipe(
      Effect.map((now) => {
        lastInbound = category;
        lastInboundAt = now;
        // Retain only an ordinary numeric release version, not arbitrary foreign text.
        if (version !== undefined && /^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(version))
          cliVersion = version;
      }),
    );
  const snapshot = (input: PendingUserReplay, terminationReason: ClaudeInputTerminationReason) =>
    Clock.currentTimeMillis.pipe(
      Effect.map((now): ClaudeInputFailureSnapshot => {
        const categories = new Set<ClaudeInputFailureSnapshot["activeToolCategory"]>();
        let count = 0;
        for (const name of activeTools()) {
          categories.add(toolCategory(name));
          count = Math.min(512, count + 1);
        }
        return {
          operation: input.operation,
          waitElapsedMillis: boundedMillis(now - (input.ownedAtMillis ?? now)),
          lastInbound,
          lastInboundAgeMillis:
            lastInboundAt === undefined ? null : boundedMillis(now - lastInboundAt),
          activeToolCategory:
            categories.size > 1 ? "mixed" : (categories.values().next().value ?? "none"),
          activeToolCount: count,
          cliVersion,
          terminationReason,
        };
      }),
    );
  return {
    observe,
    snapshot,
    diagnose: (
      input: PendingUserReplay,
      error: SubagentProcessError,
      reason: ClaudeInputTerminationReason,
    ) =>
      snapshot(input, reason).pipe(
        Effect.map((evidence) =>
          processError(
            error.operation,
            error.code ?? "input_outcome_uncertain",
            `${error.message} Metadata: ${JSON.stringify(evidence)}`,
          ),
        ),
      ),
  };
};
