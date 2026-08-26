import { afterAll, describe, expect, it } from "vitest";
import {
  createBlankChildSessionFile,
  createChildSessionId,
  probeSessionHeader,
} from "../src/boundary/session-file.ts";

// This suite intentionally exercises the raw-filesystem probe boundary, so it
// uses the same guarded builtin access as the boundary itself.
const nodeFs = process.getBuiltinModule("node:fs");
const nodeOs = process.getBuiltinModule("node:os");
const nodePath = process.getBuiltinModule("node:path");
if (!nodeFs || !nodeOs || !nodePath) throw new Error("Node builtins are unavailable.");
const { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } = nodeFs;
const { tmpdir } = nodeOs;
const { join } = nodePath;

const PARENT_FILE = "/sessions/parent.jsonl";

const dir = mkdtempSync(join(tmpdir(), "pi-herdr-fork-session-"));
afterAll(() => rmSync(dir, { force: true, recursive: true }));

const writeSession = (name: string, firstLine: string, rest = ""): string => {
  const path = join(dir, name);
  writeFileSync(path, `${firstLine}\n${rest}`);
  return path;
};

describe("probeSessionHeader", () => {
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
    const path = writeSession(
      "root.jsonl",
      JSON.stringify({ type: "session", id: "root-id", timestamp: "t", cwd: "/project" }),
    );
    expect(probeSessionHeader(path)).toEqual({
      _tag: "valid",
      header: { id: "root-id", parentSession: undefined },
    });
  });

  it("rejects a missing file", () => {
    expect(probeSessionHeader(join(dir, "missing.jsonl"))).toEqual({ _tag: "invalid" });
  });

  it("rejects a symlink even when its target is a valid session", () => {
    const target = writeSession(
      "symlink-target.jsonl",
      JSON.stringify({ type: "session", id: "linked-id", timestamp: "t", cwd: "/project" }),
    );
    const link = join(dir, "link.jsonl");
    symlinkSync(target, link);
    expect(probeSessionHeader(link)).toEqual({ _tag: "invalid" });
  });

  it("rejects a directory", () => {
    const nested = join(dir, "a-directory");
    mkdirSync(nested);
    expect(probeSessionHeader(nested)).toEqual({ _tag: "invalid" });
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
    expect(probeSessionHeader("relative/session.jsonl")).toEqual({ _tag: "invalid" });
    expect(probeSessionHeader(`${dir}/bad\npath.jsonl`)).toEqual({ _tag: "invalid" });
    expect(probeSessionHeader("")).toEqual({ _tag: "invalid" });
  });
});

describe("createBlankChildSessionFile", () => {
  it("creates an exclusively owned blank root session that is immediately resumable", () => {
    const result = createBlankChildSessionFile({
      sessionDir: dir,
      cwd: "/project",
      sessionId: "blank-child-id",
      timestamp: "2026-08-26T01:02:03.004Z",
    });

    expect(result._tag).toBe("created");
    if (result._tag === "created")
      expect(probeSessionHeader(result.path)).toEqual({
        _tag: "valid",
        header: { id: "blank-child-id", parentSession: undefined },
      });
  });

  it("fails closed on collision or invalid directories", () => {
    const input = {
      sessionDir: dir,
      cwd: "/project",
      sessionId: "collision-child-id",
      timestamp: "2026-08-26T02:00:00.000Z",
    } as const;
    expect(createBlankChildSessionFile(input)._tag).toBe("created");
    expect(createBlankChildSessionFile(input)).toEqual({ _tag: "invalid" });
    expect(
      createBlankChildSessionFile({ ...input, sessionDir: join(dir, "missing-directory") }),
    ).toEqual({ _tag: "invalid" });
  });
});

describe("createChildSessionId", () => {
  it("generates distinct Pi-compatible session IDs", () => {
    const first = createChildSessionId();
    const second = createChildSessionId();
    expect(first).not.toBe(second);
    for (const id of [first, second])
      expect(id).toMatch(/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/u);
  });
});
