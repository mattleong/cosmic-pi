import type {
  AgentMainCapabilities,
  AgentMainDelivery,
  AgentMainState,
  AgentMessageFrame,
} from "../../../src/run/agent-messaging.ts";

export interface FakeAgentMainControl {
  state: AgentMainState;
  text: string;
  truncated: boolean;
  /** Holds wakes, as after the user interrupts a run. */
  held: boolean;
  /** The session retired, so the host refuses delivery. */
  retired: boolean;
  /** A busy session's run will continue for a message already admitted at its settle boundary. */
  continuing: boolean;
}

/**
 * A main agent double following the shared session wake: idle sessions wake, busy ones queue for a
 * continuation, and held messages only append.
 */
export function fakeAgentMain(
  initial: {
    readonly state?: AgentMainState;
    readonly text?: string;
  } = {},
) {
  const delivered: Array<{ readonly frame: AgentMessageFrame; readonly startTurn: boolean }> = [];
  const control: FakeAgentMainControl = {
    state: initial.state ?? "idle",
    text: initial.text ?? "",
    truncated: false,
    held: false,
    retired: false,
    continuing: false,
  };
  const capabilities: AgentMainCapabilities = {
    deliver: (frame): AgentMainDelivery => {
      if (control.retired) return "unavailable";
      const idle = control.state === "idle";
      delivered.push({ frame, startTurn: !control.held && idle });
      if (control.held) return "held";
      if (idle) return "woken";
      control.continuing = true;
      return "queued";
    },
    read: () => ({ text: control.text, truncated: control.truncated, state: control.state }),
  };
  return { capabilities, control, delivered };
}
