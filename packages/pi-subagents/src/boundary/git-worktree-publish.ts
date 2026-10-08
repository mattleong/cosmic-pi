import { fileURLToPath } from "node:url";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { runBoundedProcessNode } from "pi-cosmic-core";
import { WorkspaceError } from "../workspace/model.ts";
import {
  publicationInputLimit,
  publicationResultSchema,
  directoryResultSchema,
  type DirectoryWireRequest,
  type PublicationWireRequest,
} from "./git-worktree-publish-helper.ts";

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
const encodeRequest = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodePublicationResult = Schema.decodeUnknownEffect(
  Schema.fromJsonString(publicationResultSchema),
);
const decodeDirectoryResult = Schema.decodeUnknownEffect(
  Schema.fromJsonString(directoryResultSchema),
);
const launch = <A, E>(
  directory: string,
  request: PublicationWireRequest | DirectoryWireRequest,
  decode: (stdout: string) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    if (process.platform === "win32") return yield* failure();
    const encoded = yield* encodeRequest(request).pipe(Effect.mapError(failure));
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
    return yield* decode(result.stdout).pipe(Effect.mapError(failure));
  });

const base64 = (image?: { readonly bytes: Uint8Array; readonly mode: number }) =>
  image && { bytes: Buffer.from(image.bytes).toString("base64"), mode: image.mode };

/** Caller durably journals both artifact names before starting this process. No cleanup here. */
export const publishWorkspaceFile = (request: WorkspacePublicationRequest) => {
  const { directory, before, after, ...fields } = request;
  return launch(
    directory,
    { ...fields, before: base64(before), after: base64(after) },
    decodePublicationResult,
  );
};

/** Caller journals the planned directory first; existing destinations always fail closed. */
export const createWorkspaceDirectory = ({ directory, ...fields }: WorkspaceDirectoryRequest) =>
  launch(directory, { ...fields, operation: "mkdir" }, decodeDirectoryResult);
