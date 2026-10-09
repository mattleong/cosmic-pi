/** Synchronous, run-local measurement state owned by the working row. No clocks or host I/O. */
export interface ThroughputRate {
  readonly kind: "live" | "completed";
  readonly tokensPerSecond: number;
}

const rate = (tokens: number, milliseconds: number): number | undefined => {
  if (tokens <= 0 || milliseconds <= 0) return undefined;
  const value = tokens / (milliseconds / 1_000);
  return Number.isFinite(value) ? value : undefined;
};

export const makeThroughputMeter = () => {
  let current: { startedAt: number; characters: number } | undefined;
  let completedTokens = 0;
  let completedMilliseconds = 0;

  return {
    reset(): void {
      current = undefined;
      completedTokens = 0;
      completedMilliseconds = 0;
    },
    /** The main-agent context boundary precedes provider work, including hidden reasoning. */
    start(at: number): void {
      current = { startedAt: at, characters: 0 };
    },
    output(characters: number): void {
      if (current && Number.isSafeInteger(characters) && characters > 0)
        current.characters += characters;
    },
    /** Missing, failed, zero-usage or unmatched completions contribute neither tokens nor time. */
    finish(at: number, outputTokens: number | undefined): void {
      const call = current;
      current = undefined;
      if (!call || outputTokens === undefined || !Number.isSafeInteger(outputTokens)) return;
      const milliseconds = at - call.startedAt;
      const tokens = completedTokens + outputTokens;
      const duration = completedMilliseconds + milliseconds;
      if (
        outputTokens <= 0 ||
        milliseconds <= 0 ||
        !Number.isSafeInteger(tokens) ||
        !Number.isFinite(duration) ||
        rate(tokens, duration) === undefined
      )
        return;
      completedTokens = tokens;
      completedMilliseconds = duration;
    },
    /** Live estimates never enter the completed-call weighted average. */
    rate(at: number): ThroughputRate | undefined {
      if (current && at - current.startedAt >= 1_000) {
        const live = rate(current.characters / 4, at - current.startedAt);
        if (live !== undefined) return { kind: "live", tokensPerSecond: live };
      }
      const completed = rate(completedTokens, completedMilliseconds);
      return completed === undefined
        ? undefined
        : { kind: "completed", tokensPerSecond: completed };
    },
  };
};
