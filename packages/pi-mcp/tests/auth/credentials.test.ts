import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  decodeCredentialRecord,
  encodeCredentialRecord,
} from "../../src/auth/credential-record.ts";
import { maximumGrantBytes } from "../../src/auth/credentials.ts";
import { testGrant, testRegistration } from "../fixtures/auth.ts";

const serialize = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const grant = testGrant("a".repeat(64));
const registration = testRegistration(grant);

it.effect("reads legacy grants and preserves durable quarantine and requested permissions", () =>
  Effect.gen(function* () {
    expect(yield* decodeCredentialRecord(serialize(grant))).toEqual({ version: 2, grant });
    const marked = { ...grant, quarantine: "refresh" as const, requestedScopes: ["read", "write"] };
    expect(yield* decodeCredentialRecord(serialize(marked))).toEqual({ version: 2, grant: marked });
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
    const part = "private-secret".repeat(Math.ceil(maximumGrantBytes / 24));
    const oversized = {
      version: 2 as const,
      grant: { ...grant, discovery: part },
      registration: { ...registration, clientInformation: part },
    };
    expect(yield* encodeCredentialRecord(oversized).pipe(Effect.isFailure)).toBe(true);
    for (const raw of [
      '{"version":99,"secret":"private-secret"}',
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
