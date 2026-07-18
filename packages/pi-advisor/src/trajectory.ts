const MAX_PENDING_CHARS = 600;
const MIN_SEGMENT_CHARS = 80;
const RECENT_SEGMENT_LIMIT = 8;
const SIMILARITY_THRESHOLD = 0.86;
const REPEATED_SEGMENT_THRESHOLD = 4;
const TAIL_LIMIT = 320;
const MIN_REPEATED_TAIL_CHARS = 160;
const MAX_TOOL_HISTORY = 32;
const MAX_TOOL_FINGERPRINT_INPUT_CHARS = 2_000;
const REPEATED_TOOL_THRESHOLD = 3;
const OSCILLATION_WINDOW = 6;

export const LONG_TURN_REVIEW_MS = 90_000;
export const MIN_LOOP_REVIEW_MS = 15_000;
export const MAX_TRAJECTORY_EVIDENCE_CHARS = 6_000;

export type TrajectoryChannel = "thinking" | "text";

export interface TrajectorySignal {
  channel: TrajectoryChannel;
  reason: string;
}

export type ToolLoopKind =
  | "identical-call-result"
  | "repeated-error"
  | "repeated-inspection"
  | "oscillation";

export interface ToolTrajectorySignal {
  kind: ToolLoopKind;
  parentTurnId: number;
  confidence: "strong";
  reason: string;
  evidence: string;
  abortSafe: boolean;
}

export interface ToolTrajectoryEndInput {
  parentTurnId: number;
  toolCallId: string;
  toolName: string;
  args: unknown;
  result: unknown;
  isError: boolean;
}

/**
 * Detects strong repetition in streamed reasoning or prose. The detector is
 * intentionally conservative: it requires either a long verbatim suffix or a
 * cluster of several highly similar substantial segments.
 */
export class AdvisorTrajectoryDetector {
  readonly #states = new Map<TrajectoryChannel, ChannelState>();

  push(channel: TrajectoryChannel, delta: string): TrajectorySignal | undefined {
    if (!delta) return undefined;
    const state = this.#states.get(channel) ?? createChannelState();
    this.#states.set(channel, state);

    state.tail = `${state.tail}${delta}`.slice(-TAIL_LIMIT);
    const repeatedUnit = repeatedTailUnit(state.tail);
    if (repeatedUnit) {
      return {
        channel,
        reason: `repeated the same ${repeatedUnit.length}-character sequence several times`,
      };
    }

    state.pending += delta;
    while (state.pending.length > 0) {
      const boundary = /\n\s*\n/.exec(state.pending);
      let segment: string | undefined;
      if (boundary) {
        segment = state.pending.slice(0, boundary.index);
        state.pending = state.pending.slice(boundary.index + boundary[0].length);
      } else if (state.pending.length >= MAX_PENDING_CHARS) {
        segment = state.pending.slice(0, MAX_PENDING_CHARS);
        state.pending = state.pending.slice(MAX_PENDING_CHARS);
      }
      if (segment === undefined) break;

      const normalized = normalizeSegment(segment);
      if (normalized.length < MIN_SEGMENT_CHARS) continue;
      const words = wordSet(normalized);
      const similar = state.recent.some(
        (previous) => jaccardSimilarity(previous, words) >= SIMILARITY_THRESHOLD,
      );
      state.similarRun = similar ? state.similarRun + 1 : 0;
      state.recent.push(words);
      if (state.recent.length > RECENT_SEGMENT_LIMIT) state.recent.shift();
      if (state.similarRun >= REPEATED_SEGMENT_THRESHOLD - 1) {
        return {
          channel,
          reason: `produced ${REPEATED_SEGMENT_THRESHOLD} near-duplicate substantial segments`,
        };
      }
    }
    return undefined;
  }

  reset(): void {
    this.#states.clear();
  }
}

/** Bounded detector for main-agent tool trajectories. */
export class AdvisorToolTrajectoryDetector {
  private readonly active = new Set<string>();
  private history: ToolEventFingerprint[] = [];
  private loopDetected = false;

  get activeToolCount(): number {
    return this.active.size;
  }

  start(toolCallId: string): void {
    this.active.add(toolCallId);
  }

  end(input: ToolTrajectoryEndInput): ToolTrajectorySignal | undefined {
    this.active.delete(input.toolCallId);
    const event = fingerprintToolEvent(input);
    this.history.push(event);
    if (this.history.length > MAX_TOOL_HISTORY) this.history.shift();

    const same = trailingRun(
      this.history,
      (item) => item.call === event.call && item.outcome === event.outcome,
    );
    if (same >= REPEATED_TOOL_THRESHOLD) {
      return this.signal(
        input,
        input.isError
          ? "repeated-error"
          : isInspectionTool(input.toolName)
            ? "repeated-inspection"
            : "identical-call-result",
        input.isError
          ? `repeated the same ${input.toolName} failure ${same} times`
          : isInspectionTool(input.toolName)
            ? `repeatedly inspected the same target without materially new evidence`
            : `repeated the same tool call and result ${same} times`,
        event,
      );
    }

    const errors = trailingRun(this.history, (item) => item.isError && item.call === event.call);
    if (input.isError && errors >= REPEATED_TOOL_THRESHOLD) {
      return this.signal(
        input,
        "repeated-error",
        `repeated the same failing tool call ${errors} times`,
        event,
      );
    }

    const tail = this.history.slice(-OSCILLATION_WINDOW);
    if (
      tail.length === OSCILLATION_WINDOW &&
      tail[0]?.call === tail[2]?.call &&
      tail[0]?.call === tail[4]?.call &&
      tail[1]?.call === tail[3]?.call &&
      tail[1]?.call === tail[5]?.call &&
      tail[0]?.call !== tail[1]?.call &&
      tail[0]?.outcome === tail[2]?.outcome &&
      tail[0]?.outcome === tail[4]?.outcome &&
      tail[1]?.outcome === tail[3]?.outcome &&
      tail[1]?.outcome === tail[5]?.outcome
    ) {
      return this.signal(
        input,
        "oscillation",
        "oscillated between the same two tool actions without new evidence",
        event,
      );
    }
    return undefined;
  }

