import * as HttpClient from "effect/unstable/http/HttpClient";

const Raw = HttpClient;
export const leaked = Raw.layer;
