import * as HttpClient from "effect/unstable/http/HttpClient";

const RawLayer = HttpClient.layer;
export { RawLayer as leaked };
