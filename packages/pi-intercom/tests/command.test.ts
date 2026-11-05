import * as Arr from "effect/Array";
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
  it("names a listed session the user could type", () => {
    expect(listReport(listing([LONG_NAME, "web work"]))).toContain(
      '"Ask the web work session to run its tests"',
    );
  });

  it("points at the list rather than inventing a session when no name fits", () => {
    const one = listReport(listing([LONG_NAME]));
    expect(one).toContain("the session listed above");
    expect(one).not.toContain("the web session");
    expect(listReport(listing([LONG_NAME, `${LONG_NAME} follow-up`]))).toContain(
      "one of the sessions above",
    );
  });
});
