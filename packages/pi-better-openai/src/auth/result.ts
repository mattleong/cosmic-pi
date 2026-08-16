import type * as Redacted from "effect/Redacted";

export type CodexAuthResult =
  | {
      readonly _tag: "Found";
      readonly credentials: {
        readonly accessToken: Redacted.Redacted<string>;
        readonly accountId: string;
        readonly source: "modelRegistry" | "authFile";
      };
    }
  | { readonly _tag: "Missing" }
  | {
      readonly _tag: "Unavailable" | "Malformed";
      readonly operation: string;
      readonly message: string;
    };
