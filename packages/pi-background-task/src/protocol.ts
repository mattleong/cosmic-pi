/** Public plain-data and checked-capability protocol for the explicit Code Mode adapter. */
export { backgroundTaskCodeModeOutputFits } from "./code-mode/output.ts";
export {
  BACKGROUND_TASK_CODE_MODE_BOUNDS,
  BACKGROUND_TASK_CODE_MODE_QUERY,
  BACKGROUND_TASK_CODE_MODE_VERSION,
  BackgroundTaskCodeModeInputSchema,
  BackgroundTaskCodeModeOutputSchema,
  normalizeBackgroundTaskCodeModeCapability,
  normalizeBackgroundTaskCodeModeQuery,
  type BackgroundTaskCodeModeCapability,
  type BackgroundTaskCodeModeInput,
  type BackgroundTaskCodeModeLogMetadata,
  type BackgroundTaskCodeModeOutput,
  type BackgroundTaskCodeModeQuery,
} from "./code-mode/protocol.ts";
