import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as MutableRef from "effect/MutableRef";
import { formatElapsed } from "pi-cosmic-core/display";
import { invokeHostCallback } from "pi-cosmic-core/host-session";
import { synchronousMonotonicNow } from "pi-cosmic-core/platform/native-clock";
import { startHostUiTicker } from "../boundary/host-status.ts";
import { createThroughputMeter, type ThroughputRate } from "./throughput.ts";

const WAITING_MESSAGE = "Waiting for you";

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

export const createWorkingRow = ({
  now = synchronousMonotonicNow,
  every = startHostUiTicker,
}: WorkingRowOptions = {}) => {
  let context: MutableRef.MutableRef<ExtensionContext> | undefined;
  let running = false;
  let prompting = false;
  let writable = false;
  let halt: (() => void) | undefined;
  let workStartedAt: number | undefined;
  let workMilliseconds = 0;
  const throughput = createThroughputMeter();

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

  const show = (message: string): boolean => {
    const result = write(message);
    writable = result === "written" || (result === "failed" && writable);
    if (writable) halt ??= every(1_000, tick);
    else stopTicking();
    return writable;
  };

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
    activate: (next: MutableRef.MutableRef<ExtensionContext>): void => {
      context = next;
    },
    deactivate: (): void => {
      agentEnd();
      context = undefined;
    },
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
    promptStart: (): void => {
      if (!canPrompt()) return;
      const at = now();
      pauseWork(at);
      prompting = true;
      render(at);
    },
    isPrompting,
    promptEnd: (): void => {
      if (!isPrompting()) return;
      prompting = false;
      const at = now();
      render(at);
    },
    callStart: (): void => {
      if (running) throughput.start(now());
    },
    output: (characters: number): void => {
      if (running) throughput.output(characters);
    },
    callEnd: (outputTokens: number | undefined): void => {
      if (!running) return;
      const at = now();
      throughput.finish(at, outputTokens);
      render(at);
    },
  };
};
