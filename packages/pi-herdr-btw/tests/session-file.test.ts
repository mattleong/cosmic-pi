import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { afterAll, describe, expect } from "vitest";
import {
  compareSessionFileIdentity,
  createBlankChildSessionFile,
  probeSessionHeader,
} from "../src/boundary/session-file.ts";

// This suite intentionally exercises the raw-filesystem probe boundary, so it
// uses the same guarded builtin access as the boundary itself.
const nodeFs = process.getBuiltinModule("node:fs");
const nodeOs = process.getBuiltinModule("node:os");
const nodePath = process.getBuiltinModule("node:path");
if (!nodeFs || !nodeOs || !nodePath) throw new Error("Node builtins are unavailable.");
const {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} = nodeFs;
const { tmpdir } = nodeOs;
const { join, sep } = nodePath;

const PARENT_FILE = "/sessions/parent.jsonl";
const FIRST_TIMESTAMP = "2026-08-26T01:02:03.004Z";
const SECOND_TIMESTAMP = "2026-08-26T02:00:00.000Z";

const dir = mkdtempSync(join(tmpdir(), "pi-herdr-btw-session-"));
afterAll(() => rmSync(dir, { force: true, recursive: true }));

const writeSession = (name: string, firstLine: string, rest = ""): string => {
  const path = join(dir, name);
  writeFileSync(path, `${firstLine}\n${rest}`);
  return path;
};
const writeHeader = (name: string, id: string): string =>
  writeSession(name, JSON.stringify({ type: "session", id, timestamp: "t", cwd: "/project" }));

describe("session-file validation", () => {
  it("reads a valid header with id and parentSession", () => {
    const path = writeSession(
      "valid.jsonl",
      JSON.stringify({
        type: "session",
        version: 3,
        id: "child-id-1",
        timestamp: "2026-08-26T00:00:00.000Z",
        cwd: "/project",
        parentSession: PARENT_FILE,
      }),
      `${JSON.stringify({ type: "message", id: "m1", parentId: null })}\n`,
    );
    expect(probeSessionHeader(path)).toEqual({
      _tag: "valid",
      header: { id: "child-id-1", parentSession: PARENT_FILE },
    });
  });

  it("reads a root header without parentSession", () => {
    const path = writeHeader("root.jsonl", "root-id");
    expect(probeSessionHeader(path)).toEqual({
      _tag: "valid",
      header: { id: "root-id", parentSession: undefined },
    });
  });

  it("rejects missing files, directories, and symlinks", () => {
    const missing = join(dir, "missing.jsonl");
    const nested = join(dir, "a-directory");
    mkdirSync(nested);
    const target = writeHeader("symlink-target.jsonl", "linked-id");
    const link = join(dir, "link.jsonl");
    symlinkSync(target, link);

    for (const path of [missing, nested, link]) {
      expect(probeSessionHeader(path)).toEqual({ _tag: "invalid" });
    }
  });

  it("rejects malformed and non-session first lines", () => {
    expect(probeSessionHeader(writeSession("broken.jsonl", "{not json"))).toEqual({
      _tag: "invalid",
    });
    expect(
      probeSessionHeader(
        writeSession("wrong-type.jsonl", JSON.stringify({ type: "message", id: "x" })),
      ),
    ).toEqual({ _tag: "invalid" });
    expect(
      probeSessionHeader(writeSession("no-id.jsonl", JSON.stringify({ type: "session" }))),
    ).toEqual({ _tag: "invalid" });
  });

  it("rejects an unbounded first line instead of reading it fully", () => {
    const path = join(dir, "huge.jsonl");
    writeFileSync(path, `{"type":"session","id":"huge","pad":"${"x".repeat(300 * 1024)}"}\n`);
    expect(probeSessionHeader(path)).toEqual({ _tag: "invalid" });
  });

  it("rejects relative and control-character paths without touching the filesystem", () => {
    for (const path of ["relative/session.jsonl", `${dir}/bad\npath.jsonl`, ""]) {
      expect(probeSessionHeader(path)).toEqual({ _tag: "invalid" });
    }
  });
});

describe("session-file identity", () => {
  it("matches normalized lexical aliases and descriptor-identical hardlinks", () => {
    const original = writeHeader("identity-original.jsonl", "identity");
    const lexicalAlias = `${dir}${sep}.${sep}identity-original.jsonl`;
    const hardlink = join(dir, "identity-hardlink.jsonl");
    linkSync(original, hardlink);

    expect(compareSessionFileIdentity(original, lexicalAlias)).toBe("same");
    expect(compareSessionFileIdentity(original, hardlink)).toBe("same");
  });

  it("reports distinct only when both descriptor probes succeed", () => {
    const first = writeHeader("identity-first.jsonl", "first");
    const second = writeHeader("identity-second.jsonl", "second");

    expect(compareSessionFileIdentity(first, second)).toBe("distinct");
  });

  it("treats symlinks, missing files, and invalid paths as unavailable", () => {
    const target = writeHeader("identity-target.jsonl", "target");
    const symlink = join(dir, "identity-symlink.jsonl");
    symlinkSync(target, symlink);
    const missing = join(dir, "identity-missing.jsonl");

    for (const unavailable of [symlink, missing, "relative.jsonl", `${dir}/bad\npath`]) {
      expect(compareSessionFileIdentity(target, unavailable)).toBe("unavailable");
      expect(compareSessionFileIdentity(unavailable, unavailable)).toBe("unavailable");
    }
  });
});

describe("createBlankChildSessionFile", () => {
  it.effect("uses the Effect clock and creates a wx 0600 blank root session", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(FIRST_TIMESTAMP));
      const result = yield* createBlankChildSessionFile({
        sessionDir: dir,
        cwd: "/project",
        sessionId: "blank-child-id",
      });

      expect(result._tag).toBe("created");
      if (result._tag === "created") {
        expect(result.path).toContain("2026-08-26T01-02-03-004Z_blank-child-id.jsonl");
        expect(statSync(result.path).mode & 0o777).toBe(0o600);
        const header = readFileSync(result.path, "utf8").split("\n")[0] ?? "";
        expect(header).toContain(`"timestamp":"${FIRST_TIMESTAMP}"`);
        expect(header).toContain('"cwd":"/project"');
        expect(probeSessionHeader(result.path)).toEqual({
          _tag: "valid",
          header: { id: "blank-child-id", parentSession: undefined },
        });
      }
    }),
  );

  it.effect("fails closed on a collision, invalid directory, or malformed session ID", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(SECOND_TIMESTAMP));
      const input = {
        sessionDir: dir,
        cwd: "/project",
        sessionId: "collision-child-id",
      } as const;
      expect((yield* createBlankChildSessionFile(input))._tag).toBe("created");
      expect(yield* createBlankChildSessionFile(input)).toEqual({ _tag: "invalid" });
      expect(
        yield* createBlankChildSessionFile({
          ...input,
          sessionDir: join(dir, "missing-directory"),
        }),
      ).toEqual({ _tag: "invalid" });
      // The ID becomes a filename and an argv marker, so separator-bearing and overlong IDs fail
      // closed. Without the grammar check, "x/../escape" would normalize to a creatable file.
      for (const sessionId of ["x/../escape", "a".repeat(129)])
        expect(yield* createBlankChildSessionFile({ ...input, sessionId })).toEqual({
          _tag: "invalid",
        });
    }),
  );
});
