import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { decodeUnknownOrUndefined } from "../src/schema/decode.ts";
import {
  makeSessionCapabilityProtocol,
  querySessionCapability,
} from "../src/session-capability.ts";

const protocol = makeSessionCapabilityProtocol({ version: 1, maxSessionIdChars: 8 });
const hostile = new Proxy(
  {},
  {
    get: () => {
      throw new Error("hostile getter");
    },
  },
);

describe("decodeUnknownOrUndefined", () => {
  it("returns decoded values and fails closed on mismatches and hostile input", () => {
    const Point = Schema.Struct({ x: Schema.Number });
    expect(decodeUnknownOrUndefined(Point, { x: 1 })).toEqual({ x: 1 });
    expect(decodeUnknownOrUndefined(Point, { x: "1" })).toBeUndefined();
    expect(decodeUnknownOrUndefined(Point, hostile)).toBeUndefined();
  });

  it("applies explicit strict decoder policy without changing tolerant defaults", () => {
    const Point = Schema.Struct({ x: Schema.Number });
    const value = { x: 1, credential: "unexpected" };
    expect(decodeUnknownOrUndefined(Point, value)).toEqual({ x: 1 });
    expect(decodeUnknownOrUndefined(Point, value, { onExcessProperty: "error" })).toBeUndefined();
  });
});

describe("session capability queries", () => {
  it("accepts only the protocol version, a bounded non-empty session id, and a function", () => {
    const respond = () => undefined;
    expect(protocol.normalizeQuery({ version: 1, sessionId: "session", respond })).toMatchObject({
      version: 1,
      sessionId: "session",
    });
    for (const query of [
      { version: 2, sessionId: "session", respond },
      { version: 1, sessionId: "", respond },
      { version: 1, sessionId: "123456789", respond },
      { version: 1, sessionId: "session", respond: "not a function" },
      hostile,
    ])
      expect(protocol.normalizeQuery(query)).toBeUndefined();
    const unbounded = makeSessionCapabilityProtocol({ version: 1 });
    expect(
      unbounded.normalizeQuery({ version: 1, sessionId: "x".repeat(4096), respond }),
    ).toBeDefined();
  });

  it("contains a throwing or rejecting responder", () => {
    // An uncontained rejection would fail the run as an unhandled rejection.
    for (const respond of [
      () => {
        throw new Error("hostile respond");
      },
      () => Promise.reject(new Error("hostile rejection")),
    ]) {
      const query = protocol.normalizeQuery({ version: 1, sessionId: "session", respond });
      expect(() => query?.respond("capability")).not.toThrow();
    }
  });

  it("decodes a capability envelope only when execute is a function", () => {
    const execute = () => Promise.resolve();
    expect(protocol.decodeCapability({ version: 1, sessionId: "session", execute })).toEqual({
      version: 1,
      sessionId: "session",
      execute,
    });
    expect(protocol.decodeCapability({ version: 1, sessionId: "session" })).toBeUndefined();
  });
});

describe("session capability discovery", () => {
  type Respond = (candidate: string) => void;
  const discover = (emit: (respond: Respond) => void, limit?: number) => {
    let late: Respond | undefined;
    const result = querySessionCapability(
      {
        emit: (_channel, query) => {
          late = query.respond;
          emit(late);
        },
      },
      "query",
      { version: 1, sessionId: "session" },
      (candidate: string) => {
        if (candidate === "throw") throw new Error("hostile candidate");
        return candidate === "invalid" ? undefined : candidate;
      },
      limit,
    );
    late?.("late");
    return result;
  };

  it("keeps accepted candidates in order until emit returns or the limit is reached", () => {
    const all = (respond: Respond) => ["a", "invalid", "b", "c"].forEach(respond);
    expect(discover(all)).toEqual({ candidates: ["a", "b", "c"], failed: false });
    expect(discover(all, 2)).toEqual({ candidates: ["a", "b"], failed: false });
  });

  it("marks a throwing emit or accept failed without discarding earlier candidates", () => {
    expect(
      discover((respond) => {
        respond("a");
        respond("throw");
      }),
    ).toEqual({ candidates: ["a"], failed: true });
    expect(
      discover((respond) => {
        respond("a");
        throw new Error("hostile emit");
      }),
    ).toEqual({ candidates: ["a"], failed: true });
  });
});
