import type { FormValue, OwnedFormRequest } from "./form-protocol.ts";

export function initialFormValues(request: OwnedFormRequest): ReadonlyMap<string, FormValue> {
  return new Map(
    request.kind === "form"
      ? request.fields.flatMap((field) =>
          field.default === undefined ? [] : [[field.key, field.default] as const],
        )
      : [],
  );
}
export function formContent(values: ReadonlyMap<string, FormValue>): Record<string, FormValue> {
  return Object.fromEntries(values);
}
