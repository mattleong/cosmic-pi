import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { expect } from "vitest";
import { normalizePublicClient, restorePublicClient } from "../../src/boundary/sdk-auth-client.ts";
import { mcpFailureReply } from "../../src/boundary/host-tool-result.ts";

const serialize = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
type ClientRegistration = {
  client_id: string;
  token_endpoint_auth_method?: string;
  client_secret?: string;
};
const clientRegistration = (method?: string, secret?: string) => {
  const client: ClientRegistration = { client_id: "private-client-id" };
  if (method !== undefined) client.token_endpoint_auth_method = method;
  if (secret !== undefined) client.client_secret = secret;
  return client;
};

for (const method of [undefined, "none"] as const)
  it.effect(`normalizes a secretless public client with method ${method}`, () =>
    Effect.gen(function* () {
      const client = clientRegistration(method);
      for (const normalized of [
        yield* normalizePublicClient(client),
        yield* restorePublicClient(client),
      ]) {
        expect(normalized.client_id).toBe(client.client_id);
        expect(normalized.token_endpoint_auth_method).toBe("none");
        expect(normalized).not.toHaveProperty("client_secret");
      }
    }),
  );

it.effect(
  "drops surplus secret material only for an explicitly public client without mutating its input",
  () =>
    Effect.gen(function* () {
      const client = Object.freeze({
        client_id: "fixture-client",
        token_endpoint_auth_method: "none",
        client_secret: "private-unused-secret",
        client_secret_expires_at: 123,
      });
      for (const normalized of [
        yield* normalizePublicClient(client),
        yield* restorePublicClient(client),
      ]) {
        expect(normalized.token_endpoint_auth_method).toBe("none");
        expect(normalized).not.toHaveProperty("client_secret");
        expect(normalized).not.toHaveProperty("client_secret_expires_at");
        expect(yield* serialize(normalized)).not.toContain("private-unused-secret");
      }
      expect(client.client_secret).toBe("private-unused-secret");
    }),
);

for (const method of [
  undefined,
  "client_secret_basic",
  "client_secret_post",
  "private_key_jwt",
  "unknown-provider-method",
  "",
])
  for (const secret of [undefined, "private-rejected-secret"])
    if (method !== undefined || secret !== undefined)
      it.effect(
        `rejects ambiguous or non-public clients: method=${method}, secret=${secret !== undefined}`,
        () =>
          Effect.gen(function* () {
            const client = clientRegistration(method, secret);
            for (const operation of [normalizePublicClient(client), restorePublicClient(client)]) {
              const failure = yield* operation.pipe(Effect.flip);
              expect(failure).toMatchObject({
                kind: "unsupported",
                outcome: "not-sent",
                reason:
                  method === undefined
                    ? "oauth-client-auth-method-ambiguous"
                    : "oauth-client-auth-method-unsupported",
              });
              const reply = mcpFailureReply("auth", failure);
              expect(yield* serialize(reply)).not.toMatch(
                /private-client-id|private-rejected-secret|unknown-provider-method/,
              );
            }
          }),
      );

it.effect("rejects malformed stored auth methods rather than dropping them", () =>
  Effect.gen(function* () {
    for (const method of [null, 42, {}])
      expect(
        yield* restorePublicClient({
          client_id: "fixture-client",
          token_endpoint_auth_method: method,
        }).pipe(Effect.flip),
      ).toMatchObject({ kind: "denied", reason: "oauth-binding-rejected" });
  }),
);
