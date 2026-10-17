#!/usr/bin/env node
for (const key of Object.keys(process.env)) delete process.env[key];
// jiti's default cache lives in the shared, world-writable tmpdir; never load transpiled code from
// it. The parent may name a cache directory, which is used only while it stays private to this user.
const fs = await import("node:fs");
const nodePath = await import("node:path");
/** @param {string | undefined} directory */
const privateCache = (directory) => {
  if (directory === undefined || !nodePath.isAbsolute(directory)) return false;
  try {
    const stat = fs.lstatSync(directory);
    return stat.isDirectory() && stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0
      ? directory
      : false;
  } catch {
    return false;
  }
};
const { createJiti } = await import("jiti");
const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  fsCache: privateCache(process.argv[2]),
});
await jiti.import("./git-worktree-publish-entry.ts");
