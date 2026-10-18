import * as Match from "effect/Match";
import { decodeFullScreenPrintable } from "pi-cosmic-ui/manager/keymap";
import type { ListDetailPane } from "pi-cosmic-ui/manager/list-detail";
import { Key, matchesKey, type Input } from "@earendil-works/pi-tui";
import { hasUnresolvedSteeringDelivery, type SubagentRunView } from "../run/model.ts";
import {
  canInterruptRun,
  canRenameRun,
  canResumeRun,
  canStopRun,
  runMessageMode,
  type RunMessageMode,
} from "./run-state.ts";

export const canStop = canStopRun;

export type FleetPromptKind = RunMessageMode | "resume" | "rename";

export const FLEET_SHORTCUTS = new Set(["e", "i", "m", "t", "u", "x"]);

export type PendingConfirmation = {
  readonly action: "stop" | "interrupt";
  readonly id: string;
  readonly run: SubagentRunView;
};
export const CONFIRMATION_KEYS = { stop: "x", interrupt: "i" } as const;
export const sameFleetAssignment = (before: SubagentRunView, after: SubagentRunView): boolean =>
  before.assignmentEpoch === after.assignmentEpoch &&
  before.sessionId === after.sessionId &&
  before.state === after.state &&
  before.question?.requestId === after.question?.requestId;

export const canConfirm = (pending: PendingConfirmation, run: SubagentRunView) =>
  sameFleetAssignment(pending.run, run) &&
  (pending.action === "stop" ? canStop(run) : canInterruptRun(run));

const UNAVAILABLE_REASONS = new Map([
  ["m", "This run cannot receive guidance, a reply, or a new assignment in its current state."],
  ["i", "This run cannot be interrupted in its current state or backend."],
  ["u", "This run cannot be resumed in its current state or backend."],
  ["e", "This run cannot be renamed in its current state."],
]);

export const shortcutUnavailableReason = (key: string, run: SubagentRunView): string =>
  (key === "m" || key === "i") && hasUnresolvedSteeringDelivery(run)
    ? "Guidance delivery to this run is still unresolved; wait for it to settle or stop the run."
    : (UNAVAILABLE_REASONS.get(key) ?? "This run is not currently stoppable.");

export const fixedTreeDirection = (
  data: string,
  pane: ListDetailPane,
): "back" | "forward" | undefined => {
  if (pane !== "list") return undefined;
  const printable = decodeFullScreenPrintable(data);
  if (printable === "h" || matchesKey(data, Key.left)) return "back";
  if (printable === "l" || matchesKey(data, Key.right)) return "forward";
  return undefined;
};

export const MESSAGES = {
  reply: { label: "Reply", shortcut: "m Reply", progress: "Sending reply" },
  guidance: { label: "Guidance", shortcut: "m Guide", progress: "Sending guidance" },
};

const FLEET_ACTION_LABELS = [
  { can: canInterruptRun, full: "i Interrupt", compact: "i Int" },
  { can: canResumeRun, full: "u Resume", compact: "u Resume" },
  { can: canRenameRun, full: "e Rename", compact: "e Name" },
  { can: canStop, full: "x Stop subtree", compact: "x Stop tree" },
];

export const fleetActionLabels = (selected: SubagentRunView) => {
  const mode = runMessageMode(selected);
  const labels = [
    ...(mode ? [{ full: MESSAGES[mode].shortcut, compact: MESSAGES[mode].shortcut }] : []),
    ...FLEET_ACTION_LABELS.filter(({ can }) => can(selected)),
  ];
  return labels.length === 0
    ? {}
    : {
        actions: labels.map((label) => label.full).join(" · "),
        compactActions: labels.map((label) => label.compact).join(" · "),
      };
};

export const PROMPTS = {
  reply: { title: "Reply to", instruction: "Answer the pending question" },
  guidance: { title: "Guide", instruction: "Enter guidance for the active assignment" },
  resume: { title: "Resume", instruction: "Optional continuation message; submit blank to resume" },
  rename: { title: "Rename", instruction: "Enter a new display name" },
};

export const promptAvailable = (kind: FleetPromptKind, run: SubagentRunView | undefined): boolean =>
  run !== undefined &&
  Match.value(kind).pipe(
    Match.when("resume", () => canResumeRun(run)),
    Match.when("rename", () => canRenameRun(run)),
    Match.orElse((mode) => runMessageMode(run) === mode),
  );

export const promptUnavailableFeedback = (
  kind: FleetPromptKind,
  run: SubagentRunView | undefined,
) =>
  run && kind === "guidance" && hasUnresolvedSteeringDelivery(run)
    ? "Nothing was sent: earlier guidance delivery is still unresolved."
    : "Nothing was sent: this run no longer accepts this input in its current state.";

export type FleetPrompt = {
  readonly kind: FleetPromptKind;
  readonly runId: string;
  readonly runName: string;
  readonly run: SubagentRunView;
  readonly input: Input;
  readonly context?: string | undefined;
  feedback?: string | undefined;
};
