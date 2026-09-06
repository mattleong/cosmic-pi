#!/usr/bin/env node
// Fixed packaged launcher: installed TypeScript needs Jiti, not a build step.
for (const key of Object.keys(process.env)) delete process.env[key];
const { createJiti } = await import("jiti");
const jiti = createJiti(import.meta.url, { interopDefault: true });
const { publicationMain } = await jiti.import("./git-worktree-publish-helper.ts");
await publicationMain();
