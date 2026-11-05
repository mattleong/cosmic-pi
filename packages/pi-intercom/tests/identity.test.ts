import { describe, expect, it } from "@effect/vitest";
import * as Str from "effect/String";
import * as Arr from "effect/Array";
import {
  addresseeSubject,
  distinctSessionLabels,
  knownAddresseeSubject,
  sessionNameCache,
  sessionSubject,
} from "../src/identity.ts";

const cosmic = (sessionId: string) => ({ sessionId, cwd: "/Users/me/dev/cosmic-pi/" });

describe("session identity", () => {
  it("names a session by its name, then its directory, never by its full id", () => {
    expect(sessionSubject({ sessionId: "id-1", name: "web work", cwd: "/w/web" })).toBe("web work");
    const unnamed = sessionSubject(cosmic("01a19957-15d8-7047-8e3f-7bccf1353038"));
    expect(unnamed).toBe("cosmic-pi");
    const nowhere = sessionSubject({ sessionId: "01a19957-15d8-7047-8e3f-7bccf1353038", cwd: "" });
    expect(nowhere).not.toContain("01a19957");
  });

  it("adds the shortest distinguishing id only where listed sessions share a label", () => {
    const labels = distinctSessionLabels([
      cosmic("01a19957-15d8-7047-8e3f-7bccf1359038"),
      { sessionId: "01a19e61-2b7b-74a4-b983-b7dabe523478", cwd: "/Users/me/dev/dotfiles" },
      cosmic("01a1a535-9b8a-73fd-aa1f-8ea278e59038"),
    ]);
    expect(labels[1]).toBe("dotfiles");
    expect(labels[0]).not.toBe(labels[2]);
    for (const label of [labels[0], labels[2]]) {
      expect(Str.startsWith("cosmic-pi ")(label ?? "")).toBe(true);
      expect(label?.length).toBeLessThan("cosmic-pi ".length + 12);
    }
  });

  it("shortens a full session id an agent addressed, but keeps other addressees", () => {
    expect(addresseeSubject("01a19957-15d8-7047-8e3f-7bccf1353038")).not.toContain("01a19957");
    expect(addresseeSubject("web work")).toBe("web work");
  });

  it("names an addressee a result already named, and falls back to its id otherwise", () => {
    const id = "01a19957-15d8-7047-8e3f-7bccf1353038";
    const names = sessionNameCache();
    expect(knownAddresseeSubject(id, names)).toBe(addresseeSubject(id));
    names.remember([{ sessionId: id, name: "web work", cwd: "/w/web" }]);
    expect(knownAddresseeSubject(id, names)).toBe("web work");
    expect(knownAddresseeSubject(id, undefined)).toBe(addresseeSubject(id));
  });

  it("remembers a bounded number of sessions, forgetting the oldest first", () => {
    const names = sessionNameCache();
    const sessions = Arr.makeBy(300, (index) => ({ sessionId: `id-${index}`, cwd: `/w/${index}` }));
    names.remember(sessions);
    expect(names.lookup("id-0")).toBeUndefined();
    expect(names.lookup("id-299")?.cwd).toBe("/w/299");
  });
});
