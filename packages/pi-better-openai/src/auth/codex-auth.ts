import * as Predicate from "effect/Predicate";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { decodeJwtPayloadText, readSchemaDocument } from "pi-cosmic-core";

const CodexAuthDocumentSchema = Schema.Struct({
  "openai-codex": Schema.optional(Schema.Unknown),
});
const redactedAccessToken = Schema.RedactedFromValue(Schema.Trim.check(Schema.isMinLength(1)), {
  label: "OpenAI Codex access token",
});
const CodexAuthEntrySchema = Schema.Struct({
  type: Schema.Literal("oauth"),
  access: redactedAccessToken,
  accountId: Schema.optional(Schema.NullOr(Schema.String)),
  account_id: Schema.optional(Schema.NullOr(Schema.String)),
  expires: Schema.optional(Schema.NullOr(Schema.Number.check(Schema.isFinite()))),
});
const RegistryCredentialsSchema = Schema.Struct({
  access: Schema.optional(redactedAccessToken),
  token: Schema.optional(redactedAccessToken),
  accountId: Schema.optional(Schema.String),
  account_id: Schema.optional(Schema.String),
});
const JwtPayloadSchema = Schema.Struct({
  "https://api.openai.com/auth": Schema.optional(
    Schema.Struct({ chatgpt_account_id: Schema.optional(Schema.String) }),
  ),
});
const RegistryCredentialsFromJsonSchema = Schema.fromJsonString(RegistryCredentialsSchema);
const JwtPayloadFromJsonSchema = Schema.fromJsonString(JwtPayloadSchema);
const decodeJwtPayload = Option.liftThrowable(decodeJwtPayloadText);

export class CodexAuthError extends Schema.TaggedError<CodexAuthError>()("CodexAuthError", {
  operation: Schema.String,
  message: Schema.String,
}) {}
export type CodexCredentials = {
  readonly accessToken: Redacted.Redacted<string>;
  readonly accountId: string;
};

const redactAccessToken = (value: string): Redacted.Redacted<string> =>
  Redacted.make(value, { label: "OpenAI Codex access token" });
export type CodexCredentialsWithSource = CodexCredentials & {
  readonly source: "modelRegistry" | "authFile";
};
export function extractAccountIdFromJwt(token: string): string | undefined {
  const source = Option.getOrUndefined(decodeJwtPayload(token));
  if (!source) return undefined;
  const decoded = Option.getOrUndefined(
    Schema.decodeUnknownOption(JwtPayloadFromJsonSchema)(source),
  );
  return decoded?.["https://api.openai.com/auth"]?.chatgpt_account_id?.trim() || undefined;
}
export function parseCodexRegistryCredentials(
  raw: string | undefined,
): CodexCredentials | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  const parsed = Option.getOrUndefined(
    Schema.decodeUnknownOption(RegistryCredentialsFromJsonSchema)(value),
  );
  if (parsed) {
    const accessToken = parsed.access ?? parsed.token;
    const accountId = (parsed.accountId ?? parsed.account_id)?.trim();
    if (accessToken && accountId) return { accessToken, accountId };
  }
  const accountId = extractAccountIdFromJwt(value);
  return accountId ? { accessToken: redactAccessToken(value), accountId } : undefined;
}

export const readCodexAuthCredentials = Effect.fn("CodexAuth.readAuthCredentials")(function* (
  authPath: string,
) {
  const document = yield* readSchemaDocument(authPath, CodexAuthDocumentSchema).pipe(
    Effect.mapError(
      () =>
        new CodexAuthError({
          operation: "read",
          message: "Unable to read openai-codex credentials.",
        }),
    ),
  );
  const rawEntry = document?.value["openai-codex"];
  if (rawEntry === undefined) return undefined;
  const entry = Option.getOrUndefined(Schema.decodeUnknownOption(CodexAuthEntrySchema)(rawEntry));
  if (!entry)
    return yield* new CodexAuthError({
      operation: "decode",
      message: "OpenAI credential fields are malformed.",
    });
  const now = yield* Clock.currentTimeMillis;
  if (Predicate.isNumber(entry.expires) && now >= entry.expires) return undefined;
  const accessToken = entry.access;
  const accountId = (entry.accountId ?? entry.account_id)?.trim();
  if (!accountId)
    return yield* new CodexAuthError({
      operation: "decode",
      message: "OpenAI credential fields are malformed.",
    });
  return { accessToken, accountId, source: "authFile" as const };
});

export const readCodexRegistryCredentials = Effect.fn("CodexAuth.readRegistryCredentials")(
  function* (ctx: Pick<ExtensionContext, "modelRegistry">) {
    const raw = yield* Effect.tryPromise({
      try: () => ctx.modelRegistry.getApiKeyForProvider("openai-codex"),
      catch: () =>
        new CodexAuthError({
          operation: "registry",
          message: "Unable to read openai-codex credentials.",
        }),
    });
    const credentials = parseCodexRegistryCredentials(Predicate.isString(raw) ? raw : undefined);
    if (credentials) return { ...credentials, source: "modelRegistry" as const };
    if (raw)
      return yield* new CodexAuthError({
        operation: "registry-decode",
        message: "OpenAI registry credentials are malformed.",
      });
    return undefined;
  },
);

export const getCodexCredentials = Effect.fn("CodexAuth.getCredentials")(function* (
  authPath: string,
  ctx: Pick<ExtensionContext, "modelRegistry">,
) {
  const [fileAttempt, registryAttempt] = yield* Effect.all(
    [
      readCodexAuthCredentials(authPath).pipe(Effect.result),
      readCodexRegistryCredentials(ctx).pipe(Effect.result),
    ] as const,
    { concurrency: 2 },
  );

  // Deliberate precedence: valid registry credentials win, then valid file credentials.
  // A malformed non-empty registry value wins the failure tie. Otherwise the file failure
  // wins before a registry read failure. Change this order only with intent.
  if (registryAttempt._tag === "Success" && registryAttempt.success !== undefined)
    return registryAttempt.success;
  if (fileAttempt._tag === "Success" && fileAttempt.success !== undefined)
    return fileAttempt.success;
  if (registryAttempt._tag === "Failure" && registryAttempt.failure.operation === "registry-decode")
    return yield* registryAttempt.failure;
  if (fileAttempt._tag === "Failure") return yield* fileAttempt.failure;
  if (registryAttempt._tag === "Failure") return yield* registryAttempt.failure;
  return undefined;
});
