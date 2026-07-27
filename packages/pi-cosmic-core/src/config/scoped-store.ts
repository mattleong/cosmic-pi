import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import { JsonDocumentStore } from "../platform/json-document.ts";

export interface ScopedDocumentPaths {
  readonly project: string;
  readonly global: string;
}

export interface ScopedDocumentSelection extends ScopedDocumentPaths {
  readonly projectExists: boolean;
  readonly globalExists: boolean;
  /** Project scope wins whenever its document exists, even if its contents are malformed. */
  readonly preferred: string;
}

export interface ScopedDocumentPathOptions {
  readonly projectConfigDirectory: string;
  readonly basename: string;
  readonly extensionsDirectory?: string;
}

/** Resolves the common project/global extension document locations. */
export const scopedDocumentPaths = Effect.fn("ScopedStore.paths")(function* (
  cwd: string,
  agentDirectory: string,
  options: ScopedDocumentPathOptions,
) {
  const path = yield* Path.Path;
  const extensions = options.extensionsDirectory ?? "extensions";
  return {
    project: path.join(cwd, options.projectConfigDirectory, extensions, options.basename),
    global: path.join(agentDirectory, extensions, options.basename),
  } satisfies ScopedDocumentPaths;
});

/** Inspects both scopes and selects project precedence based on existence, not decode success. */
export const selectScopedDocument = Effect.fn("ScopedStore.select")(function* (
  paths: ScopedDocumentPaths,
) {
  const documents = yield* JsonDocumentStore;
  const projectExists = yield* documents.exists(paths.project);
  const globalExists = yield* documents.exists(paths.global);
  return {
    ...paths,
    projectExists,
    globalExists,
    preferred: projectExists ? paths.project : paths.global,
  } satisfies ScopedDocumentSelection;
});
