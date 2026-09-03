import { resolve } from "node:path";
import { createJiti } from "jiti/static";

const root = resolve(import.meta.dirname, "..");

const jiti = createJiti(import.meta.url, { moduleCache: false });
const extension = await jiti.import(resolve(root, "packages/pi-advisor/index.ts"));
if (!(Object(extension.default) instanceof Function)) throw new Error("missing advisor extension");
console.log("Local advisor imports directly from TypeScript source through Pi's Jiti loader.");
