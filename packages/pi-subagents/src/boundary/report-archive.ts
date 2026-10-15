import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { safeSubagentDirectorySegment } from "./child-process.ts";
import {
  nodeFsPromises as fs,
  nodeMkdirSync,
  nodePath as path,
  nodeWriteFileSync,
} from "./node-builtins.ts";
import {
  PRIVATE_STATE_RETENTION_MILLIS,
  REPORT_ARCHIVE_ROOT,
  SUBAGENT_STATE_ROOT,
} from "./private-state.ts";

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

const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;

export const reportArchiveRoot = (agentDirectory: string): string =>
  path.join(agentDirectory, SUBAGENT_STATE_ROOT, REPORT_ARCHIVE_ROOT);

/**
 * Writes each delivered report to a private file keyed by the Pi session, so the parent can
 * re-read it after compaction, `/reload`, or a resumed session.
 */
export const sessionReportArchive = (agentDirectory: string, sessionKey: string): ReportArchive => {
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

const attempt = <A>(evaluate: () => PromiseLike<A>): Effect.Effect<Option.Option<A>> =>
  Effect.tryPromise(evaluate).pipe(Effect.option);

const sessionDirectories = (root: string): Effect.Effect<ReadonlyArray<string>> =>
  attempt(() => fs.readdir(root, { withFileTypes: true })).pipe(
    Effect.map((entries) =>
      Option.getOrElse(entries, () => []).flatMap((entry) =>
        entry.isDirectory() ? [path.join(root, entry.name)] : [],
      ),
    ),
  );

const archivedFiles = (directory: string): Effect.Effect<ReadonlyArray<ArchivedFile>> =>
  attempt(() => fs.readdir(directory)).pipe(
    Effect.flatMap((names) =>
      Effect.forEach(
        Option.getOrElse(names, () => []),
        (name) => {
          const file = path.join(directory, name);
          return attempt(() => fs.stat(file)).pipe(
            Effect.map(
              Option.map(
                (stat): ArchivedFile => ({
                  file,
                  size: stat.size,
                  modified: stat.mtimeMs,
                }),
              ),
            ),
          );
        },
      ),
    ),
    Effect.map((files) => files.flatMap(Option.toArray)),
  );

/**
 * Removes reports older than a week, then the oldest reports beyond the size cap, then session
 * directories left empty. A file or directory that can't be read or removed is skipped.
 */
export const pruneReportArchive = (agentDirectory: string): Effect.Effect<void> =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const directories = yield* sessionDirectories(reportArchiveRoot(agentDirectory));
    const files = (yield* Effect.forEach(directories, archivedFiles)).flat();
    const expired = files.filter((file) => now - file.modified > PRIVATE_STATE_RETENTION_MILLIS);
    const kept = files
      .filter((file) => now - file.modified <= PRIVATE_STATE_RETENTION_MILLIS)
      .toSorted((left, right) => right.modified - left.modified);
    let total = 0;
    const overflow = kept.filter((file) => (total += file.size) > MAX_ARCHIVE_BYTES);
    yield* Effect.forEach(
      [...expired, ...overflow],
      (file) => attempt(() => fs.rm(file.file, { force: true })),
      { discard: true },
    );
    // rmdir removes only directories that are now empty.
    yield* Effect.forEach(directories, (directory) => attempt(() => fs.rmdir(directory)), {
      discard: true,
    });
  });
