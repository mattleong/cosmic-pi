import * as Predicate from "effect/Predicate";
import { validationNoticeIdentity } from "../ui/validation-notices.ts";

export interface PresentationField {
  readonly value: unknown;
  readonly unreadable?: true;
}
export type PresentationReader = <Value>(value: Value, key: string) => PresentationField;
export const ownPresentationField: PresentationReader = (value, key) => {
  try {
    if (!Predicate.isObjectOrArray(value)) return { value: undefined };
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (field && !("value" in field)) return { value: undefined, unreadable: true };
    return { value: field?.value };
  } catch {
    return { value: undefined, unreadable: true };
  }
};
export const presentationArrayLength = <Value>(value: Value): number | undefined => {
  try {
    const length = ownPresentationField(value, "length").value;
    return Array.isArray(value) &&
      Predicate.isNumber(length) &&
      Number.isSafeInteger(length) &&
      length >= 0
      ? length
      : undefined;
  } catch {
    return undefined;
  }
};
const outcomes = ["completed", "not-sent", "unknown"] as const;
export const presentationOutcome = <Value>(value: Value) =>
  outcomes.find((outcome) => outcome === value);

/** Only raw envelope/origin descriptors establish validation-notice ownership. */
export const presentationValidationIdentity = <Reply, Origin>(
  reply: Reply,
  origin: Origin,
  field: PresentationReader = ownPresentationField,
) =>
  validationNoticeIdentity({
    action: field(reply, "action").value,
    outcome: field(reply, "outcome").value,
    isError: field(reply, "isError").value,
    originAction: field(origin, "action").value,
    originOutcome: field(origin, "outcome").value,
    originIsError: field(origin, "isError").value,
    outputValidation: field(origin, "outputValidation").value,
  });

/** Only gateway discovery actions own paging and undiscovered-server guidance.
 * Retained reads use the captured operation identity, never fields in remote output.
 */
export const presentationEvidence = <Reply>(
  reply: Reply,
  field: PresentationReader = ownPresentationField,
) => {
  const action = field(reply, "action").value;
  const data = field(reply, "data").value;
  const payload = field(data, "result").value ?? data;
  const origin = field(data, "origin").value;
  const sourceAction = action === "result.read" ? field(origin, "action").value : action;
  const discovery = sourceAction === "tools.list" || sourceAction === "tools.search";
  const paginated =
    discovery ||
    sourceAction === "resources.list" ||
    sourceAction === "resources.templates" ||
    sourceAction === "prompts.list";
  return {
    action,
    data,
    payload,
    origin,
    payloadTruncation: sourceAction === "server.instructions" || sourceAction === "events.read",
    counterKeys:
      sourceAction === "status" || sourceAction === "connect" || sourceAction === "disconnect"
        ? ["servers"]
        : sourceAction === "tools.call"
          ? ["content"]
          : sourceAction === "resources.read"
            ? ["contents"]
            : sourceAction === "prompts.get"
              ? ["messages"]
              : paginated
                ? ["servers", "tools", "resources", "templates", "prompts", "items"]
                : [],
    page: paginated ? field(payload, "page").value : undefined,
    undiscovered: paginated ? field(payload, "undiscovered").value : undefined,
  };
};
