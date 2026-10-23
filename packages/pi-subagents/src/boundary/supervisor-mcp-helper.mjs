#!/usr/bin/env node
// Scrub before any module loads; a static effect/Record import would be evaluated first.
// @effect-diagnostics-next-line preferEffectRecord:off
for (const key of Object.keys(process.env)) delete process.env[key];
// jiti's default cache lives in the shared, world-writable tmpdir; never load transpiled code from it.
const { createJiti } = await import("jiti");
const jiti = createJiti(import.meta.url, { interopDefault: true, fsCache: false });
await jiti.import("./supervisor-mcp-helper.ts");
