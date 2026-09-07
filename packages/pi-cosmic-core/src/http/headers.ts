/** Merge headers case-insensitively; later values replace earlier ones and null deletes. */
export function mergeHeaders(
  ...sources: ReadonlyArray<Readonly<Record<string, string | null>> | undefined>
): Record<string, string> {
  const resolved = new Map<string, { readonly name: string; readonly value: string }>();
  for (const source of sources) {
    if (!source) continue;
    for (const [name, value] of Object.entries(source)) {
      const normalized = name.toLowerCase();
      if (value === null) resolved.delete(normalized);
      else resolved.set(normalized, { name, value });
    }
  }
  return Object.fromEntries(
    Array.from(resolved.values(), ({ name, value }) => [name, value] as const),
  );
}
