import { access, mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const coreDist = join(root, "packages/pi-cosmic-core/dist");
const temporary = await mkdtemp(join(tmpdir(), "cosmic-pi-local-advisor-"));
const backup = join(temporary, "core-dist");
let hadDist = false;

try {
  try {
    await access(coreDist);
    hadDist = true;
  } catch {
    hadDist = false;
  }
  if (hadDist) await rename(coreDist, backup);

  const prepare = spawnSync("pnpm", ["prepare"], {
    cwd: root,
    encoding: "utf8",
    env: process.env,
  });
  if (prepare.status !== 0) {
    throw new Error(`pnpm prepare failed:\n${prepare.stdout ?? ""}${prepare.stderr ?? ""}`);
  }
  const imported = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      "const extension = await import('./packages/pi-advisor/index.ts'); if (typeof extension.default !== 'function') throw new Error('missing advisor extension');",
    ],
    { cwd: root, encoding: "utf8", env: process.env },
  );
  if (imported.status !== 0) {
    throw new Error(
      `local advisor import failed:\n${imported.stdout ?? ""}${imported.stderr ?? ""}`,
    );
  }
  console.log("Local advisor imports after prepare builds core from a dist-free workspace.");
} finally {
  await rm(coreDist, { recursive: true, force: true });
  if (hadDist) await rename(backup, coreDist);
  await rm(temporary, { recursive: true, force: true });
}
