/**
 * Pi's live working row, for example `Working · 2m 14s · ~18.4 tok/s`.
 *
 * Plain presentation state under the effect-v4 synchronous-state exception: every Pi event changes
 * it in the call that observed it, and its only effect is a guarded `setWorkingMessage` write
 * through the bound session context. It repaints once a second from the shared host ticker pool.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as MutableRef from "effect/MutableRef";
import { formatElapsed, synchronousNow } from "pi-cosmic-core";
import type { HostCallbackBoundaryContract } from "../boundary/host-callback.ts";
import { startHostUiTicker } from "../boundary/host-status.ts";

const WAITING_MESSAGE = "Waiting for you";

/** The rate uses Pi's four-characters-per-token heuristic over the output clock. */
const formatWorkingMessage = (
  milliseconds: number,
  outputCharacters: number,
  outputMilliseconds: number,
): string => {
  const message = `Working · ${formatElapsed(milliseconds)}`;
  if (outputCharacters <= 0 || outputMilliseconds < 1_000) return message;
  return `${message} · ~${(outputCharacters / 4 / (outputMilliseconds / 1_000)).toFixed(1)} tok/s`;
};

interface WorkingRowOptions {
  readonly callbacks: HostCallbackBoundaryContract;
  readonly now?: () => number;
  readonly every?: (intervalMs: number, tick: () => void) => () => void;
}

export const makeWorkingRow = ({
  callbacks,
  now = synchronousNow,
  every = startHostUiTicker,
}: WorkingRowOptions) => {
  let context: MutableRef.MutableRef<ExtensionContext> | undefined;
  let running = false;
  let prompting = false;
  /** Cleared when the host has no working row; a failed write stays writable and retries. */
  let writable = false;
  let halt: (() => void) | undefined;
  let workStartedAt: number | undefined;
  let workMilliseconds = 0;
  let outputStartedAt: number | undefined;
  let outputMilliseconds = 0;
  let outputCharacters = 0;

  const workAt = (at: number) =>
    workMilliseconds + (workStartedAt === undefined ? 0 : at - workStartedAt);
  const outputAt = (at: number) =>
    outputMilliseconds + (outputStartedAt === undefined ? 0 : at - outputStartedAt);
  const pauseOutput = (at: number) => {
    outputMilliseconds = outputAt(at);
    outputStartedAt = undefined;
  };
  const pauseClocks = (at: number) => {
    workMilliseconds = workAt(at);
    workStartedAt = undefined;
    pauseOutput(at);
  };
  const stopTicking = () => {
    halt?.();
    halt = undefined;
  };

  const write = (message?: string) =>
    callbacks.invoke<"written" | "unavailable" | "failed">(
      "working-message",
      () => {
        const ctx = context && MutableRef.get(context);
        if (ctx?.mode !== "tui") return "unavailable";
        ctx.ui.setWorkingMessage(message);
        return "written";
      },
      "failed",
    );

  /** A failed write keeps a writable row ticking; an unavailable host stops the ticker. */
  const show = (message: string): boolean => {
    const result = write(message);
    writable = result === "written" || (result === "failed" && writable);
    if (writable) halt ??= every(1_000, tick);
    else stopTicking();
    return writable;
  };

  /** Writes the row as of `at`; when the host has no row, both clocks freeze there. */
  const render = (at: number): void => {
    const message = prompting
      ? WAITING_MESSAGE
      : formatWorkingMessage(workAt(at), outputCharacters, outputAt(at));
    if (!show(message)) pauseClocks(at);
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
      outputStartedAt = undefined;
      outputMilliseconds = 0;
      outputCharacters = 0;
      const at = now();
      workStartedAt = at;
      render(at);
    },
    agentEnd,
    canPrompt,
    /** Freezes both clocks and shows the waiting message; output is dropped until the prompt ends. */
    promptStart: (): void => {
      if (!canPrompt()) return;
      const at = now();
      pauseClocks(at);
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
      if (writable) workStartedAt = at;
    },
    output: (characters: number): void => {
      const increment = Math.max(0, Math.floor(characters));
      if (increment === 0 || !running || prompting || !writable) return;
      outputStartedAt ??= now();
      outputCharacters += increment;
    },
    /** Tool execution and message end pause the output-rate clock, not the elapsed time. */
    pauseOutput: (): void => {
      if (outputStartedAt !== undefined) pauseOutput(now());
    },
  };
};
