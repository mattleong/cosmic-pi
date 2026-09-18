import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { McpGatewayReplySchema } from "../../src/tools/model.ts";
import { mcpFailureReply } from "../../src/boundary/host-tool-result.ts";
import { decodeGatewayRequest } from "../../src/invocation/validation.ts";

it.effect("repairs rejected status arguments without exposing supplied values", () =>
  Effect.gen(function* () {
    const failure = yield* decodeGatewayRequest({
      action: "status",
      server: "PRIVATE_SERVER",
      PRIVATE_PROPERTY: "PRIVATE_TOKEN",
    }).pipe(Effect.flip);
    const reply = mcpFailureReply("status", failure);
    expect(reply).toMatchObject({
      outcome: "not-sent",
      isError: true,
      data: { reason: "gateway-request-invalid" },
    });
    const serialized = yield* Schema.encodeEffect(Schema.fromJsonString(McpGatewayReplySchema))(
      reply,
    );
    expect(serialized).toContain("server");
    expect(serialized).toContain("Remove");
    expect(serialized).not.toContain("PRIVATE_");
    expect(yield* decodeGatewayRequest({ action: "status" })).toEqual({ action: "status" });
  }),
);

it.effect("gives the selected action's contract rather than credential recovery", () =>
  Effect.gen(function* () {
    const failure = yield* decodeGatewayRequest({
      action: "result.read",
      server: "PRIVATE_SERVER",
      offset: -1,
    }).pipe(Effect.flip);
    const reply = mcpFailureReply("result.read", failure);
    const serialized = yield* Schema.encodeEffect(Schema.fromJsonString(McpGatewayReplySchema))(
      reply,
    );
    expect(serialized).toContain("requires id");
    expect(serialized).toContain("nonnegative");
    expect(serialized).not.toContain("PRIVATE_");
    expect(serialized).not.toContain("sign-in");
    expect(
      yield* decodeGatewayRequest({ action: "result.read", id: "result-1", offset: 0 }),
    ).toMatchObject({ action: "result.read", id: "result-1" });
  }),
);

it.effect("does not label unsafe or oversized input as a diagnosed field error", () =>
  Effect.gen(function* () {
    let accessed = false;
    const input = Object.defineProperty({}, "action", {
      enumerable: true,
      get: () => {
        accessed = true;
        return "status";
      },
    });
    const failure = yield* decodeGatewayRequest(input).pipe(Effect.flip);
    expect(failure.reason).toBeUndefined();
    expect(accessed).toBe(false);
    const unknown = yield* decodeGatewayRequest({ action: "PRIVATE_ACTION" }).pipe(Effect.flip);
    const serialized = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))(
      mcpFailureReply("PRIVATE_ACTION", unknown).data,
    );
    expect(serialized).not.toContain("PRIVATE_");
  }),
);
