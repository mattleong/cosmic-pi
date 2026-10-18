import * as Effect from "effect/Effect";
import type { RunRecord } from "./internal.ts";
import { hasSubagentCapability, isActiveRunState } from "./model.ts";
import { countLabel, safeTextPrefix } from "pi-cosmic-core";

const ownershipSummary = (record: RunRecord): string =>
  record.view.writeIntent === "writer"
    ? record.view.workspaceId !== undefined
      ? "isolated writer"
      : "shared-checkout writer"
    : "read-only";

const activePeerLines = (records: ReadonlyArray<RunRecord>, selfId?: string): string[] =>
  records.flatMap((record) =>
    record.view.id !== selfId && isActiveRunState(record.view.state)
      ? [
          `- ${record.view.name} (${record.view.id}): ${ownershipSummary(record)}; ${record.view.state}; task: ${safeTextPrefix(record.view.task, 160)}`,
        ]
      : [],
  );

export const peerNoticeText = (source: Iterable<RunRecord>, selfId: string): string => {
  const records = [...source];
  const self = records.find((record) => record.view.id === selfId);
  const selfLine = self
    ? `Your current ownership summary: ${ownershipSummary(self)}.`
    : "Your current ownership record is unavailable; contact the parent before modifying files.";
  const workspacePeers = self ? records.filter((record) => record.view.cwd === self.view.cwd) : [];
  const peers = activePeerLines(workspacePeers, selfId);
  if (peers.length === 0)
    return `${selfLine}\n\nYou are currently the only active subagent in this workspace.`;
  return [
    selfLine,
    "",
    `You share this working directory with ${countLabel(peers.length, "other active subagent")}:`,
    "",
    ...peers,
    "",
    "The parent owns coordination. Shared-checkout writers coordinate by task scope: never edit files that belong to a peer's task, and contact the parent and wait before work that could overlap another task.",
  ].join("\n");
};

export const peerNotifier =
  (records: ReadonlyMap<string, RunRecord>) =>
  (changedRunId: string): Effect.Effect<void> =>
    Effect.suspend(() =>
      Effect.forEach(
        [...records.values()].flatMap((record) => {
          const process = record.process;
          return process &&
            isActiveRunState(record.view.state) &&
            hasSubagentCapability(record.view, "peer-notice")
            ? [{ record, process }]
            : [];
        }),
        ({ record, process }) =>
          process.controls
            .notifyPeers(peerNoticeText(records.values(), record.view.id))
            .pipe(Effect.timeout("1 second"), Effect.ignore),
        { concurrency: 8, discard: true },
      ),
    ).pipe(Effect.annotateLogs("changedRunId", changedRunId));
