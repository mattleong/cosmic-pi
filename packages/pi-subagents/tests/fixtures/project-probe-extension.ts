import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const PROJECT_PROBE_TOOL = "project_probe";

/** Project-local extension whose tool is discoverable only when Pi trusts the project. */
export default function projectProbe(pi: ExtensionAPI): void {
  pi.registerTool({
    name: PROJECT_PROBE_TOOL,
    label: "Project probe",
    description: "Reports that the project extension loaded.",
    parameters: Type.Object({}),
    execute: () =>
      Promise.resolve({ content: [{ type: "text" as const, text: "loaded" }], details: {} }),
  });
}
