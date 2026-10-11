#!/usr/bin/env node
for (const key of Object.keys(process.env)) delete process.env[key];
const { createJiti } = await import("jiti");
const jiti = createJiti(import.meta.url, { interopDefault: true });
await jiti.import("./supervisor-mcp-helper.ts");
