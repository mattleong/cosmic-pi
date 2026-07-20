import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

declare const request: HttpClientRequest.HttpClientRequest;
HttpClientRequest.bodyJsonUnsafe(request, { value: 1 });
