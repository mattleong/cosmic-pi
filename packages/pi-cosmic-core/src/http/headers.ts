import * as Rec from "effect/Record";
import * as Str from "effect/String";

export function mergeHeaders(
  ...sources: ReadonlyArray<Readonly<Record<string, string | null>> | undefined>
): Record<string, string> {
  const resolved = new Map<string, { readonly name: string; readonly value: string }>();
  for (const source of sources) {
    if (!source) continue;
    for (const [name, value] of Rec.toEntries(source)) {
      const normalized = Str.toLowerCase(name);
      if (value === null) resolved.delete(normalized);
      else resolved.set(normalized, { name, value });
    }
  }
  return Rec.fromEntries(
    Array.from(resolved.values(), ({ name, value }) => [name, value] as const),
  );
}
