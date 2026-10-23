import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { nodeFs, nodePath } from "pi-cosmic-core";
import { temporaryDirectory } from "pi-cosmic-core/testing";
import { describe, expect } from "vitest";
import {
  BlankChildSessionFileResult,
  compareSessionFileIdentity,
  createBlankChildSessionFile,
  probeSessionHeader,
  SessionHeaderProbe,
} from "../src/boundary/session-file.ts";

const FIRST_TIMESTAMP = "2026-08-26T01:02:03.004Z";
const SECOND_TIMESTAMP = "2026-08-26T02:00:00.000Z";
const { sep } = nodePath;

const sessionDirectory = temporaryDirectory("pi-herdr-btw-session-");

const writeSession = (dir: string, name: string, firstLine: string, rest = ""): string => {
  const path = nodePath.join(dir, name);
  nodeFs.writeFileSync(path, `${firstLine}\n${rest}`);
  return path;
};
const writeHeader = (dir: string, name: string, id: string): string =>
  writeSession(dir, name, JSON.stringify({ type: "session", id, timestamp: "t", cwd: "/project" }));

describe("session-file validation", () => {
  it.effect("rejects missing files, directories, and symlinks", () =>
    Effect.gen(function* () {
      const dir = yield* sessionDirectory;
      const missing = nodePath.join(dir, "missing.jsonl");
      const nested = nodePath.join(dir, "a-directory");
      nodeFs.mkdirSync(nested);
      const target = writeHeader(dir, "symlink-target.jsonl", "linked-id");
      const link = nodePath.join(dir, "link.jsonl");
      nodeFs.symlinkSync(target, link);

      for (const path of [missing, nested, link]) {
        expect(probeSessionHeader(path)).toEqual(SessionHeaderProbe.invalid());
      }
    }),
  );
});

describe("session-file identity", () => {
  it.effect("matches normalized lexical aliases and descriptor-identical hardlinks", () =>
    Effect.gen(function* () {
      const dir = yield* sessionDirectory;
      const original = writeHeader(dir, "identity-original.jsonl", "identity");
      const lexicalAlias = `${dir}${sep}.${sep}identity-original.jsonl`;
      const hardlink = nodePath.join(dir, "identity-hardlink.jsonl");
      nodeFs.linkSync(original, hardlink);

      expect(compareSessionFileIdentity(original, lexicalAlias)).toBe("same");
      expect(compareSessionFileIdentity(original, hardlink)).toBe("same");
    }),
  );

  it.effect("compares the actual file when parent traversal follows a directory symlink", () =>
    Effect.gen(function* () {
      const dir = yield* sessionDirectory;
      const lexicalDirectory = nodePath.join(dir, "identity-lexical");
      const physicalDirectory = nodePath.join(dir, "identity-physical");
      const nestedDirectory = nodePath.join(physicalDirectory, "nested");
      nodeFs.mkdirSync(lexicalDirectory);
      nodeFs.mkdirSync(nestedDirectory, { recursive: true });
      const target = writeHeader(dir, "identity-physical/session.jsonl", "target-session");
      writeHeader(dir, "identity-lexical/session.jsonl", "different-session");
      const directoryAlias = nodePath.join(lexicalDirectory, "alias");
      nodeFs.symlinkSync(nestedDirectory, directoryAlias);
      const traversed = `${directoryAlias}${sep}..${sep}session.jsonl`;

      expect(probeSessionHeader(traversed)).toMatchObject(
        SessionHeaderProbe.valid({ header: { id: "target-session" } }),
      );
      expect(compareSessionFileIdentity(traversed, target)).toBe("same");
      expect(compareSessionFileIdentity(target, traversed)).toBe("same");
    }),
  );

  it.effect("treats symlinks, missing files, and invalid paths as unavailable", () =>
    Effect.gen(function* () {
      const dir = yield* sessionDirectory;
      const target = writeHeader(dir, "identity-target.jsonl", "target");
      const symlink = nodePath.join(dir, "identity-symlink.jsonl");
      nodeFs.symlinkSync(target, symlink);
      const missing = nodePath.join(dir, "identity-missing.jsonl");

      for (const unavailable of [symlink, missing, "relative.jsonl", `${dir}/bad\npath`]) {
        expect(compareSessionFileIdentity(target, unavailable)).toBe("unavailable");
        expect(compareSessionFileIdentity(unavailable, unavailable)).toBe("unavailable");
      }
    }),
  );
});

describe("createBlankChildSessionFile", () => {
  it.effect("uses the Effect clock and creates a wx 0600 blank root session", () =>
    Effect.gen(function* () {
      const dir = yield* sessionDirectory;
      yield* TestClock.setTime(Date.parse(FIRST_TIMESTAMP));
      const result = yield* createBlankChildSessionFile({
        sessionDir: dir,
        cwd: "/project",
        sessionId: "blank-child-id",
      });

      expect(BlankChildSessionFileResult.$is("created")(result)).toBe(true);
      if (BlankChildSessionFileResult.$is("created")(result)) {
        expect(result.path).toContain("2026-08-26T01-02-03-004Z_blank-child-id.jsonl");
        expect(nodeFs.statSync(result.path).mode & 0o777).toBe(0o600);
        const header = nodeFs.readFileSync(result.path, "utf8").split("\n")[0] ?? "";
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
      const dir = yield* sessionDirectory;
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
          sessionDir: nodePath.join(dir, "missing-directory"),
        }),
      ).toEqual(BlankChildSessionFileResult.invalid());
      for (const sessionId of ["x/../escape", "a".repeat(129)])
        expect(yield* createBlankChildSessionFile({ ...input, sessionId })).toEqual(
          BlankChildSessionFileResult.invalid(),
        );
    }),
  );
});
