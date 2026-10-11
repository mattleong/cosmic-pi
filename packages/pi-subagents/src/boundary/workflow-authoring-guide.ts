import { fileURLToPath } from "node:url";

export const workflowAuthoringGuidePath = (): string =>
  fileURLToPath(new URL("../../skills/workflow-authoring/SKILL.md", import.meta.url));
