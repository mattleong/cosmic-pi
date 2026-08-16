import { isJsonObject, isStringValue } from "pi-cosmic-core";
import { stringifyJson } from "../boundary/json.ts";
import * as Schema from "effect/Schema";
import { snapshotData } from "../domain/safe-data.ts";
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

export interface AdvisorTrajectoryDetectorState {
  readonly channels: Readonly<Partial<Record<TrajectoryChannel, ChannelSnapshot>>>;
}
interface ChannelSnapshot {
  readonly pending: string;
  readonly recent: readonly (readonly string[])[];
  readonly similarRun: number;
  readonly tail: string;
}
export const emptyAdvisorTrajectoryDetector = (): AdvisorTrajectoryDetectorState => ({
  channels: {},
});
export const pushAdvisorTrajectory = (
  state: AdvisorTrajectoryDetectorState,
  channel: TrajectoryChannel,
  delta: string,
) => {
  if (!delta) return { state };
  const previous = state.channels[channel] ?? { pending: "", recent: [], similarRun: 0, tail: "" };
  let tail = `${previous.tail}${delta}`.slice(-TAIL_LIMIT);
  const repeatedUnit = repeatedTailUnit(tail);
  if (repeatedUnit)
    return {
      state: { channels: { ...state.channels, [channel]: { ...previous, tail } } },
      signal: {
        channel,
        reason: `repeated the same ${repeatedUnit.length}-character sequence several times`,
      },
    };
  let pending = previous.pending + delta;
  let recent = previous.recent.map((words) => [...words]);
  let similarRun = previous.similarRun;
  let signal: TrajectorySignal | undefined;
  while (pending.length > 0) {
    const boundary = /\n\s*\n/.exec(pending);
    let segment: string | undefined;
    if (boundary) {
      segment = pending.slice(0, boundary.index);
      pending = pending.slice(boundary.index + boundary[0].length);
    } else if (pending.length >= MAX_PENDING_CHARS) {
      segment = pending.slice(0, MAX_PENDING_CHARS);
      pending = pending.slice(MAX_PENDING_CHARS);
    }
    if (segment === undefined) break;
    const normalized = normalizeSegment(segment);
    if (normalized.length < MIN_SEGMENT_CHARS) continue;
    const words = [...wordSet(normalized)];
    const wordsSet = new Set(words);
    const similar = recent.some(
      (item) => jaccardSimilarity(new Set(item), wordsSet) >= SIMILARITY_THRESHOLD,
    );
    similarRun = similar ? similarRun + 1 : 0;
    recent = [...recent, words].slice(-RECENT_SEGMENT_LIMIT);
    if (similarRun >= REPEATED_SEGMENT_THRESHOLD - 1) {
      signal = {
        channel,
        reason: `produced ${REPEATED_SEGMENT_THRESHOLD} near-duplicate substantial segments`,
      };
      break;
    }
  }
  return (() => {
    const objectPart3646_0 = {
      state: { channels: { ...state.channels, [channel]: { pending, recent, similarRun, tail } } },
    };
    const objectPart3646_1 = signal ? { ...objectPart3646_0, signal } : objectPart3646_0;
    return objectPart3646_1;
  })();
};

export interface AdvisorToolTrajectoryDetectorState {
  readonly active: readonly string[];
  readonly history: readonly ToolEventFingerprint[];
  readonly loopDetected: boolean;
}
export const emptyAdvisorToolTrajectoryDetector = (): AdvisorToolTrajectoryDetectorState => ({
  active: [],
  history: [],
  loopDetected: false,
});
export const startAdvisorToolTrajectory = (
  state: AdvisorToolTrajectoryDetectorState,
  toolCallId: string,
): AdvisorToolTrajectoryDetectorState => ({
  ...state,
  active: [...new Set([...state.active, toolCallId])],
});
export const advisorActiveToolCount = (state: AdvisorToolTrajectoryDetectorState): number =>
  state.active.length;
export const isMateriallyNovelAdvisorTerminal = (
  state: AdvisorToolTrajectoryDetectorState,
  input: ToolTrajectoryEndInput,
  loopSuspicionActive = state.loopDetected,
): boolean => {
  if (!loopSuspicionActive || input.isError) return false;
  const event = fingerprintToolEvent(input);
  return !state.history.some(
    (previous) => previous.call === event.call && previous.outcome === event.outcome,
  );
};
export const markConcreteAdvisorProgress = (
  state: AdvisorToolTrajectoryDetectorState,
): AdvisorToolTrajectoryDetectorState => ({ ...state, history: [], loopDetected: false });
export const endAdvisorToolTrajectory = (
  state: AdvisorToolTrajectoryDetectorState,
  input: ToolTrajectoryEndInput,
): {
  readonly state: AdvisorToolTrajectoryDetectorState;
  readonly signal?: ToolTrajectorySignal;
} => {
  const active = state.active.filter((id) => id !== input.toolCallId);
  const event = fingerprintToolEvent(input);
  const history = [...state.history, event].slice(-MAX_TOOL_HISTORY);
  const same = trailingRun(
    history,
    (item) => item.call === event.call && item.outcome === event.outcome,
  );
  let kind: ToolLoopKind | undefined;
  let reason = "";
  if (same >= REPEATED_TOOL_THRESHOLD) {
    kind = input.isError
      ? "repeated-error"
      : isInspectionTool(input.toolName)
        ? "repeated-inspection"
        : "identical-call-result";
    reason = input.isError
      ? `repeated the same ${input.toolName} failure ${same} times`
      : isInspectionTool(input.toolName)
        ? "repeatedly inspected the same target without materially new evidence"
        : `repeated the same tool call and result ${same} times`;
  } else {
    const errors = trailingRun(history, (item) => item.isError && item.call === event.call);
    if (input.isError && errors >= REPEATED_TOOL_THRESHOLD) {
      kind = "repeated-error";
      reason = `repeated the same failing tool call ${errors} times`;
    } else {
      const tail = history.slice(-OSCILLATION_WINDOW);
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
        kind = "oscillation";
        reason = "oscillated between the same two tool actions without new evidence";
      }
    }
  }
  const next = { active, history, loopDetected: state.loopDetected || kind !== undefined };
  return kind
    ? {
        state: next,
        signal: {
          kind,
          parentTurnId: input.parentTurnId,
          confidence: "strong",
          reason,
          evidence: `${event.toolName} call=${event.call.slice(0, 20)} outcome=${event.outcomeClass}`,
          abortSafe: active.length === 0,
        },
      }
    : { state: next };
};

export interface ToolEventFingerprint {
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

function boundedStableValue<ValueInput>(value: ValueInput): string {
  const visit = (item: Schema.MutableJson, depth: number): Schema.MutableJson => {
    if (depth > 8) return "[nested]";
    if (isStringValue(item))
      return redactFingerprintText(item).slice(0, MAX_TOOL_FINGERPRINT_INPUT_CHARS);
    if (Array.isArray(item)) return item.slice(0, 64).map((entry) => visit(entry, depth + 1));
    if (!isJsonObject(item)) return item;
    return Object.fromEntries(
      Object.entries(item)
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
    const snapshot = snapshotData(value);
    if (snapshot === undefined) return "[unavailable]";
    return stringifyJson(visit(snapshot, 0)).slice(0, MAX_TOOL_FINGERPRINT_INPUT_CHARS);
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
