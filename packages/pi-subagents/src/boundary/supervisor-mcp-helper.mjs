#!/usr/bin/env node
// Plain-Node launcher for the typed helper. Node refuses native type stripping inside
// node_modules, so the package-owned Jiti dependency loads the erasable TypeScript source.
for (const key of Object.keys(process.env)) delete process.env[key];
const { createJiti } = await import("jiti");
const jiti = createJiti(import.meta.url, { interopDefault: true });
await jiti.import("./supervisor-mcp-helper.ts");
