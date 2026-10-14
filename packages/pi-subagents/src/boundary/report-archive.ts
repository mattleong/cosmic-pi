import { safeSubagentDirectorySegment } from "./child-process.ts";
import {
  nodeFsPromises as fs,
  nodeMkdirSync,
  nodePath as path,
  nodeWriteFileSync,
} from "./node-builtins.ts";

export interface ArchivedReport {
  readonly path: string;
  readonly lines: number;
}

export interface ReportArchiveEntry {
  readonly id: string;
  readonly generation: number;
  readonly text: string;
}

export type ReportArchive = (entry: ReportArchiveEntry) => ArchivedReport | undefined;

const RETENTION_MILLIS = 7 * 24 * 60 * 60 * 1000;
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;

export const reportArchiveRoot = (agentDirectory: string): string =>
  path.join(agentDirectory, "subagents", "reports");

/**
 * Writes each delivered report to a private file keyed by the Pi session, so the parent can
 * re-read it after compaction, `/reload`, or a resumed session.
 */
export const makeReportArchive = (agentDirectory: string, sessionKey: string): ReportArchive => {
  const directory = path.join(
    reportArchiveRoot(agentDirectory),
    safeSubagentDirectorySegment(sessionKey),
  );
  return (entry) => {
    try {
      nodeMkdirSync(directory, { recursive: true, mode: 0o700 });
      const file = path.join(
        directory,
        `${safeSubagentDirectorySegment(entry.id)}-${entry.generation}.md`,
      );
      nodeWriteFileSync(file, entry.text, { mode: 0o600 });
      return { path: file, lines: entry.text.split("\n").length };
    } catch {
      return undefined;
    }
  };
};

interface ArchivedFile {
  readonly file: string;
  readonly size: number;
  readonly modified: number;
}

const listArchivedFiles = (root: string): Promise<ReadonlyArray<ArchivedFile>> =>
  fs
    .readdir(root, { withFileTypes: true })
    .then((sessions) =>
      Promise.all(
        sessions
          .filter((entry) => entry.isDirectory())
          .map((session) => {
            const directory = path.join(root, session.name);
            return fs.readdir(directory).then((names) =>
              Promise.all(
                names.map((name) => {
                  const file = path.join(directory, name);
                  return fs
                    .stat(file)
                    .then((stat) => ({ file, size: stat.size, modified: stat.mtimeMs }));
                }),
              ),
            );
          }),
      ),
    )
    .then((sessions) => sessions.flat());

/** Removes reports older than a week, then the oldest reports beyond the size cap. */
export const pruneReportArchive = (agentDirectory: string, now: number): Promise<void> => {
  const root = reportArchiveRoot(agentDirectory);
  return listArchivedFiles(root)
    .then((files) => {
      const expired = files.filter((file) => now - file.modified > RETENTION_MILLIS);
      const kept = files
        .filter((file) => now - file.modified <= RETENTION_MILLIS)
        .toSorted((left, right) => right.modified - left.modified);
      let total = 0;
      const overflow = kept.filter((file) => (total += file.size) > MAX_ARCHIVE_BYTES);
      return Promise.all(
        [...expired, ...overflow].map((file) => fs.rm(file.file, { force: true })),
      );
    })
    .then(
      () => undefined,
      () => undefined,
    );
};
