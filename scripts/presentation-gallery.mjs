// Renders every package's presentation gallery into one text file for visual review.
// Galleries are env-gated `tests/presentation-gallery.test.ts` files; nothing is asserted.
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const rootDir = join(import.meta.dirname, "..");
const packages = [
  "pi-code-previews",
  "pi-code-mode",
  "pi-subagents",
  "pi-mcp",
  "pi-background-task",
  "pi-ask-user",
];
const outIndex = process.argv.indexOf("--out");
const out = resolve(
  rootDir,
  outIndex >= 0 && process.argv[outIndex + 1]
    ? process.argv[outIndex + 1]
    : "presentation-gallery.txt",
);

const directory = await mkdtemp(join(tmpdir(), "presentation-gallery-"));
try {
  for (const name of packages) {
    const run = spawnSync(
      "pnpm",
      ["--filter", name, "exec", "vitest", "run", "tests/presentation-gallery.test.ts"],
      {
        cwd: rootDir,
        stdio: ["ignore", "ignore", "inherit"],
        env: { ...process.env, PRESENTATION_GALLERY: directory },
      },
    );
    if (run.status !== 0) {
      console.error(`Gallery for ${name} failed.`);
      process.exitCode = 1;
      break;
    }
  }
  if (process.exitCode !== 1) {
    const sections = [];
    for (const name of packages) {
      const text = await readFile(join(directory, `${name}.txt`), "utf8");
      sections.push(`════ ${name} ════\n\n${text}`);
    }
    await writeFile(out, sections.join("\n"));
    console.log(`Presentation gallery written to ${out}`);
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
