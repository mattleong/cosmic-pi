import { describe, expect, it } from "@effect/vitest";
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

const inertResponder = () => undefined;

describe("session capability queries", () => {
  it("accepts only the protocol version, a bounded non-empty session id, and a function", () => {
    expect(
      protocol.normalizeQuery({ version: 1, sessionId: "session", respond: inertResponder }),
    ).toMatchObject({
      version: 1,
      sessionId: "session",
    });
    for (const query of [
      { version: 2, sessionId: "session", respond: inertResponder },
      { version: 1, sessionId: "", respond: inertResponder },
      { version: 1, sessionId: "123456789", respond: inertResponder },
      { version: 1, sessionId: "session", respond: "not a function" },
      hostile,
    ])
      expect(protocol.normalizeQuery(query)).toBeUndefined();
    const unbounded = makeSessionCapabilityProtocol({ version: 1 });
    expect(
      unbounded.normalizeQuery({
        version: 1,
        sessionId: "x".repeat(4096),
        respond: inertResponder,
      }),
    ).toBeDefined();
  });
});

type Respond = (candidate: string) => void;
const all = (deliver: Respond) => ["a", "invalid", "b", "c"].forEach(deliver);

describe("session capability discovery", () => {
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
    expect(discover(all)).toEqual({ candidates: ["a", "b", "c"], failed: false });
    expect(discover(all, 2)).toEqual({ candidates: ["a", "b"], failed: false });
  });
});
