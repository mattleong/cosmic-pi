const { execFileSync } = process.getBuiltinModule("node:child_process")!;
const fs = process.getBuiltinModule("node:fs")!;
import { tmpdir } from "node:os";
const { join } = process.getBuiltinModule("node:path")!;
import { fileURLToPath } from "node:url";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
const quote = Schema.encodeSync(Schema.fromJsonString(Schema.String));
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
  const directory = fs.mkdtempSync(join(tmpdir(), "pi-publication-"));
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
const helper = fileURLToPath(
  new URL("../../src/boundary/git-worktree-publish-helper.ts", import.meta.url),
);
// Execute test-only ordering hooks in a disposable child, never chdir the test runner.
const hooked = (request: ReturnType<typeof setup>, hook: string, phase = "captured") => {
  const code = `const {createJiti}=await import(${JSON.stringify(import.meta.resolve("jiti"))});const jiti=createJiti(${JSON.stringify(import.meta.url)});const {executePublication}=await jiti.import(${JSON.stringify(helper)});const Effect=await jiti.import('effect/Effect');const fs=await import('node:fs');const request=${JSON.stringify({ ...request, before: { bytes: Buffer.from("before").toString("base64"), mode: 0o644 }, after: { bytes: Buffer.from("after").toString("base64"), mode: 0o644 } })};const result=await Effect.runPromise(executePublication(request,{${phase}:()=>{${hook}}}));process.stdout.write(JSON.stringify(result));`;
  return JSON.parse(
    execFileSync(process.execPath, ["--input-type=module", "-e", code], {
      cwd: request.directory,
      encoding: "utf8",
    }),
  );
};

describe("anchored workspace publication", () => {
  it.effect("updates durably, retains the captured preimage, and leaves one target link", () =>
    Effect.gen(function* () {
      const r = setup();
      fs.writeFileSync(join(r.directory, r.name), "before", { mode: 0o644 });
      expect(
        (yield* publishWorkspaceFile({ ...r, before: image("before"), after: image("after") }))
          .status,
      ).toBe("success");
      expect(fs.readFileSync(join(r.directory, r.name), "utf8")).toBe("after");
      expect(fs.readFileSync(join(r.directory, r.backupName), "utf8")).toBe("before");
      expect(fs.statSync(join(r.directory, r.name)).nlink).toBe(1);
    }),
  );
  it.effect("preserves private file permissions", () =>
    Effect.gen(function* () {
      const r = setup();
      fs.writeFileSync(join(r.directory, r.name), "before", { mode: 0o600 });
      expect(
        (yield* publishWorkspaceFile({
          ...r,
          before: { ...image("before"), mode: 0o600 },
          after: { ...image("after"), mode: 0o600 },
        })).status,
      ).toBe("success");
      expect(fs.statSync(join(r.directory, r.name)).mode & 0o7777).toBe(0o600);
      expect(fs.statSync(join(r.directory, r.backupName)).mode & 0o7777).toBe(0o600);
    }),
  );
  it.effect("creates an absent file and refuses an existing destination", () =>
    Effect.gen(function* () {
      const r = setup();
      expect((yield* publishWorkspaceFile({ ...r, after: image("after") })).status).toBe("success");
      expect((yield* publishWorkspaceFile({ ...r, after: image("other") })).status).toBe(
        "conflict",
      );
      expect(fs.readFileSync(join(r.directory, r.name), "utf8")).toBe("after");
    }),
  );
  it.effect("deletes by retaining the captured preimage", () =>
    Effect.gen(function* () {
      const r = setup();
      fs.writeFileSync(join(r.directory, r.name), "before");
      expect((yield* publishWorkspaceFile({ ...r, before: image("before") })).status).toBe(
        "success",
      );
      expect(() => fs.lstatSync(join(r.directory, r.name))).toThrow();
      expect(fs.readFileSync(join(r.directory, r.backupName), "utf8")).toBe("before");
    }),
  );
  it.effect(
    "restores unexpected bytes exclusively and retains their backup for manual recovery",
    () =>
      Effect.gen(function* () {
        const r = setup();
        fs.writeFileSync(join(r.directory, r.name), "editor");
        expect(
          (yield* publishWorkspaceFile({ ...r, before: image("before"), after: image("after") }))
            .status,
        ).toBe("conflict");
        expect(fs.readFileSync(join(r.directory, r.name), "utf8")).toBe("editor");
        expect(fs.readFileSync(join(r.directory, r.backupName), "utf8")).toBe("editor");
      }),
  );
  it.effect("never overwrites an editor save after capture", () =>
    Effect.gen(function* () {
      const r = setup();
      fs.writeFileSync(join(r.directory, r.name), "before");
      yield* Effect.void;
      expect(hooked(r, `fs.writeFileSync('target','editor');`).status).toBe("conflict");
      expect(fs.readFileSync(join(r.directory, r.name), "utf8")).toBe("editor");
      expect(fs.readFileSync(join(r.directory, r.backupName), "utf8")).toBe("before");
    }),
  );
  it.effect("an ancestor swap cannot redirect leaf operations", () =>
    Effect.gen(function* () {
      const root = setup();
      const outside = join(root.directory, "outside");
      const original = join(root.directory, "original");
      fs.mkdirSync(outside);
      fs.mkdirSync(original);
      fs.writeFileSync(join(original, "target"), "before");
      fs.writeFileSync(join(outside, "target"), "outside");
      const stat = fs.statSync(original);
      const r = { ...root, directory: original, directoryDev: stat.dev, directoryIno: stat.ino };
      yield* Effect.void;
      expect(
        hooked(
          r,
          `fs.renameSync(${quote(original)},${quote(original + "-moved")});fs.symlinkSync(${quote(outside)},${quote(original)});`,
          "anchored",
        ).status,
      ).toBe("success");
      expect(fs.readFileSync(join(outside, "target"), "utf8")).toBe("outside");
      expect(fs.readFileSync(join(original + "-moved", "target"), "utf8")).toBe("after");
    }),
  );
  it.effect("creates directories exclusively and checks the anchor identity", () =>
    Effect.gen(function* () {
      const r = setup();
      const created = yield* createWorkspaceDirectory({ ...r, name: "new" });
      expect(created.directoryIno).toBe(fs.statSync(join(r.directory, "new")).ino);
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
