import { fileURLToPath } from "node:url";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { runBoundedProcessNode } from "pi-cosmic-core";
import { WorkspaceError } from "../workspace/model.ts";
import {
  backupRemovalResultSchema,
  publicationInputLimit,
  publicationResultSchema,
  directoryRemovalResultSchema,
  directoryResultSchema,
  type BackupRemovalWireRequest,
  type DirectoryRemovalWireRequest,
  type DirectoryWireRequest,
  type PublicationWireRequest,
} from "./git-worktree-publish-helper.ts";

interface AnchoredDirectory {
  readonly directory: string;
  readonly directoryDev: number;
  readonly directoryIno: number;
  /** A private directory where the helper may cache its transpiled source between starts. */
  readonly helperCache?: string | undefined;
}
export interface WorkspaceDirectoryRequest extends AnchoredDirectory {
  readonly name: string;
}
export interface WorkspaceBackupRemovalRequest extends AnchoredDirectory {
  readonly names: ReadonlyArray<string>;
}
export interface WorkspaceDirectoryRemovalRequest extends WorkspaceDirectoryRequest {
  readonly targetDev: number;
  readonly targetIno: number;
}
export interface WorkspacePublicationRequest extends WorkspaceDirectoryRequest {
  readonly backupName: string;
  readonly temporaryName: string;
  readonly before?: { readonly bytes: Uint8Array; readonly mode: number };
  readonly after?: { readonly bytes: Uint8Array; readonly mode: number };
}
const failure = () =>
  new WorkspaceError({
    operation: "publication",
    message:
      "Workspace publication failed or is uncertain; preserve the journal and all artifacts for recovery.",
  });
const encodeRequest = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodePublicationResult = Schema.decodeUnknownEffect(
  Schema.fromJsonString(publicationResultSchema),
);
const decodeDirectoryResult = Schema.decodeUnknownEffect(
  Schema.fromJsonString(directoryResultSchema),
);
const decodeBackupRemovalResult = Schema.decodeUnknownEffect(
  Schema.fromJsonString(backupRemovalResultSchema),
);
const decodeDirectoryRemovalResult = Schema.decodeUnknownEffect(
  Schema.fromJsonString(directoryRemovalResultSchema),
);
const launch = <A, E>(
  directory: string,
  helperCache: string | undefined,
  request:
    | PublicationWireRequest
    | DirectoryWireRequest
    | BackupRemovalWireRequest
    | DirectoryRemovalWireRequest,
  decode: (stdout: string) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const encoded = yield* encodeRequest(request).pipe(Effect.mapError(failure));
    const stdin = Buffer.from(encoded);
    if (stdin.length > publicationInputLimit) return yield* failure();
    const result = yield* runBoundedProcessNode({
      executable: process.execPath,
      args: [
        fileURLToPath(new URL("./git-worktree-publish-helper.mjs", import.meta.url)),
        ...(helperCache === undefined ? [] : [helperCache]),
      ],
      cwd: directory,
      environment: { PATH: "/usr/bin:/bin" },
      stdin,
      stdoutLimitBytes: 1024,
      stderrLimitBytes: 1024,
      timeoutMillis: 30_000,
      cleanupTimeoutMillis: 2000,
      detached: true,
      sweepProcessTreeOnExit: true,
    }).pipe(Effect.mapError(failure));
    if (result.code !== 0 || result.timedOut || result.overflowed || result.cleanupUnconfirmed)
      return yield* failure();
    return yield* decode(result.stdout).pipe(Effect.mapError(failure));
  });

const base64 = (image?: { readonly bytes: Uint8Array; readonly mode: number }) =>
  image && { bytes: Buffer.from(image.bytes).toString("base64"), mode: image.mode };

export const publishWorkspaceFile = (request: WorkspacePublicationRequest) => {
  const { directory, helperCache, before, after, ...fields } = request;
  return launch(
    directory,
    helperCache,
    { ...fields, before: base64(before), after: base64(after) },
    decodePublicationResult,
  );
};

export const createWorkspaceDirectory = ({
  directory,
  helperCache,
  ...fields
}: WorkspaceDirectoryRequest) =>
  launch(directory, helperCache, { ...fields, operation: "mkdir" }, decodeDirectoryResult);

/** Deletes publication backups in one directory; the result names those still present. */
export const removeWorkspaceBackups = ({
  directory,
  helperCache,
  ...fields
}: WorkspaceBackupRemovalRequest) =>
  launch(
    directory,
    helperCache,
    { ...fields, operation: "remove-backups" },
    decodeBackupRemovalResult,
  );

/** Removes `name` only while it is still the identified, empty directory. */
export const removeEmptyWorkspaceDirectory = ({
  directory,
  helperCache,
  ...fields
}: WorkspaceDirectoryRemovalRequest) =>
  launch(directory, helperCache, { ...fields, operation: "rmdir" }, decodeDirectoryRemovalResult);
