import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { AgentDirectory, JsonDocumentStore, type JsonObject } from "pi-cosmic-core";
import { HerdrConfigError, HerdrStateError } from "../herd/errors.ts";
import { isHerdrAgentFinished } from "../herd/model.ts";
import { normalizeHerdrConfig } from "./options.ts";
import {
  DEFAULT_HERDR_CONFIG,
  HERDR_CONFIG_BASENAME,
  HERDR_STATE_BASENAME,
  HERDR_STATE_VERSION,
  HerdrConfigFileSchema,
  HerdrStateDocumentSchema,
  LegacyHerdrStateDocumentSchema,
  type HerdrConfig,
  type HerdrStateDocument,
  type PersistedHerdrProject,
} from "./schema.ts";

export interface HerdrConfigStoreShape {
  readonly config: HerdrConfig;
  readonly statePath: string;
  readonly loadProject: (
    key: string,
  ) => Effect.Effect<PersistedHerdrProject | undefined, HerdrStateError>;
  readonly saveProject: (
    project: PersistedHerdrProject,
    options?: { readonly removeRunIds?: ReadonlyArray<string> | undefined },
  ) => Effect.Effect<void, HerdrStateError>;
}

export class HerdrConfigStore extends Context.Service<HerdrConfigStore, HerdrConfigStoreShape>()(
  "pi-herdr/config/store/HerdrConfigStore",
) {
  static readonly layer = (options: { readonly cwd: string; readonly projectTrusted: boolean }) =>
    Layer.effect(
      this,
      Effect.gen(function* () {
        const documents = yield* JsonDocumentStore;
        const path = yield* Path.Path;
        const agentDirectory = yield* AgentDirectory;
        const globalPath = path.join(agentDirectory, "extensions", HERDR_CONFIG_BASENAME);
        const projectPath = path.join(
          options.cwd,
          CONFIG_DIR_NAME,
          "extensions",
          HERDR_CONFIG_BASENAME,
        );
        const statePath = path.join(agentDirectory, "herdr", HERDR_STATE_BASENAME);

        const configError = (operation: string, target: string) =>
          new HerdrConfigError({
            operation,
            path: target,
            message: `Unable to ${operation} pi-herdr configuration.`,
          });
        const stateError = (operation: string) =>
          new HerdrStateError({
            operation,
            path: statePath,
            message: `Unable to ${operation} pi-herdr ownership state.`,
          });

        const decodeConfig = (target: string, value: JsonObject | undefined) => {
          if (value === undefined) return Effect.succeed<Partial<HerdrConfig>>({});
          return Schema.decodeUnknownEffect(HerdrConfigFileSchema, {
            onExcessProperty: "error",
          })(value).pipe(
            Effect.map((decoded) => ({
              ...(decoded.enabled === undefined ? {} : { enabled: decoded.enabled }),
              ...(decoded.session === undefined ? {} : { session: decoded.session }),
              ...(decoded.pollIntervalMs === undefined
                ? {}
                : { pollIntervalMs: decoded.pollIntervalMs }),
              ...(decoded.showFooterStatus === undefined
                ? {}
                : { showFooterStatus: decoded.showFooterStatus }),
              ...(decoded.maxActive === undefined ? {} : { maxActive: decoded.maxActive }),
              ...(decoded.maxRetained === undefined ? {} : { maxRetained: decoded.maxRetained }),
            })),
            Effect.mapError(() => configError("decode", target)),
          );
        };

        const globalRaw = yield* documents
          .readObject(globalPath)
          .pipe(Effect.mapError(() => configError("read", globalPath)));
        const projectRaw = options.projectTrusted
          ? yield* documents
              .readObject(projectPath)
              .pipe(Effect.mapError(() => configError("read", projectPath)))
          : undefined;
        const global = yield* decodeConfig(globalPath, globalRaw);
        const project = yield* decodeConfig(projectPath, projectRaw);
        const config = normalizeHerdrConfig({ ...DEFAULT_HERDR_CONFIG, ...global, ...project });

        const decodeState = (
          document: JsonObject | undefined,
        ): Effect.Effect<HerdrStateDocument, HerdrStateError> => {
          if (document === undefined || Object.keys(document).length === 0)
            return Effect.succeed({ version: HERDR_STATE_VERSION, projects: [] });
          const current = Schema.decodeUnknownOption(HerdrStateDocumentSchema, {
            onExcessProperty: "error",
          })(document);
          if (Option.isSome(current)) return Effect.succeed(current.value);
          const legacy = Schema.decodeUnknownOption(LegacyHerdrStateDocumentSchema, {
            onExcessProperty: "error",
          })(document);
          if (Option.isSome(legacy))
            return Effect.succeed({
              version: HERDR_STATE_VERSION,
              projects: legacy.value.projects.map((project) => ({
                ...project,
                runs: project.runs.map((run) => ({ ...run, kind: "claude" as const })),
              })),
            });
          return Effect.fail(stateError("decode"));
        };

        const loadProject: HerdrConfigStoreShape["loadProject"] = (key) =>
          documents.readObject(statePath).pipe(
            Effect.mapError(() => stateError("read")),
            Effect.flatMap(decodeState),
            Effect.map((state) => state.projects.find((project) => project.key === key)),
          );

        const saveProject: HerdrConfigStoreShape["saveProject"] = (project, options) => {
          const modify = documents.modifyObject;
          if (!modify) return Effect.fail(stateError("update"));
          return modify(statePath, (document) =>
            decodeState(document).pipe(
              Effect.map((state) => {
                const existing = state.projects.find((entry) => entry.key === project.key);
                const mergedRuns = new Map(existing?.runs.map((run) => [run.id, run]) ?? []);
                for (const run of project.runs) {
                  const previous = mergedRuns.get(run.id);
                  if (!previous) {
                    mergedRuns.set(run.id, run);
                    continue;
                  }
                  if (previous.kind !== run.kind || previous.model !== run.model) continue;
                  if (previous.state === "stopped" && run.state !== "stopped") continue;
                  if (run.state === "stopped" && previous.state !== "stopped") {
                    mergedRuns.set(run.id, run);
                    continue;
                  }
                  const previousFinished = isHerdrAgentFinished(previous.state);
                  const incomingFinished = isHerdrAgentFinished(run.state);
                  if (
                    (incomingFinished && !previousFinished) ||
                    (incomingFinished === previousFinished && run.updatedAt >= previous.updatedAt)
                  )
                    mergedRuns.set(run.id, run);
                }
                for (const id of options?.removeRunIds ?? []) mergedRuns.delete(id);
                const mergedProject = { ...project, runs: [...mergedRuns.values()] };
                const projects = state.projects.filter((entry) => entry.key !== project.key);
                const next: JsonObject = {
                  version: HERDR_STATE_VERSION,
                  projects: [...projects, mergedProject],
                };
                return { value: undefined, document: next };
              }),
            ),
          ).pipe(Effect.mapError(() => stateError("update")));
        };

        return HerdrConfigStore.of({ config, statePath, loadProject, saveProject });
      }),
    );
}
