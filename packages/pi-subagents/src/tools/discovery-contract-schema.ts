/** Static route-discovery fields, composed with the shared orchestration envelope. */
import * as Schema from "effect/Schema";
import { SUBAGENT_EFFORTS } from "../domain/routing.ts";
import {
  MAX_PROFILE_CANDIDATES,
  MAX_PROFILE_MODEL_SELECTOR_CHARS,
  PROFILE_CANDIDATE_CONTEXTS,
  PROFILE_CANDIDATE_EFFORTS,
  PROFILE_CANDIDATE_HOSTS,
  PROFILE_CANDIDATE_RUNTIMES,
  PROFILE_CANDIDATE_WRITE_INTENTS,
  PROFILE_IDS,
  PROFILE_ROUTE_SOURCES,
} from "../profiles/model.ts";
import { NonEmptyText } from "./details-schema.ts";

export const MAX_DISCOVERY_TEXT_CHARS = 1_024;

export const ModelsContractFields = {
  fallbackProfile: Schema.Literals(PROFILE_IDS),
  profiles: Schema.Array(
    Schema.Struct({
      id: Schema.Literals(PROFILE_IDS),
      description: NonEmptyText(MAX_DISCOVERY_TEXT_CHARS),
      source: Schema.Literals(PROFILE_ROUTE_SOURCES),
      isDefault: Schema.Boolean,
      defaultContext: Schema.Literals(PROFILE_CANDIDATE_CONTEXTS),
      defaultWriteIntent: Schema.Literals(PROFILE_CANDIDATE_WRITE_INTENTS),
      defaultEffort: Schema.optionalKey(Schema.Literals(SUBAGENT_EFFORTS)),
      /** Declared order, including statically skipped candidates; not launch readiness. */
      candidates: Schema.Array(
        Schema.Struct({
          host: Schema.Literals(PROFILE_CANDIDATE_HOSTS),
          runtime: Schema.Literals(PROFILE_CANDIDATE_RUNTIMES),
          model: NonEmptyText(MAX_PROFILE_MODEL_SELECTOR_CHARS),
          effort: Schema.Literals(PROFILE_CANDIDATE_EFFORTS),
          context: Schema.Literals(PROFILE_CANDIDATE_CONTEXTS),
          writeIntent: Schema.Literals(PROFILE_CANDIDATE_WRITE_INTENTS),
          openaiFastMode: Schema.Boolean,
          closeOnReport: Schema.Boolean,
          status: Schema.Literals(["eligible", "skipped"]),
          reason: NonEmptyText(MAX_DISCOVERY_TEXT_CHARS),
        }),
      ).check(Schema.isMaxLength(MAX_PROFILE_CANDIDATES)),
    }),
  ).check(Schema.isMaxLength(PROFILE_IDS.length)),
};
