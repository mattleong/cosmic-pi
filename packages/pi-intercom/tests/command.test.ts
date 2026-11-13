import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { describe, expect, it } from "vitest";
import { listReport } from "../src/command.ts";
import { contractEnvelope, SESSION_TOOL, type SessionListContract } from "../src/tools/contract.ts";

const listing = (names: ReadonlyArray<string>): SessionListContract => ({
  ...contractEnvelope,
  tool: SESSION_TOOL.list,
  sessions: Arr.map(names, (name, index) => ({
    sessionId: `01a19957-0000-7000-8000-00000000000${index}`,
    name,
    cwd: `/work/${index}`,
    state: "idle",
    duplicate: false,
  })),
  omitted: 0,
});

const LONG_NAME = "checkout redesign review for the acme platform team and billing";

describe("/intercom list example", () => {
  const mentions = (names: ReadonlyArray<string>, word: string) =>
    Str.split(listReport(listing(names)), word).length - 1;

  it("names a listed session the user could type", () => {
    // Once in the list and once in the example.
    expect(mentions([LONG_NAME, "web work"], "web work")).toBe(2);
  });

  it("names no session rather than inventing one when no name fits", () => {
    // A name the list cuts appears only there, and the example makes up no session instead.
    expect(mentions([LONG_NAME], "checkout")).toBe(1);
    expect(mentions([LONG_NAME], "web")).toBe(0);
    expect(mentions([LONG_NAME, `${LONG_NAME} follow-up`], "checkout")).toBe(2);
  });
});
