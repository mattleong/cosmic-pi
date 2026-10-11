import * as Hex from "effect/encoding/Hex";
import * as Sha256 from "fast-sha256";

const utf8 = new TextEncoder();

export const sha256Text = (value: string): string => Hex.encode(Sha256.hash(utf8.encode(value)));
