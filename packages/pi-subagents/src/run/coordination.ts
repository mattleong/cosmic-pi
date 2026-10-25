import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { RunRecord } from "./internal.ts";
import { isActiveRunState } from "./model.ts";
import { countLabel } from "pi-cosmic-core/display";
import { safeTextPrefix } from "pi-cosmic-core/text";

const ownershipSummary = (record: RunRecord): string =>
  record.view.writeIntent === "writer"
    ? record.view.workspaceId !== undefined
      ? "isolated writer"
      : "shared-checkout writer"
    : "read-only";

const activePeerLines = (records: ReadonlyArray<RunRecord>, selfId?: string): string[] =>
  Arr.flatMap(records, (record) =>
    record.view.id !== selfId && isActiveRunState(record.view.state)
      ? [
          `- ${record.launch.name} (${record.view.id}): ${ownershipSummary(record)}; ${record.view.state}; task: ${safeTextPrefix(record.view.task, 160)}`,
        ]
      : [],
  );

export const peerNoticeText = (source: Iterable<RunRecord>, selfId: string): string => {
  const records = [...source];
  const self = Option.getOrUndefined(Arr.findFirst(records, (record) => record.view.id === selfId));
  const selfLine = self
    ? `Your current ownership summary: ${ownershipSummary(self)}.`
    : "Your current ownership record is unavailable; contact the parent before modifying files.";
  const workspacePeers = self
    ? Arr.filter(records, (record) => record.view.cwd === self.view.cwd)
    : [];
  const peers = activePeerLines(workspacePeers, selfId);
  if (peers.length === 0)
    return `${selfLine}\n\nYou are currently the only active subagent in this workspace.`;
  return Arr.join(
    [
      selfLine,
      "",
      `You share this working directory with ${countLabel(peers.length, "other active subagent")}:`,
      "",
      ...peers,
      "",
      "Shared-checkout writers coordinate by task scope: never edit files that belong to a peer's task. Before work that could overlap a running peer's task, agree on it with that peer through agent_send, and tell peers about changes they depend on. Ask the parent if you can't agree.",
    ],
    "\n",
  );
};

export const peerNotifier =
  (records: ReadonlyMap<string, RunRecord>) =>
  (changedRunId: string): Effect.Effect<void> =>
    Effect.suspend(() =>
      Effect.forEach(
        Arr.flatMap([...records.values()], (record) => {
          const process = record.process;
          return process && isActiveRunState(record.view.state) ? [{ record, process }] : [];
        }),
        ({ record, process }) =>
          process.controls
            .notifyPeers(peerNoticeText(records.values(), record.view.id))
            .pipe(Effect.timeout("1 second"), Effect.ignore),
        { concurrency: 8, discard: true },
      ),
    ).pipe(Effect.annotateLogs("changedRunId", changedRunId));
