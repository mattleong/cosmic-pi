/**
 * Pi's live working row, with separate live estimates and completed-call throughput.
 *
 * Plain presentation state under the effect-v4 synchronous-state exception: every Pi event changes
 * it in the call that observed it, and its only effect is a guarded `setWorkingMessage` write
 * through the bound session context. It repaints once a second from the shared host ticker pool.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as MutableRef from "effect/MutableRef";
import { formatElapsed, invokeHostCallback, synchronousMonotonicNow } from "pi-cosmic-core";
import { startHostUiTicker } from "../boundary/host-status.ts";
import { makeThroughputMeter, type ThroughputRate } from "./throughput.ts";

const WAITING_MESSAGE = "Waiting for you";

/** Only the current-call character estimate is approximate; completed samples use reported tokens. */
const formatWorkingMessage = (milliseconds: number, rate: ThroughputRate | undefined): string => {
  const message = `Working · ${formatElapsed(milliseconds)}`;
  if (!rate) return message;
  const value = rate.tokensPerSecond.toFixed(1);
  return `${message} · ${rate.kind === "live" ? "~" : ""}${value} tok/s`;
};

export interface WorkingRowOptions {
  readonly now?: () => number;
  readonly every?: (intervalMs: number, tick: () => void) => () => void;
}

export const makeWorkingRow = ({
  now = synchronousMonotonicNow,
  every = startHostUiTicker,
}: WorkingRowOptions = {}) => {
  let context: MutableRef.MutableRef<ExtensionContext> | undefined;
  let running = false;
  let prompting = false;
  /** Cleared when the host has no working row; a failed write stays writable and retries. */
  let writable = false;
  let halt: (() => void) | undefined;
  let workStartedAt: number | undefined;
  let workMilliseconds = 0;
  const throughput = makeThroughputMeter();

  const workAt = (at: number) =>
    workMilliseconds + (workStartedAt === undefined ? 0 : at - workStartedAt);
  const pauseWork = (at: number) => {
    workMilliseconds = workAt(at);
    workStartedAt = undefined;
  };
  const stopTicking = () => {
    halt?.();
    halt = undefined;
  };

  const write = (message?: string) =>
    invokeHostCallback<"written" | "unavailable" | "failed">(() => {
      const ctx = context && MutableRef.get(context);
      if (ctx?.mode !== "tui") return "unavailable";
      ctx.ui.setWorkingMessage(message);
      return "written";
    }, "failed");

  /** A failed write keeps a writable row ticking; an unavailable host stops the ticker. */
  const show = (message: string): boolean => {
    const result = write(message);
    writable = result === "written" || (result === "failed" && writable);
    if (writable) halt ??= every(1_000, tick);
    else stopTicking();
    return writable;
  };

  /** Presentation can pause, but prompts and missing UI never pause the provider's call clock. */
  const render = (at: number): void => {
    const message = prompting
      ? WAITING_MESSAGE
      : formatWorkingMessage(workAt(at), throughput.rate(at));
    if (!show(message)) pauseWork(at);
    else if (!prompting && workStartedAt === undefined) workStartedAt = at;
  };

  function tick(): void {
    if (!running || !writable) return stopTicking();
    render(now());
  }

  const agentEnd = (): void => {
    if (!running) return;
    running = false;
    prompting = false;
    writable = false;
    stopTicking();
    throughput.reset();
    write();
  };
  const canPrompt = () => running && !prompting;
  const isPrompting = () => running && prompting;

  return {
    /** Binds the session's live context; nothing is written until an agent run starts. */
    activate: (next: MutableRef.MutableRef<ExtensionContext>): void => {
      context = next;
    },
    /** Clears a running row through the bound context, stops ticking, and unbinds. */
    deactivate: (): void => {
      agentEnd();
      context = undefined;
    },
    /** Starts one run per agent; a duplicate start while running is ignored. */
    agentStart: (): void => {
      if (context === undefined || running) return;
      running = true;
      writable = true;
      workMilliseconds = 0;
      throughput.reset();
      const at = now();
      workStartedAt = at;
      render(at);
    },
    agentEnd,
    canPrompt,
    /** Freezes elapsed work and shows the waiting message; provider measurement continues. */
    promptStart: (): void => {
      if (!canPrompt()) return;
      const at = now();
      pauseWork(at);
      prompting = true;
      render(at);
    },
    isPrompting,
    /** Restores the elapsed time from before the prompt and resumes the work clock. */
    promptEnd: (): void => {
      if (!isPrompting()) return;
      prompting = false;
      const at = now();
      render(at);
    },
    /** Called only at the main agent's pre-provider context boundary. */
    callStart: (): void => {
      if (running) throughput.start(now());
    },
    output: (characters: number): void => {
      if (running) throughput.output(characters);
    },
    /** Only assistant completions close a call. Undefined usage discards that sample. */
    callEnd: (outputTokens: number | undefined): void => {
      if (!running) return;
      const at = now();
      throughput.finish(at, outputTokens);
      render(at);
    },
  };
};
