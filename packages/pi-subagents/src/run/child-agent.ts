import type { SubagentUsage } from "./model.ts";

export interface ChildRateLimitEvent {
  readonly type: "rate_limit";
  readonly status: "allowed" | "allowed_warning" | "rejected";
  readonly rateLimitType?: string | undefined;
  readonly resetsAt?: number | undefined;
  readonly utilization?: number | undefined;
  readonly overageStatus?: "allowed" | "allowed_warning" | "rejected" | undefined;
  readonly overageResetsAt?: number | undefined;
  readonly overageDisabledReason?: string | undefined;
  readonly isUsingOverage?: boolean | undefined;
}

/** Backend-neutral events published by child transports into the run owner. */
export type ChildAgentEvent =
  | {
      readonly type: "assistant";
      readonly text: string;
    }
  | {
      readonly type: "tool_started";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly args: unknown;
    }
  | {
      readonly type: "tool_finished";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly isError: boolean;
    }
  | ChildRateLimitEvent
  | {
      readonly type: "settled";
      readonly finalText?: string | undefined;
      readonly usage?: SubagentUsage | undefined;
    }
  | {
      readonly type: "failed";
      readonly message: string;
      readonly usage?: SubagentUsage | undefined;
      readonly fallbackMessage?: boolean | undefined;
    };
