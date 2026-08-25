import type { RunRecord } from "./internal.ts";
import { isActiveRunState } from "./model.ts";
import { safeTextPrefix } from "./state.ts";

const MAX_NOTICE_CLAIMS_PER_RUN = 8;
const MAX_NOTICE_CLAIM_CHARS = 512;

const ownershipSummary = (record: RunRecord): string => {
  if (record.view.writeIntent !== "writer") return "read-only";
  const claims = record.view.writeClaims;
  if (!claims) return "exclusive writer";
  const shown = claims
    .slice(0, MAX_NOTICE_CLAIMS_PER_RUN)
    .map((claim) => safeTextPrefix(claim, MAX_NOTICE_CLAIM_CHARS));
  const omitted = claims.length - shown.length;
  return `writer claims: ${shown.join(", ")}${omitted > 0 ? ` (+${omitted} more)` : ""}`;
};

const activePeerLines = (records: ReadonlyArray<RunRecord>, selfId?: string): string[] =>
  records
    .filter((record) => record.view.id !== selfId && isActiveRunState(record.view.state))
    .map(
      (record) =>
        `- ${record.view.name} (${record.view.id}): ${ownershipSummary(record)}; ${record.view.state}; task: ${safeTextPrefix(record.view.task, 160)}`,
    );

export const peerNoticeText = (source: Iterable<RunRecord>, selfId: string): string => {
  const records = [...source];
  const self = records.find((record) => record.view.id === selfId);
  const selfLine = self
    ? `Your current ownership summary: ${ownershipSummary(self)}. A parent reply is authoritative for any complete changed claim set.`
    : "Your current ownership record is unavailable; contact the parent before modifying files.";
  const peers = activePeerLines(records, selfId);
  if (peers.length === 0)
    return `${selfLine}\n\nYou are currently the only active subagent in this workspace.`;
  return [
    selfLine,
    "",
    `You share this working directory with ${peers.length} other active subagent${peers.length === 1 ? "" : "s"}:`,
    "",
    ...peers,
    "",
    "The parent owns coordination and all claim grants. Writers may run concurrently only with disjoint exact-file claims. Never edit a peer's claimed file; contact the parent and wait before work that could overlap another task.",
  ].join("\n");
};
