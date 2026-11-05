import { failureMessage } from "pi-cosmic-core/message-text";
import { formatDisplayPath } from "pi-cosmic-core/platform/paths";
import { nodePath } from "pi-cosmic-core/platform/node-builtins";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { sanitizeTerminalLine } from "pi-cosmic-core/security";
import * as Arr from "effect/Array";
import {
  hasCodePreviewSessionCapability,
  runCodePreviewSessionEffect,
} from "../application/capability";
import { runOneShotSettingsEffect } from "../boundary/settings-one-shot";
import { nextSettingsAdmission, type SettingsAdmission } from "./coordinator";
import type { CodePreviewSettings } from "./schema";
import {
  CodePreviewSettingsService,
  CodePreviewSettingsSuperseded,
  type LoadSettingsOptions,
  type SettingsLoadProblem,
} from "./service";
import { cloneCodePreviewSettings } from "./state";

export {
  CodePreviewSettingsService,
  CodePreviewSettingsSuperseded,
  type CodePreviewSettingsServiceContract,
  type LoadSettingsOptions,
  type SettingsLoadProblem,
} from "./service";

function runSettingsEffect<A, E>(effect: Effect.Effect<A, E, CodePreviewSettingsService>) {
  return hasCodePreviewSessionCapability()
    ? runCodePreviewSessionEffect(effect)
    : runOneShotSettingsEffect(effect);
}

const inFlightLoads = new Map<string, Promise<CodePreviewSettings>>();

export function loadCodePreviewSettings(
  projectCwd?: string,
  projectTrusted = false,
  signal?: AbortSignal,
): Promise<CodePreviewSettings> {
  const options: LoadSettingsOptions = projectTrusted
    ? { projectCwd: projectCwd ?? process.cwd(), projectTrusted }
    : {};
  const execute = (admission: SettingsAdmission): Promise<CodePreviewSettings> => {
    const effect = CodePreviewSettingsService.use((service) => service.load(admission, options));
    if (!hasCodePreviewSessionCapability()) return runOneShotSettingsEffect(effect, signal);
    return runCodePreviewSessionEffect(effect, signal).catch((cause: unknown) => {
      if (signal?.aborted) throw cause;
      return runOneShotSettingsEffect(effect, signal);
    });
  };

  if (signal) return execute(nextSettingsAdmission());

  const key = JSON.stringify([projectCwd ?? null, projectTrusted]);
  const inFlight = inFlightLoads.get(key);
  if (inFlight) return inFlight.then(cloneCodePreviewSettings);
  const load = execute(nextSettingsAdmission());
  inFlightLoads.set(key, load);
  const settle = () => {
    if (inFlightLoads.get(key) === load) inFlightLoads.delete(key);
  };
  void load.then(settle, settle);
  return load.then(cloneCodePreviewSettings);
}

export function getSettingsPath(): string {
  return nodePath.join(getAgentDir(), "code-previews.json");
}

export function queueSettingsSave(
  settings: CodePreviewSettings,
  loadOptions: LoadSettingsOptions = {},
  previous?: CodePreviewSettings,
  editedKeys?: readonly (keyof CodePreviewSettings)[],
): Promise<void> {
  const admission = nextSettingsAdmission();
  const next = cloneCodePreviewSettings(settings);
  const options = {
    ...(!hasCodePreviewSessionCapability() && { rehydrate: loadOptions }),
    ...(previous && { previous: cloneCodePreviewSettings(previous) }),
    ...(editedKeys && { editedKeys: [...editedKeys] }),
  };
  return runSettingsEffect(
    CodePreviewSettingsService.use((service) => service.save(next, admission, options)),
  );
}

export function queueSettingsReset(loadOptions: LoadSettingsOptions = {}): Promise<void> {
  const admission = nextSettingsAdmission();
  const options = hasCodePreviewSessionCapability() ? {} : { rehydrate: loadOptions };
  return runSettingsEffect(
    CodePreviewSettingsService.use((service) => service.reset(admission, options)),
  );
}

export function flushSettingsSaveQueue(): Promise<void> {
  return runSettingsEffect(CodePreviewSettingsService.use((service) => service.flush));
}

const SAVE_LEAD = "Couldn't save Code Previews settings";

// What a failed save carries: a document error's operation and file, or Node's code on a raw error.
const SaveFailureFacts = Schema.Struct({
  operation: Schema.optional(Schema.String),
  code: Schema.optional(Schema.String),
  path: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
});
const decodeSaveFailure = Schema.decodeUnknownOption(SaveFailureFacts);
const isSuperseded = Schema.is(CodePreviewSettingsSuperseded);

// Node prints `EACCES: permission denied, open '…'` when the error has no code property.
const NODE_CODE = /^(?:[A-Za-z]*Error:\s*)?(E[A-Z]+):/u;

const SAVE_CAUSES: ReadonlyMap<string, string> = new Map([
  ["EACCES", "permission denied"],
  ["EPERM", "permission denied"],
  ["EROFS", "the file system is read-only"],
  ["ENOSPC", "the disk is full"],
  ["ENOENT", "its folder is missing"],
]);

/**
 * A failed save in words: the cause when Node's code is a common one, the settings file as notices
 * show paths, and what to do next. Node's raw text, such as `EACCES: …`, never reaches the notice.
 */
export function formatSettingsSaveError(cause: unknown, cwd = ""): string {
  const facts: typeof SaveFailureFacts.Type = Option.getOrElse(
    decodeSaveFailure(cause),
    () => ({}),
  );
  const message = failureMessage(facts.message ?? "", "unknown error");
  if (isSuperseded(cause)) return `${SAVE_LEAD}: ${message}`;
  const code = facts.code ?? NODE_CODE.exec(Str.trim(facts.message ?? ""))?.[1];
  const reason = code === undefined ? undefined : SAVE_CAUSES.get(code);
  // A lock another writer holds clears on its own; one that needs recovery says how.
  if (facts.operation === "lock")
    return Str.startsWith("Another process")(facts.message ?? "")
      ? `${SAVE_LEAD}: another process was saving them\nTry again in a moment`
      : `${SAVE_LEAD}: ${message}`;
  if (reason === undefined && facts.operation === undefined) return `${SAVE_LEAD}: ${message}`;
  const path =
    facts.path === undefined || Str.isEmpty(Str.trim(facts.path)) ? getSettingsPath() : facts.path;
  const shown = sanitizeTerminalLine(formatDisplayPath(path, cwd));
  if (facts.operation === "decode")
    return `${SAVE_LEAD}: ${shown} doesn't hold a settings object\nFix or remove it, then try again`;
  const next = Match.value(code).pipe(
    Match.when("ENOSPC", () => "Free some disk space, then try again"),
    Match.when(
      "ENOENT",
      () =>
        `Check that ${sanitizeTerminalLine(formatDisplayPath(nodePath.dirname(path), cwd))}/ exists`,
    ),
    Match.orElse(() => `Check that you can write to ${shown}`),
  );
  return `${SAVE_LEAD}${reason === undefined ? "" : `: ${reason}`}\n${next}`;
}

export function describeSettingsProblem(problem: SettingsLoadProblem, cwd: string): string {
  const file = formatDisplayPath(problem.path, cwd);
  return problem.fields
    ? `Code Previews ignored invalid settings in ${file}: ${Arr.join(problem.fields, ", ")}`
    : `Code Previews couldn't read its settings in ${file}`;
}
