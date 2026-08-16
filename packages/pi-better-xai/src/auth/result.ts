import * as Schema from "effect/Schema";

export const PositiveIntegerSchema = Schema.Number.check(
  Schema.isFinite(),
  Schema.isInt(),
  Schema.isGreaterThan(0),
);

export interface XaiAuthResultCredentials {
  readonly accessToken: string;
  readonly refreshToken?: string | undefined;
  readonly expires?: number | undefined;
  readonly teamId?: string | undefined;
  readonly source: "modelRegistry" | "authFile";
}

/** Internally constructed auth outcome; unknown auth documents are decoded before this point. */
export type XaiAuthResult =
  | { readonly _tag: "Found"; readonly credentials: XaiAuthResultCredentials }
  | { readonly _tag: "Missing" }
  | { readonly _tag: "Unavailable"; readonly operation: string; readonly message: string }
  | { readonly _tag: "Malformed"; readonly operation: string; readonly message: string };
