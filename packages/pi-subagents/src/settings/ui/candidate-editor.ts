// Settings dialogs are Promise-shaped Pi host boundaries.
// @effect-diagnostics effect/asyncFunction:off
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ProfileCandidate, ProfileId } from "../../profiles/model.ts";
import type { SubagentEffort, SubagentHost, SubagentRuntime } from "../../run/model.ts";
import {
  isSafeNativeModelSelector,
  MAX_NATIVE_MODEL_SELECTOR_CHARS,
} from "../../run/native-model-selector.ts";
import {
  candidateValidationError,
  NATIVE_MODEL_DEFAULTS,
  runtimeEfforts,
  updateCandidateControls,
  updateCandidateModel,
  type CandidateUpdate,
} from "../profile-route-editor.ts";
import {
  createProfileModelChoices,
  effortPickerOptions,
  selectProfileModel,
  type ProfileModelChoice,
  type ProfileModelPickerChoice,
} from "./model-picker.ts";

export interface CandidateEditorInput {
  readonly profile: ProfileId;
  readonly candidateIndex: number;
  readonly candidate: ProfileCandidate;
}

const HOST_OPTIONS: ReadonlyArray<{ readonly label: string; readonly value: SubagentHost }> = [
  { label: "Local process", value: "local" },
  { label: "Herdr", value: "herdr" },
];
const RUNTIME_OPTIONS: ReadonlyArray<{ readonly label: string; readonly value: SubagentRuntime }> =
  [
    { label: "Pi", value: "pi" },
    { label: "Claude Code", value: "claude" },
    { label: "Codex", value: "codex" },
  ];
const APPLY = "Done · apply candidate";
const CANCEL = "Cancel · discard candidate changes";

const boundedMiddle = (value: string, maximum = 64): string => {
  if (value.length <= maximum) return value;
  const left = Math.max(1, Math.floor((maximum - 1) / 2));
  return `${value.slice(0, left)}…${value.slice(value.length - (maximum - left - 1))}`;
};

const notifyUpdate = (ctx: ExtensionCommandContext, update: CandidateUpdate): void => {
  if (update.error) ctx.ui.notify(update.error, "warning");
  for (const notice of update.notices) ctx.ui.notify(`Candidate normalized: ${notice}`, "warning");
};

const selectedModelEfforts = (
  choices: ReadonlyArray<ProfileModelPickerChoice>,
  choice: ProfileModelChoice,
): ReadonlyArray<SubagentEffort> | undefined =>
  choices.find((entry) =>
    choice.kind === "parent"
      ? entry.choice.kind === "parent"
      : entry.choice.kind === "model" && entry.choice.selector === choice.selector,
  )?.supportedEfforts;

const nativeModelInput = async (
  ctx: ExtensionCommandContext,
  runtime: "claude" | "codex",
  current: string,
): Promise<string | undefined> => {
  const defaultModel = NATIVE_MODEL_DEFAULTS[runtime];
  while (true) {
    const value = await ctx.ui.input(
      `${runtime === "claude" ? "Claude Code" : "Codex"} native model · current: ${boundedMiddle(current, 80)}`,
      `Example/default: ${defaultModel} · max ${MAX_NATIVE_MODEL_SELECTOR_CHARS} chars · esc back`,
    );
    if (value === undefined) return undefined;
    const model = value.trim();
    if (isSafeNativeModelSelector(model)) return model;
    ctx.ui.notify(
      `Invalid ${runtime} model selector. Enter 1–${MAX_NATIVE_MODEL_SELECTOR_CHARS} characters matching [A-Za-z0-9][A-Za-z0-9._:/-]*; it cannot start with '-' or contain spaces, controls, commas, parentheses, or globs.`,
      "warning",
    );
  }
};

const candidateFields = (candidate: ProfileCandidate): ReadonlyArray<string> => [
  `Host · ${candidate.host}`,
  `Runtime · ${candidate.runtime}`,
  `Model · ${boundedMiddle(candidate.model)}`,
  `Effort · ${candidate.effort}`,
  `Context · ${candidate.context}`,
  `Write intent · ${candidate.writeIntent}`,
  `After report · ${candidate.closeOnReport ? "close" : "retain"}`,
  APPLY,
  CANCEL,
];

