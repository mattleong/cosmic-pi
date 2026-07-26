import type { SubagentUsage } from "./model.ts";

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
  | {
      readonly type: "settled";
      readonly finalText?: string | undefined;
      readonly usage?: SubagentUsage | undefined;
    }
  | {
      readonly type: "failed";
      readonly message: string;
      readonly usage?: SubagentUsage | undefined;
    };