  /**
   * A successful terminal result is concrete progress only after a loop was
   * established and when its call/result pair is novel relative to that loop.
   */
  isMateriallyNovelTerminal(
    input: ToolTrajectoryEndInput,
    loopSuspicionActive = this.loopDetected,
  ): boolean {
    if (!loopSuspicionActive || input.isError) return false;
    const event = fingerprintToolEvent(input);
    return !this.history.some(
      (previous) => previous.call === event.call && previous.outcome === event.outcome,
    );
  }

  /** Explicit concrete progress invalidates accumulated loop suspicion. */
  markConcreteProgress(): void {
    this.history = [];
    this.loopDetected = false;
  }

  reset(): void {
    this.active.clear();
    this.history = [];
    this.loopDetected = false;
  }

  private signal(
    input: ToolTrajectoryEndInput,
    kind: ToolLoopKind,
    reason: string,
    event: ToolEventFingerprint,
  ): ToolTrajectorySignal {
    this.loopDetected = true;
    return {
      kind,
      parentTurnId: input.parentTurnId,
      confidence: "strong",
      reason,
      evidence: `${event.toolName} call=${event.call.slice(0, 20)} outcome=${event.outcomeClass}`,
      abortSafe: this.active.size === 0,
    };
  }
}

interface ToolEventFingerprint {
  toolName: string;
  call: string;
  outcome: string;
  outcomeClass: string;
  isError: boolean;
}

function fingerprintToolEvent(input: ToolTrajectoryEndInput): ToolEventFingerprint {
  const toolName = normalizeSegment(input.toolName).slice(0, 80) || "unknown";
  const args = boundedStableValue(input.args);
  const result = boundedStableValue(input.result);
  return {
    toolName,
    call: hashFingerprint(`${toolName}\n${args}`),
    outcome: hashFingerprint(`${input.isError ? "error" : "result"}\n${result}`),
    outcomeClass: classifyOutcome(input.isError, result),
    isError: input.isError,
  };
}

function boundedStableValue(value: unknown): string {
  const seen = new WeakSet<object>();
  const visit = (item: unknown, depth: number): unknown => {
    if (depth > 8) return "[nested]";
    if (typeof item === "string")
      return redactFingerprintText(item).slice(0, MAX_TOOL_FINGERPRINT_INPUT_CHARS);
    if (typeof item !== "object" || item === null) return item;
    if (seen.has(item)) return "[circular]";
    seen.add(item);
    if (Array.isArray(item)) return item.slice(0, 64).map((entry) => visit(entry, depth + 1));
    return Object.fromEntries(
      Object.entries(item as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .slice(0, 64)
        .map(([key, entry]) =>
          /(?:token|secret|password|authorization|api.?key)/i.test(key)
            ? [key, "[redacted]"]
            : [key, visit(entry, depth + 1)],
        ),
    );
  };
  try {
    return JSON.stringify(visit(value, 0)).slice(0, MAX_TOOL_FINGERPRINT_INPUT_CHARS);
  } catch {
    return "[unavailable]";
  }
}

function redactFingerprintText(value: string): string {
  return value
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\b(?:sk-|gh[opusr]_)[A-Za-z0-9_-]{12,}\b/g, "[redacted]");
}

function hashFingerprint(value: string): string {
  // FNV-1a is sufficient for bounded loop comparison and avoids retaining raw evidence.
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function classifyOutcome(isError: boolean, value: string): string {
  if (isError) return "error";
  if (!value || value === '""' || value === "null") return "empty";
  return `result-${Math.min(9, Math.ceil(value.length / 200))}`;
}

function trailingRun<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  let count = 0;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item === undefined || !predicate(item)) break;
    count += 1;
  }
  return count;
}

function isInspectionTool(name: string): boolean {
  return /^(?:read|grep|find|ls)$/i.test(name);
}

interface ChannelState {
  pending: string;
  recent: Set<string>[];
  similarRun: number;
  tail: string;
}

function createChannelState(): ChannelState {
  return { pending: "", recent: [], similarRun: 0, tail: "" };
}

function normalizeSegment(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}_./-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function wordSet(value: string): Set<string> {
  return new Set(value.split(" ").filter((word) => word.length > 2));
}

function jaccardSimilarity(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const word of left) if (right.has(word)) intersection += 1;
  return intersection / (left.size + right.size - intersection);
}

function repeatedTailUnit(value: string): string | undefined {
  for (let unitLength = 16; unitLength <= 64; unitLength += 1) {
    const unit = value.slice(-unitLength);
    if (!unit.trim()) continue;
    let repeatedChars = unitLength;
    let cursor = value.length - unitLength * 2;
    while (cursor >= 0 && value.slice(cursor, cursor + unitLength) === unit) {
      repeatedChars += unitLength;
      cursor -= unitLength;
    }
    if (repeatedChars >= MIN_REPEATED_TAIL_CHARS) return unit;
  }
  return undefined;
}

export const _trajectoryTest = {
  jaccardSimilarity,
  normalizeSegment,
  repeatedTailUnit,
};
