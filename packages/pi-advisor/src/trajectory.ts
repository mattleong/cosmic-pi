const MAX_PENDING_CHARS = 600;
const MIN_SEGMENT_CHARS = 80;
const RECENT_SEGMENT_LIMIT = 8;
const SIMILARITY_THRESHOLD = 0.86;
const REPEATED_SEGMENT_THRESHOLD = 4;
const TAIL_LIMIT = 320;
const MIN_REPEATED_TAIL_CHARS = 160;

export const LONG_TURN_REVIEW_MS = 90_000;
export const MIN_LOOP_REVIEW_MS = 15_000;
export const MAX_TRAJECTORY_EVIDENCE_CHARS = 6_000;

export type TrajectoryChannel = "thinking" | "text";

export interface TrajectorySignal {
  channel: TrajectoryChannel;
  reason: string;
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
