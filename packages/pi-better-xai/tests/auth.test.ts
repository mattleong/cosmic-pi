import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { provideBuiltLayer } from "pi-cosmic-core";
import { extractTeamIdFromJwt, getXaiCredentials } from "../src/auth/auth.ts";
import { registryLayer, serializedSnapshot } from "./support/fixtures.ts";

type JwtFixturePayload = { readonly team_id?: string | number };

const jwtPayload = (value: JwtFixturePayload) => {
  const payload = Buffer.from(JSON.stringify(value)).toString("base64url");
  return `header.${payload}.signature`;
};
const jwt = (teamId: string) => jwtPayload({ team_id: teamId });

const credentialsFrom = (token?: string | Error) =>
  getXaiCredentials().pipe(provideBuiltLayer(registryLayer(token)));

describe("xAI authentication", () => {
  it("extracts trimmed team metadata and ignores invalid, missing, or blank claims", () => {
    const invalidJson = `header.${Buffer.from("{").toString("base64url")}.signature`;
    for (const token of [
      "not-a-jwt",
      "header.!!!!.signature",
      invalidJson,
      jwtPayload({}),
      jwtPayload({ team_id: 42 }),
      jwt("  \t  "),
    ])
      expect(extractTeamIdFromJwt(token)).toBeUndefined();
    expect(extractTeamIdFromJwt(jwt("  team-owned  "))).toBe("team-owned");
  });

  it.effect("resolves a trimmed registry key into redacted credentials with team metadata", () =>
    Effect.gen(function* () {
      const token = jwt("team-owned");
      const credentials = yield* credentialsFrom(`  ${token}\n`);
      expect(credentials && Redacted.value(credentials.accessToken)).toBe(token);
      expect(credentials?.teamId).toBe("team-owned");
      expect(serializedSnapshot(credentials)).not.toContain(token);
      for (const missing of [undefined, "", "  \t "])
        expect(yield* credentialsFrom(missing)).toBeUndefined();
    }),
  );

  it.effect("fails a rejected registry lookup with a fixed, sanitized message", () =>
    Effect.gen(function* () {
      const rejection = new Error("refresh failed for xai-secret-token: error_description");
      const failure = yield* credentialsFrom(rejection).pipe(Effect.flip);
      expect(failure.message).toBe("Unable to read xAI credentials.");
      expect(serializedSnapshot(failure)).not.toMatch(/xai-secret-token|error_description/);
    }),
  );
});
