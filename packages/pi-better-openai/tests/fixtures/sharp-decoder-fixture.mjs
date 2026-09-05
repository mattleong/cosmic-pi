import { writeFileSync, appendFileSync } from "node:fs";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const marker = Buffer.concat(chunks).toString("utf8");
process.on("SIGTERM", () => appendFileSync(marker, "\nSIGTERM"));
writeFileSync(marker, String(process.pid));
setInterval(() => {}, 1_000);
