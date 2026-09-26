import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { extractJwtClaim } from "pi-cosmic-core";
import { ModelRegistryAuth } from "../boundary/model-registry-auth.ts";

const JwtPayloadFromJsonSchema = Schema.fromJsonString(
  Schema.Struct({ team_id: Schema.optional(Schema.String) }),
);

export interface XaiCredentials {
  readonly accessToken: Redacted.Redacted<string>;
  readonly teamId: string | undefined;
}

export function extractTeamIdFromJwt(token: string): string | undefined {
  return extractJwtClaim(token, JwtPayloadFromJsonSchema)?.team_id?.trim() || undefined;
}

/** Resolves xAI credentials through Pi's model registry, which owns refresh and persistence. */
export const getXaiCredentials = Effect.fn("XaiAuth.getXaiCredentials")(function* () {
  const token = yield* ModelRegistryAuth.use((registry) => registry.getApiKey);
  if (token === undefined) return undefined;
  const credentials: XaiCredentials = {
    accessToken: Redacted.make(token, { label: "xAI access token" }),
    teamId: extractTeamIdFromJwt(token),
  };
  return credentials;
});
