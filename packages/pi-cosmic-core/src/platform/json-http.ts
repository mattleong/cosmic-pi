import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { JsonHttpError } from "./errors.ts";

export interface JsonHttpRequest {
  readonly url: string;
  readonly method?: "GET" | "POST";
  readonly headers?: Readonly<Record<string, string>>;
  readonly formBody?: Readonly<Record<string, string>>;
}

export interface JsonHttpResponse {
  readonly status: number;
  readonly body: unknown;
}

export interface JsonHttpClientShape {
  readonly request: (input: JsonHttpRequest) => Effect.Effect<JsonHttpResponse, JsonHttpError>;
}

export class JsonHttpClient extends Context.Service<JsonHttpClient, JsonHttpClientShape>()(
  "pi-cosmic-core/platform/json-http/JsonHttpClient",
) {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const request = Effect.fn("JsonHttpClient.request")(function* (input: JsonHttpRequest) {
        let outgoing =
          input.method === "POST"
            ? HttpClientRequest.post(input.url)
            : HttpClientRequest.get(input.url);
        if (input.headers) outgoing = HttpClientRequest.setHeaders(outgoing, input.headers);
        if (input.formBody) outgoing = HttpClientRequest.bodyUrlParams(outgoing, input.formBody);

        const response = yield* client.execute(outgoing).pipe(
          Effect.mapError(
            () =>
              new JsonHttpError({
                operation: "request",
                message: "HTTP request failed.",
              }),
          ),
        );
        const body = yield* response.json.pipe(
          Effect.mapError(
            () =>
              new JsonHttpError({
                operation: "decode",
                message: "HTTP response was not valid JSON.",
              }),
          ),
        );
        return { status: response.status, body };
      });
      return JsonHttpClient.of({ request });
    }),
  );
}
