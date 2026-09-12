import { expect, it } from "vitest";
import {
  decodeOwnedFormRequest,
  decodeFormOutcome,
  decodeExtensionFormOwner,
  queryOwnedFormCapability,
  type OwnedFormCapability,
} from "../src/protocol.ts";
import { opaqueHostFixture } from "./support/host.ts";

it("bounds requests and answers before walking nested fields or invoking accessors", () => {
  let touched = false;
  expect(
    decodeOwnedFormRequest({
      get kind() {
        touched = true;
        return "form";
      },
    }),
  ).toBeUndefined();
  expect(touched).toBe(false);
  expect(
    decodeOwnedFormRequest({ kind: "form", message: "", fields: Array(100000).fill({}) }),
  ).toBeUndefined();
  expect(
    decodeOwnedFormRequest({
      kind: "form",
      message: "",
      fields: Array.from({ length: 17 }, (_, i) => ({ key: String(i), type: "boolean" })),
    }),
  ).toBeUndefined();
  expect(
    decodeOwnedFormRequest({ kind: "form", message: "x".repeat(4097), fields: [] }),
  ).toBeUndefined();
  expect(
    decodeOwnedFormRequest({ kind: "url", message: "", url: "x".repeat(8193) }),
  ).toBeUndefined();
  expect(
    decodeFormOutcome({
      action: "accept",
      content: Object.fromEntries(
        Array.from({ length: 16 }, (_, i) => [String(i), "é".repeat(4096)]),
      ),
    }),
  ).toBeUndefined();
  expect(
    decodeExtensionFormOwner({
      extensionId: "",
      operationId: "operation",
      requestId: "request",
      label: "MCP",
    }),
  ).toBeUndefined();
});

it("detaches defaults and accepts 64-option enums and empty confirmation forms", () => {
  const defaults = ["0"];
  const input = {
    kind: "form",
    message: "",
    fields: [
      {
        key: "items",
        type: "multi-enum",
        default: defaults,
        options: Array.from({ length: 64 }, (_, i) => ({ value: String(i), title: `Option ${i}` })),
      },
    ],
  };
  const decoded = decodeOwnedFormRequest(input);
  expect(
    decodeOwnedFormRequest({
      ...input,
      fields: Array.from({ length: 16 }, (_, index) => ({
        ...input.fields[0],
        key: String(index),
      })),
    }),
  ).toBeDefined();
  const trappedFields = new Proxy(input.fields, {
    get: () => {
      throw new Error("array getter must not run");
    },
  });
  expect(decodeOwnedFormRequest({ ...input, fields: trappedFields })).toEqual(decoded);
  defaults.push("1");
  expect(decoded?.kind === "form" && decoded.fields[0]?.default).toEqual(["0"]);
  expect(decodeOwnedFormRequest({ kind: "form", message: "Continue?", fields: [] })).toEqual({
    kind: "form",
    message: "Continue?",
    fields: [],
  });
  expect(
    decodeFormOutcome({ action: "accept", content: { zero: 0, no: false, empty: "", list: [] } }),
  ).toEqual({ action: "accept", content: { zero: 0, no: false, empty: "", list: [] } });
  expect(decodeFormOutcome({ action: "decline", content: { secret: "not returned" } })).toEqual({
    action: "decline",
  });
});

it("accepts exactly one synchronous provider and rejects duplicate, late or hostile replies", () => {
  const capability: OwnedFormCapability = {
    version: 1,
    sessionId: "session",
    generation: "one",
    ask: () => Promise.resolve({ action: "cancel" }),
    cancel: () => Promise.resolve(),
  };
  type Query = { respond: (value: OwnedFormCapability) => void };
  const discover = (emit: (query: Query) => void) =>
    queryOwnedFormCapability(
      opaqueHostFixture({ emit: (_name: string, query: Query) => emit(query) }),
      "session",
    );
  expect(discover((query) => query.respond(capability))).toEqual(capability);
  expect(
    discover((query) => {
      query.respond(capability);
      query.respond(capability);
    }),
  ).toBeUndefined();
  expect(
    discover((query) => {
      query.respond(capability);
      throw new Error("private");
    }),
  ).toBeUndefined();
  expect(
    discover((query) => {
      query.respond(capability);
      query.respond({
        ...capability,
        get ask(): OwnedFormCapability["ask"] {
          throw new Error("private");
        },
      });
    }),
  ).toBeUndefined();
  let late: Query | undefined;
  expect(
    discover((query) => {
      late = query;
    }),
  ).toBeUndefined();
  late?.respond(capability);
  let lateDuplicate: Query | undefined;
  const found = discover((query) => {
    query.respond(capability);
    lateDuplicate = query;
  });
  lateDuplicate?.respond(capability);
  expect(found).toEqual(capability);
});
