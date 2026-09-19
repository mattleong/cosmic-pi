import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  decodeCredentialRecord,
  encodeCredentialRecord,
} from "../../src/auth/credential-record.ts";
import {
  decodeGrant,
  encodeGrant,
  maximumGrantBytes,
  type McpGrant,
} from "../../src/auth/credentials.ts";

const serialize = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const grant: McpGrant = {
  version: 1,
  identity: "a".repeat(64),
  issuer: "https://issuer.example",
  resource: "https://resource.example/mcp",
  clientId: "public",
  registration: "dynamic",
  redirectUri: "http://127.0.0.1:9000/callback",
  discovery: {},
  resourceMetadata: {},
  clientInformation: { client_id: "public" },
  tokens: { access_token: "private-access", refresh_token: "private-refresh" },
  receivedAt: 0,
};
const registration = {
  identity: grant.identity,
  issuer: grant.issuer,
  resource: grant.resource,
  registration: "dynamic" as const,
  redirectUri: grant.redirectUri,
  clientInformation: grant.clientInformation,
  scopes: ["read"],
};

it.effect("reads legacy grants and preserves durable quarantine and requested permissions", () =>
  Effect.gen(function* () {
    const raw = yield* encodeGrant(grant);
    expect(yield* decodeCredentialRecord(raw)).toEqual({ version: 2, grant });
    const marked = { ...grant, quarantine: "refresh" as const, requestedScopes: ["read", "write"] };
    expect(yield* decodeGrant(yield* encodeGrant(marked))).toEqual(marked);
    const record = { version: 2 as const, grant: marked, registration };
    expect(yield* decodeCredentialRecord(yield* encodeCredentialRecord(record))).toEqual(record);
    const checkpoint = { version: 2 as const, registration };
    expect(yield* decodeCredentialRecord(yield* encodeCredentialRecord(checkpoint))).toEqual(
      checkpoint,
    );
  }),
);

it.effect("bounds the entire credential envelope and redacts malformed records", () =>
  Effect.gen(function* () {
    const rejected = yield* decodeGrant('{"version":99,"secret":"private-token"}').pipe(
      Effect.flip,
    );
    expect(rejected.kind).toBe("unavailable");
    expect(serialize(rejected)).not.toContain("private-token");
    const part = "private-secret".repeat(Math.ceil(maximumGrantBytes / 24));
    const oversized = {
      version: 2 as const,
      grant: { ...grant, discovery: part },
      registration: { ...registration, clientInformation: part },
    };
    expect((yield* encodeCredentialRecord(oversized).pipe(Effect.result))._tag).toBe("Failure");
    for (const raw of [
      serialize(oversized),
      serialize({ version: 2, grant: { ...grant, expiresAt: -1 } }),
      serialize({ version: 2, grant, unexpected: "private-secret" }),
      serialize({ ...grant, quarantine: "private-secret" }),
    ]) {
      const error = yield* decodeCredentialRecord(raw).pipe(Effect.flip);
      expect(error.kind).toBe("unavailable");
      expect(serialize(error)).not.toContain("private-secret");
    }
  }),
);
