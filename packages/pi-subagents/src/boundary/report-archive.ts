import {
  sanitizeTerminalLine,
  synchronousRandomUuid,
  nodeFsPromises as fs,
  nodePath as path,
} from "pi-cosmic-core";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { safeSubagentDirectorySegment } from "./child-process.ts";
import { nodeErrorCode } from "./harness-shared.ts";
import { MAX_OUTCOME_FILE_PATH_CHARS } from "../run/limits.ts";
import type { SubagentReportArchive } from "../run/model.ts";
import {
  PRIVATE_STATE_RETENTION_MILLIS,
  REPORT_ARCHIVE_ROOT,
  SUBAGENT_STATE_ROOT,
} from "./private-state.ts";

export const ReportArchiveEntry = Schema.Struct({
  id: Schema.String,
  generation: Schema.Int,
  /** A failure's file; a report's when absent. */
  kind: Schema.optional(Schema.Literal("failure")),
  text: Schema.String,
  /** The whole report's length when `text` holds only its start. */
  originalChars: Schema.optional(Schema.Int),
});
export type ReportArchiveEntry = typeof ReportArchiveEntry.Type;

export class ReportArchiveError extends Schema.TaggedError<
  ReportArchiveError,
  { readonly brand: unique symbol }
>()("ReportArchiveError", {
  reason: Schema.Literals(["path_unrepresentable", "file_exists", "write_failed", "remove_failed"]),
  message: Schema.String,
}) {}

export interface ReportArchive {
  /** Creates the entry's file exclusively; a failure leaves no file this call created. */
  readonly save: (
    entry: ReportArchiveEntry,
  ) => Effect.Effect<SubagentReportArchive, ReportArchiveError>;
  /** Removes a file `save` created that no settlement committed. */
  readonly discard: (archive: SubagentReportArchive) => Effect.Effect<void, ReportArchiveError>;
}

const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;

export const reportArchiveRoot = (agentDirectory: string): string =>
  path.join(agentDirectory, SUBAGENT_STATE_ROOT, REPORT_ARCHIVE_ROOT);

const countLines = (text: string): number => text.split("\n").length;

// A report cut by the archive cap says so in its own file, not only in the notice that links it.
const archivedContent = (entry: ReportArchiveEntry): string =>
  entry.originalChars !== undefined && entry.originalChars > entry.text.length
    ? `${entry.text}\n\n[Report truncated: this file holds the first ${entry.text.length.toLocaleString("en-US")} of ${entry.originalChars.toLocaleString("en-US")} characters.]`
    : entry.text;

const archiveIO = <A>(
  reason: ReportArchiveError["reason"],
  message: string,
  evaluate: () => PromiseLike<A>,
): Effect.Effect<A, ReportArchiveError> =>
  Effect.tryPromise({
    try: evaluate,
    catch: () => new ReportArchiveError({ reason, message }),
  });

// Run ids and file suffixes are collision-resistant, not guaranteed unique. Exclusive creation
// preserves an old link if the archive identity ever collides; the report then reaches the parent
// inline. A file this call created but couldn't fill is removed, since nothing else owns it.
const writeExclusive = (file: string, content: string) =>
  Effect.acquireUseRelease(
    Effect.tryPromise({
      try: () => fs.open(file, "wx", 0o600),
      catch: (cause) =>
        nodeErrorCode(cause) === "EEXIST"
          ? new ReportArchiveError({
              reason: "file_exists",
              message: "A report file with this identity already exists.",
            })
          : new ReportArchiveError({
              reason: "write_failed",
              message: "The report file couldn't be created.",
            }),
    }),
    (handle) =>
      archiveIO("write_failed", "The report file couldn't be written.", () =>
        handle.writeFile(content),
      ).pipe(
        // Closing can surface a deferred write error, so the file is saved only once it closes.
        Effect.andThen(
          archiveIO("write_failed", "The report file couldn't be closed.", () => handle.close()),
        ),
        Effect.tapError(() =>
          archiveIO("remove_failed", "A partial report file couldn't be removed.", () =>
            fs.unlink(file),
          ).pipe(Effect.ignore),
        ),
      ),
    (handle, exit) =>
      Exit.isSuccess(exit)
        ? Effect.void
        : archiveIO("write_failed", "The report file couldn't be closed.", () =>
            handle.close(),
          ).pipe(Effect.ignore),
  );

/**
 * Writes each completed report, and each failure too long to preview, to a private file keyed by
 * the Pi session. The parent reads the text from this file, and can re-read it after
 * compaction, `/reload`, or a resumed session.
 */
export const sessionReportArchive = (agentDirectory: string, sessionKey: string): ReportArchive => {
  const directory = path.join(
    reportArchiveRoot(agentDirectory),
    safeSubagentDirectorySegment(sessionKey),
  );
  const save = Effect.fn("ReportArchive.save")(
    function* (entry: ReportArchiveEntry) {
      const file = path.join(
        directory,
        `${safeSubagentDirectorySegment(entry.id)}-${entry.kind ? `${entry.kind}-` : ""}${entry.generation}-${synchronousRandomUuid()}.md`,
      );
      // Every surface names the file by its path verbatim within a fixed per-run budget, so a path
      // they can't carry saves nothing and the parent gets a preview and agent_read instead.
      if (file.length > MAX_OUTCOME_FILE_PATH_CHARS || sanitizeTerminalLine(file) !== file)
        return yield* new ReportArchiveError({
          reason: "path_unrepresentable",
          message: "The report file path can't be shown verbatim.",
        });
      yield* archiveIO("write_failed", "The report directory couldn't be created.", () =>
        fs.mkdir(directory, { recursive: true, mode: 0o700 }),
      );
      const content = archivedContent(entry);
      yield* writeExclusive(file, content);
      return {
        path: file,
        chars: entry.text.length,
        lines: countLines(entry.text),
        complete: content === entry.text,
      } satisfies SubagentReportArchive;
    },
    // A bounded local write; an interrupted one could leave a file that no caller owns.
    Effect.uninterruptible,
  );
  const discard = (archive: SubagentReportArchive) =>
    archiveIO("remove_failed", "An uncommitted report file couldn't be removed.", () =>
      fs.unlink(archive.path),
    );
  return { save, discard };
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
export const pruneReportArchive = Effect.fn("ReportArchive.pruneReportArchive")(function* (
  agentDirectory: string,
): Effect.fn.Return<void> {
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
