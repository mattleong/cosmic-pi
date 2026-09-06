import { fileURLToPath } from "node:url";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { runBoundedProcessNode } from "pi-cosmic-core";
import { WorkspaceError } from "../workspace/model.ts";
import {
  publicationInputLimit,
  publicationResultSchema,
  directoryResultSchema,
  type PublicationWireRequest,
} from "./git-worktree-publish-helper.ts";
export type { PublicationResult } from "./git-worktree-publish-helper.ts";

export interface WorkspaceDirectoryRequest {
  readonly directory: string;
  readonly directoryDev: number;
  readonly directoryIno: number;
  readonly name: string;
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
type DirectoryWireRequest = Omit<WorkspaceDirectoryRequest, "directory"> & {
  readonly operation: "mkdir";
};
const launch = (directory: string, request: PublicationWireRequest | DirectoryWireRequest) =>
  Effect.gen(function* () {
    if (process.platform === "win32") return yield* failure();
    const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(request).pipe(
      Effect.mapError(failure),
    );
    const stdin = Buffer.from(encoded);
    if (stdin.length > publicationInputLimit) return yield* failure();
    const result = yield* runBoundedProcessNode({
      executable: process.execPath,
      args: [fileURLToPath(new URL("./git-worktree-publish-helper.mjs", import.meta.url))],
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
    return result.stdout;
  });

type MutablePublicationWireRequest = {
  -readonly [K in keyof PublicationWireRequest]: PublicationWireRequest[K];
};

/** Caller durably journals both artifact names before starting this process. No cleanup here. */
export const publishWorkspaceFile = (request: WorkspacePublicationRequest) =>
  Effect.gen(function* () {
    const { directory, before, after, ...fields } = request;
    const wire: MutablePublicationWireRequest = { ...fields };
    if (before)
      wire.before = { bytes: Buffer.from(before.bytes).toString("base64"), mode: before.mode };
    if (after)
      wire.after = { bytes: Buffer.from(after.bytes).toString("base64"), mode: after.mode };
    const output = yield* launch(directory, wire);
    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(publicationResultSchema))(
      output,
    ).pipe(Effect.mapError(failure));
  });

/** Caller journals the planned directory first; existing destinations always fail closed. */
export const createWorkspaceDirectory = (request: WorkspaceDirectoryRequest) =>
  Effect.gen(function* () {
    const { directory, ...fields } = request;
    const output = yield* launch(directory, { ...fields, operation: "mkdir" });
    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(directoryResultSchema))(
      output,
    ).pipe(Effect.mapError(failure));
  });
