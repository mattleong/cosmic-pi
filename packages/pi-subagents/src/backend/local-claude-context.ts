import type * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type { LocalClaudeDebugEntry } from "../boundary/local-claude-debug.ts";
import type { LocalCliProcessHandle } from "../boundary/local-cli-process.ts";
import type { LocalCliWireEvent } from "../boundary/local-cli-transport.ts";
import type { SupervisorChannelHandle } from "../boundary/supervisor-channel.ts";
import type { SubagentError } from "../run/errors.ts";
import type { makeClaudeResultCorrelation } from "./local-claude-correlation.ts";
import type { makeLocalClaudeInputDelivery } from "./local-claude-input-delivery.ts";
import type { ClaudeProtocolEvent } from "./local-claude-protocol.ts";
import type { makeLocalClaudeReportDelivery } from "./local-claude-report-delivery.ts";
import type { makeLocalClaudeUsage } from "./local-claude-usage.ts";
import type { LocalCliRawEventOwnership } from "./local-cli-events.ts";
import type { LocalCliInterrupt, makeLocalCliInterrupts } from "./local-cli-interruption.ts";
import type { BackendReport } from "./model.ts";

export type ClaudeUserProtocolEvent = Extract<ClaudeProtocolEvent, { readonly type: "user" }>;

export interface PendingInterrupt extends LocalCliInterrupt {
  readonly requestId: string;
  readonly response: Deferred.Deferred<unknown, SubagentError>;
  markerSeen: boolean;
  resultSeen: boolean;
}

export interface LocalClaudeHandleState {
  assignmentEpoch: number;
  nativeSessionId: string | undefined;
  lastOutboundAtMillis: number | undefined;
}

export interface LocalClaudeHandleContext {
  readonly state: LocalClaudeHandleState;
  readonly child: LocalCliProcessHandle;
  readonly supervisor: SupervisorChannelHandle;
  readonly offer: LocalCliRawEventOwnership["offer"];
  readonly release: LocalCliRawEventOwnership["release"];
  readonly correlation: ReturnType<typeof makeClaudeResultCorrelation>;
  readonly usage: ReturnType<typeof makeLocalClaudeUsage>;
  readonly reports: ReturnType<typeof makeLocalClaudeReportDelivery>;
  readonly interrupts: ReturnType<typeof makeLocalCliInterrupts<PendingInterrupt>>;
  readonly inputs: ReturnType<typeof makeLocalClaudeInputDelivery>;
  readonly recordDebug: (entry: LocalClaudeDebugEntry) => Effect.Effect<void>;
  readonly forwardAcceptedReport: (report: BackendReport) => Effect.Effect<void>;
  readonly toolNames: Map<string, string>;
  readonly nativeToolNames: Map<string, string>;
}

export const observeInterruptEvidence = (
  context: Pick<LocalClaudeHandleContext, "interrupts" | "release">,
  interrupt: PendingInterrupt,
  evidence: "markerSeen" | "resultSeen",
  raw: LocalCliWireEvent,
) =>
  Effect.suspend(() => {
    interrupt[evidence] = true;
    return interrupt.markerSeen && interrupt.resultSeen
      ? context.interrupts.complete(interrupt, raw)
      : context.release(raw);
  });
