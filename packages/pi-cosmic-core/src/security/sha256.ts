import * as Hex from "effect/encoding/Hex";
import * as Sha256 from "fast-sha256";

const utf8 = new TextEncoder();

/** Pure SHA-256 over UTF-8, retaining persistent identities without introducing an async gap. */
export const sha256Text = (value: string): string => Hex.encode(Sha256.hash(utf8.encode(value)));
