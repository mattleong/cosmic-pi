export {
  DIFF_BACKGROUND_INTENSITIES,
  DIFF_WORD_EMPHASES,
  PATH_ICON_MODES,
  TOOL_CALL_BACKGROUND_MODES,
} from "./schema-constants";
export type {
  CodePreviewSettings,
  DiffBackgroundIntensity,
  DiffWordEmphasis,
  PathIconMode,
  ToolCallBackgroundMode,
} from "./schema";
import type { CodePreviewSettings } from "./schema";

export type CodePreviewEditableSettingId = keyof CodePreviewSettings | "resetToDefaults";
