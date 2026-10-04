import { fileURLToPath } from "node:url";

/**
 * The workflow authoring guide's absolute path, resolved from this module's location so it holds
 * wherever the package is installed. The ultracode guideline and the /ultracode request both
 * point the main agent at it before it writes a workflow script.
 */
export const workflowAuthoringGuidePath = (): string =>
  fileURLToPath(new URL("../../skills/workflow-authoring/SKILL.md", import.meta.url));
