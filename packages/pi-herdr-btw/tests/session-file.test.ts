import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { afterAll, describe, expect } from "vitest";
import {
  BlankChildSessionFileResult,
  compareSessionFileIdentity,
  createBlankChildSessionFile,
  probeSessionHeader,
  SessionHeaderProbe,
} from "../src/boundary/session-file.ts";

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
const pathApi = nodePath;
const { sep } = nodePath;

const FIRST_TIMESTAMP = "2026-08-26T01:02:03.004Z";
const SECOND_TIMESTAMP = "2026-08-26T02:00:00.000Z";

const dir = mkdtempSync(pathApi.join(tmpdir(), "pi-herdr-btw-session-"));
afterAll(() => rmSync(dir, { force: true, recursive: true }));

const writeSession = (name: string, firstLine: string, rest = ""): string => {
  const path = pathApi.join(dir, name);
  writeFileSync(path, `${firstLine}\n${rest}`);
  return path;
};
const writeHeader = (name: string, id: string): string =>
  writeSession(name, JSON.stringify({ type: "session", id, timestamp: "t", cwd: "/project" }));

describe("session-file validation", () => {
  it("rejects missing files, directories, and symlinks", () => {
    const missing = pathApi.join(dir, "missing.jsonl");
    const nested = pathApi.join(dir, "a-directory");
    mkdirSync(nested);
    const target = writeHeader("symlink-target.jsonl", "linked-id");
    const link = pathApi.join(dir, "link.jsonl");
    symlinkSync(target, link);

    for (const path of [missing, nested, link]) {
      expect(probeSessionHeader(path)).toEqual(SessionHeaderProbe.invalid());
    }
  });
});

describe("session-file identity", () => {
  it("matches normalized lexical aliases and descriptor-identical hardlinks", () => {
    const original = writeHeader("identity-original.jsonl", "identity");
    const lexicalAlias = `${dir}${sep}.${sep}identity-original.jsonl`;
    const hardlink = pathApi.join(dir, "identity-hardlink.jsonl");
    linkSync(original, hardlink);

    expect(compareSessionFileIdentity(original, lexicalAlias)).toBe("same");
    expect(compareSessionFileIdentity(original, hardlink)).toBe("same");
  });

  it("compares the actual file when parent traversal follows a directory symlink", () => {
    const lexicalDirectory = pathApi.join(dir, "identity-lexical");
    const physicalDirectory = pathApi.join(dir, "identity-physical");
    const nestedDirectory = pathApi.join(physicalDirectory, "nested");
    mkdirSync(lexicalDirectory);
    mkdirSync(nestedDirectory, { recursive: true });
    const target = writeHeader("identity-physical/session.jsonl", "target-session");
    writeHeader("identity-lexical/session.jsonl", "different-session");
    const directoryAlias = pathApi.join(lexicalDirectory, "alias");
    symlinkSync(nestedDirectory, directoryAlias);
    const traversed = `${directoryAlias}${sep}..${sep}session.jsonl`;

    expect(probeSessionHeader(traversed)).toMatchObject(
      SessionHeaderProbe.valid({ header: { id: "target-session" } }),
    );
    expect(compareSessionFileIdentity(traversed, target)).toBe("same");
    expect(compareSessionFileIdentity(target, traversed)).toBe("same");
  });

  it("treats symlinks, missing files, and invalid paths as unavailable", () => {
    const target = writeHeader("identity-target.jsonl", "target");
    const symlink = pathApi.join(dir, "identity-symlink.jsonl");
    symlinkSync(target, symlink);
    const missing = pathApi.join(dir, "identity-missing.jsonl");

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

      expect(BlankChildSessionFileResult.$is("created")(result)).toBe(true);
      if (BlankChildSessionFileResult.$is("created")(result)) {
        expect(result.path).toContain("2026-08-26T01-02-03-004Z_blank-child-id.jsonl");
        expect(statSync(result.path).mode & 0o777).toBe(0o600);
        const header = readFileSync(result.path, "utf8").split("\n")[0] ?? "";
        expect(header).toContain(`"timestamp":"${FIRST_TIMESTAMP}"`);
        expect(header).toContain('"cwd":"/project"');
        expect(probeSessionHeader(result.path)).toEqual(
          SessionHeaderProbe.valid({ header: { id: "blank-child-id", parentSession: undefined } }),
        );
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
      expect(
        BlankChildSessionFileResult.$is("created")(yield* createBlankChildSessionFile(input)),
      ).toBe(true);
      expect(yield* createBlankChildSessionFile(input)).toEqual(
        BlankChildSessionFileResult.invalid(),
      );
      expect(
        yield* createBlankChildSessionFile({
          ...input,
          sessionDir: pathApi.join(dir, "missing-directory"),
        }),
      ).toEqual(BlankChildSessionFileResult.invalid());
      for (const sessionId of ["x/../escape", "a".repeat(129)])
        expect(yield* createBlankChildSessionFile({ ...input, sessionId })).toEqual(
          BlankChildSessionFileResult.invalid(),
        );
    }),
  );
});
