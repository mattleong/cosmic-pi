import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerMcpApplication } from "./application/register.ts";

export default function mcp(pi: ExtensionAPI): void {
  registerMcpApplication(pi);
}
