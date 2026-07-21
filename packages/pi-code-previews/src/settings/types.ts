export * from "./schema-constants";
export type * from "./schema";
import type { CodePreviewSettings } from "./schema";

export type CodePreviewEditableSettingId = keyof CodePreviewSettings | "resetToDefaults";
