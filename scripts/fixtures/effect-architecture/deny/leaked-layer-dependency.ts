import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";

declare const adapterLayer: Layer.Layer<never, never, HttpClient.HttpClient>;
declare const rawHttpLayer: Layer.Layer<HttpClient.HttpClient>;
export const leaked = Layer.merge(adapterLayer, rawHttpLayer);
