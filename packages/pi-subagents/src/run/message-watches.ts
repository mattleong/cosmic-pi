import * as Arr from "effect/Array";
import { safeTextPrefix } from "pi-cosmic-core/text";
import { MAX_OUTCOME_PREVIEW_CHARS, MAX_TARGET_RUNS } from "./limits.ts";

/** An agent message delivered to an agent while it waits, as its wait reports it. */
export interface AgentMessageArrival {
  /** The sender's run ID or `main`. */
  readonly from: string;
  readonly fromName: string;
  /** The message's start, enough for a preview; the recipient receives the whole message itself. */
  readonly text: string;
  /** The message is longer than `text`. */
  readonly truncated: boolean;
}

/** The agent messages delivered to a waiting agent since its wait began. */
export interface AgentMessageArrivals {
  readonly count: number;
  /** The first of them, up to `MAX_TARGET_RUNS`. */
  readonly arrivals: ReadonlyArray<AgentMessageArrival>;
}

/** One wait's watch on the agent messages delivered to its caller. */
export interface AgentMessageWatch {
  readonly arrivals: () => AgentMessageArrivals;
  /** Ends the watch; under the run lock. */
  readonly closeLocked: () => void;
}

/** The distinct senders of `arrivals`, in arrival order. */
export const agentMessageSenders = (
  arrivals: AgentMessageArrivals,
): ReadonlyArray<{ readonly id: string; readonly name: string }> => {
  const senders = new Map<string, string>();
  for (const { from, fromName } of arrivals.arrivals)
    if (!senders.has(from)) senders.set(from, fromName);
  return Arr.map([...senders], ([id, name]) => ({ id, name }));
};

/** Enough of a message for a preview after sanitizing, which may shorten it. */
const MAX_ARRIVAL_TEXT_CHARS = 4 * MAX_OUTCOME_PREVIEW_CHARS;

export const NO_AGENT_MESSAGE_ARRIVALS: AgentMessageArrivals = Object.freeze({
  count: 0,
  arrivals: Object.freeze([]),
});

interface Watch {
  readonly recipient: string;
  arrived: AgentMessageArrivals;
}

/**
 * Agent messages delivered to agents waiting in `agent_await`. A wait starts its watch in the
 * locked step that claims its completions, and a delivery records itself under the same lock once
 * delivered, so each message either preceded the wait or is in its watch. Arrivals are kept only
 * by waits, and only while they wait.
 */
export function agentMessageWatches() {
  const watches = new Set<Watch>();
  return {
    /** Starts watching messages to `recipient`, a run ID or `main`; under the run lock. */
    watchLocked: (recipient: string): AgentMessageWatch => {
      const watch: Watch = { recipient, arrived: NO_AGENT_MESSAGE_ARRIVALS };
      watches.add(watch);
      return {
        arrivals: () => watch.arrived,
        closeLocked: () => {
          watches.delete(watch);
        },
      };
    },
    /**
     * Records a message delivered to `to` in every wait watching it; under the run lock. True when
     * some wait watches it, so the caller publishes to wake that wait.
     */
    recordLocked: (to: string, from: string, fromName: string, text: string): boolean => {
      let watched = false;
      for (const watch of watches) {
        if (watch.recipient !== to) continue;
        watched = true;
        const { count, arrivals } = watch.arrived;
        watch.arrived = Object.freeze({
          count: count + 1,
          arrivals:
            arrivals.length < MAX_TARGET_RUNS
              ? Object.freeze([
                  ...arrivals,
                  Object.freeze({
                    from,
                    fromName,
                    text: safeTextPrefix(text, MAX_ARRIVAL_TEXT_CHARS),
                    truncated: text.length > MAX_ARRIVAL_TEXT_CHARS,
                  }),
                ])
              : arrivals,
        });
      }
      return watched;
    },
  };
}

export type AgentMessageWatches = ReturnType<typeof agentMessageWatches>;
