const fs = process.getBuiltinModule("node:fs");
import { tmpdir } from "node:os";
const nodePath = process.getBuiltinModule("node:path");
import * as Effect from "effect/Effect";
import { afterEach, describe, expect } from "vitest";
import { it } from "@effect/vitest";
import {
  createWorkspaceDirectory,
  publishWorkspaceFile,
} from "../../src/boundary/git-worktree-publish.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const image = (text: string) => ({ bytes: Buffer.from(text), mode: 0o644 });
const setup = () => {
  // Publication refuses symlinked ancestors, and macOS reaches the temporary directory through one.
  const directory = fs.realpathSync(fs.mkdtempSync(nodePath.join(tmpdir(), "pi-publication-")));
  roots.push(directory);
  const stat = fs.statSync(directory);
  return {
    directory,
    directoryDev: stat.dev,
    directoryIno: stat.ino,
    name: "target",
    backupName: ".pi-workspace-backup",
    temporaryName: ".pi-workspace-temp",
  };
};
describe("anchored workspace publication", () => {
  it.effect("updates durably, retains the captured preimage, and leaves one target link", () =>
    Effect.gen(function* () {
      const r = setup();
      fs.writeFileSync(nodePath.join(r.directory, r.name), "before", { mode: 0o644 });
      expect(
        (yield* publishWorkspaceFile({ ...r, before: image("before"), after: image("after") }))
          .status,
      ).toBe("success");
      expect(fs.readFileSync(nodePath.join(r.directory, r.name), "utf8")).toBe("after");
      expect(fs.readFileSync(nodePath.join(r.directory, r.backupName), "utf8")).toBe("before");
      expect(fs.statSync(nodePath.join(r.directory, r.name)).nlink).toBe(1);
    }),
  );
  it.effect("preserves private file permissions", () =>
    Effect.gen(function* () {
      const r = setup();
      fs.writeFileSync(nodePath.join(r.directory, r.name), "before", { mode: 0o600 });
      expect(
        (yield* publishWorkspaceFile({
          ...r,
          before: { ...image("before"), mode: 0o600 },
          after: { ...image("after"), mode: 0o600 },
        })).status,
      ).toBe("success");
      expect(fs.statSync(nodePath.join(r.directory, r.name)).mode & 0o7777).toBe(0o600);
      expect(fs.statSync(nodePath.join(r.directory, r.backupName)).mode & 0o7777).toBe(0o600);
    }),
  );
  it.effect("restores unexpected bytes as the same unlinked file without keeping a backup", () =>
    Effect.gen(function* () {
      const r = setup();
      const target = nodePath.join(r.directory, r.name);
      fs.writeFileSync(target, "editor");
      const original = fs.statSync(target).ino;
      expect(
        (yield* publishWorkspaceFile({ ...r, before: image("before"), after: image("after") }))
          .status,
      ).toBe("conflict");
      expect(fs.readFileSync(target, "utf8")).toBe("editor");
      expect(fs.statSync(target)).toMatchObject({ ino: original, nlink: 1 });
      expect(fs.existsSync(nodePath.join(r.directory, r.backupName))).toBe(false);
      expect(fs.existsSync(nodePath.join(r.directory, r.temporaryName))).toBe(false);
      // A later publication can capture the restored file again.
      fs.writeFileSync(target, "before");
      expect(
        (yield* publishWorkspaceFile({ ...r, before: image("before"), after: image("after") }))
          .status,
      ).toBe("success");
      expect(fs.readFileSync(target, "utf8")).toBe("after");
    }),
  );
  it.effect("never overwrites an editor save after capture", () =>
    Effect.gen(function* () {
      const r = setup();
      const target = nodePath.join(r.directory, r.name);
      fs.writeFileSync(target, "before");
      const result = yield* publishWorkspaceFile(
        { ...r, before: image("before"), after: image("after") },
        { captured: Effect.sync(() => fs.writeFileSync(target, "editor")) },
      );
      expect(result.status).toBe("conflict");
      expect(fs.readFileSync(target, "utf8")).toBe("editor");
      expect(fs.readFileSync(nodePath.join(r.directory, r.backupName), "utf8")).toBe("before");
      expect(fs.existsSync(nodePath.join(r.directory, r.temporaryName))).toBe(false);
    }),
  );
  it.effect("an ancestor swap changes nothing in either directory", () =>
    Effect.gen(function* () {
      const root = setup();
      const outside = nodePath.join(root.directory, "outside");
      const original = nodePath.join(root.directory, "original");
      fs.mkdirSync(outside);
      fs.mkdirSync(original);
      fs.writeFileSync(nodePath.join(original, "target"), "before");
      fs.writeFileSync(nodePath.join(outside, "target"), "before");
      const stat = fs.statSync(original);
      const r = { ...root, directory: original, directoryDev: stat.dev, directoryIno: stat.ino };
      const result = yield* publishWorkspaceFile(
        { ...r, before: image("before"), after: image("after") },
        {
          anchored: Effect.sync(() => {
            fs.renameSync(original, `${original}-moved`);
            fs.symlinkSync(outside, original);
          }),
        },
      );
      expect(result.status).not.toBe("success");
      expect(fs.readdirSync(outside)).toEqual(["target"]);
      expect(fs.readFileSync(nodePath.join(outside, "target"), "utf8")).toBe("before");
      expect(fs.readdirSync(`${original}-moved`)).toEqual(["target"]);
      expect(fs.readFileSync(nodePath.join(`${original}-moved`, "target"), "utf8")).toBe("before");
    }),
  );
  it.effect("creates directories exclusively and checks the anchor identity", () =>
    Effect.gen(function* () {
      const r = setup();
      const created = yield* createWorkspaceDirectory({ ...r, name: "new" });
      expect(created.directoryIno).toBe(fs.statSync(nodePath.join(r.directory, "new")).ino);
      expect((yield* Effect.exit(createWorkspaceDirectory({ ...r, name: "new" })))._tag).toBe(
        "Failure",
      );
      expect(
        (yield* Effect.exit(
          createWorkspaceDirectory({ ...r, name: "other", directoryIno: r.directoryIno + 1 }),
        ))._tag,
      ).toBe("Failure");
    }),
  );
});