export async function editProfileCandidate(
  ctx: ExtensionCommandContext,
  input: CandidateEditorInput,
): Promise<ProfileCandidate | undefined> {
  let candidate = { ...input.candidate };
  const availableModels = ctx.modelRegistry.getAvailable();
  const parentModel = ctx.model
    ? ctx.modelRegistry.find(ctx.model.provider, ctx.model.id)
    : undefined;
  const piModel = availableModels[0]
    ? `${availableModels[0].provider}/${availableModels[0].id}`
    : undefined;

  while (true) {
    const fields = candidateFields(candidate);
    const selected = await ctx.ui.select(
      `${input.profile} · candidate ${input.candidateIndex + 1} · edit fields · esc discard candidate changes`,
      [...fields],
    );
    if (selected === undefined || selected === CANCEL) return undefined;
    if (selected === APPLY) {
      const error = candidateValidationError(candidate);
      if (error) {
        ctx.ui.notify(error, "warning");
        continue;
      }
      return candidate;
    }

    if (selected === fields[0]) {
      const labels = HOST_OPTIONS.map(
        (option) => `${option.label}${option.value === candidate.host ? " (current)" : ""}`,
      );
      const hostLabel = await ctx.ui.select("Candidate host · esc back to candidate", labels);
      const index = hostLabel ? labels.indexOf(hostLabel) : -1;
      const host = index >= 0 ? HOST_OPTIONS[index]?.value : undefined;
      if (!host) continue;
      const update = updateCandidateControls(candidate, { host }, { piModel });
      notifyUpdate(ctx, update);
      if (update.candidate) candidate = update.candidate;
      continue;
    }

    if (selected === fields[1]) {
      const labels = RUNTIME_OPTIONS.map(
        (option) => `${option.label}${option.value === candidate.runtime ? " (current)" : ""}`,
      );
      const runtimeLabel = await ctx.ui.select("Candidate runtime · esc back to candidate", labels);
      const index = runtimeLabel ? labels.indexOf(runtimeLabel) : -1;
      const runtime = index >= 0 ? RUNTIME_OPTIONS[index]?.value : undefined;
      if (!runtime) continue;
      const update = updateCandidateControls(candidate, { runtime }, { piModel });
      notifyUpdate(ctx, update);
      if (update.candidate) candidate = update.candidate;
      continue;
    }

    if (selected === fields[2]) {
      if (candidate.runtime === "pi") {
        const choices = createProfileModelChoices({
          models: availableModels,
          parentModel,
          currentSelector: candidate.model,
          allowParent: candidate.host === "local",
        });
        if (choices.length === 0) {
          ctx.ui.notify("No authenticated canonical Pi models are available.", "warning");
          continue;
        }
        const choice = await selectProfileModel(ctx, choices, candidate.model, {
          profile: input.profile,
          candidateIndex: input.candidateIndex,
          host: candidate.host,
        });
        if (!choice) continue;
        const model = choice.kind === "parent" ? "parent" : choice.selector;
        const update = updateCandidateModel(
          candidate,
          model,
          selectedModelEfforts(choices, choice),
        );
        notifyUpdate(ctx, update);
        if (update.candidate) candidate = update.candidate;
      } else {
        const model = await nativeModelInput(ctx, candidate.runtime, candidate.model);
        if (!model) continue;
        const update = updateCandidateModel(candidate, model);
        notifyUpdate(ctx, update);
        if (update.candidate) candidate = update.candidate;
      }
      continue;
    }

    if (selected === fields[3]) {
      let supported: ReadonlyArray<SubagentEffort>;
      if (candidate.runtime === "pi") {
        const choices = createProfileModelChoices({
          models: availableModels,
          parentModel,
          currentSelector: candidate.model,
          allowParent: candidate.host === "local",
        });
        const current = choices.find((choice) =>
          candidate.model === "parent"
            ? choice.choice.kind === "parent"
            : choice.choice.kind === "model" && choice.choice.selector === candidate.model,
        );
        supported = runtimeEfforts("pi", current?.supportedEfforts);
      } else supported = runtimeEfforts(candidate.runtime);
      const options = effortPickerOptions(supported);
      const labels = options.map(
        (option) => `${option.label}${option.effort === candidate.effort ? " (current)" : ""}`,
      );
      const effortLabel = await ctx.ui.select(
        `${candidate.runtime} effort · exact supported values · esc back to candidate`,
        labels,
      );
      const index = effortLabel ? labels.indexOf(effortLabel) : -1;
      const effort = index >= 0 ? options[index]?.effort : undefined;
      if (effort) candidate = { ...candidate, effort };
      continue;
    }

    if (selected === fields[4]) {
      const contexts =
        candidate.host === "local" && candidate.runtime === "pi"
          ? (["fresh", "fork"] as const)
          : (["fresh"] as const);
      const labels = contexts.map(
        (context) => `${context}${context === candidate.context ? " (current)" : ""}`,
      );
      const contextLabel = await ctx.ui.select(
        "Candidate context · fork is local Pi only · esc back to candidate",
        labels,
      );
      const index = contextLabel ? labels.indexOf(contextLabel) : -1;
      const context = index >= 0 ? contexts[index] : undefined;
      if (context) candidate = { ...candidate, context };
      continue;
    }

    if (selected === fields[5]) {
      const intents = ["read-only", "writer"] as const;
      const labels = intents.map(
        (intent) => `${intent}${intent === candidate.writeIntent ? " (current)" : ""}`,
      );
      const intentLabel = await ctx.ui.select("Candidate write intent · esc back", labels);
      const index = intentLabel ? labels.indexOf(intentLabel) : -1;
      const writeIntent = index >= 0 ? intents[index] : undefined;
      if (!writeIntent) continue;
      const update = updateCandidateControls(candidate, { writeIntent }, { piModel });
      notifyUpdate(ctx, update);
      if (update.candidate) candidate = update.candidate;
      continue;
    }

    if (selected === fields[6]) {
      const values =
        candidate.host === "herdr" && candidate.writeIntent === "read-only"
          ? ([true, false] as const)
          : ([true] as const);
      const labels = values.map(
        (close) =>
          `${close ? "Close on report" : "Retain after report"}${close === candidate.closeOnReport ? " (current)" : ""}`,
      );
      const closeLabel = await ctx.ui.select(
        "After report · retention requires Herdr read-only · esc back",
        labels,
      );
      const index = closeLabel ? labels.indexOf(closeLabel) : -1;
      const closeOnReport = index >= 0 ? values[index] : undefined;
      if (closeOnReport !== undefined) candidate = { ...candidate, closeOnReport };
    }
  }
}
