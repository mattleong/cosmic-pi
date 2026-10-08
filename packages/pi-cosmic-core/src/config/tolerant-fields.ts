import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const JsonRecordSchema = Schema.Record(Schema.String, Schema.MutableJson);

export interface TolerantFieldDiagnostic {
  readonly path: string;
  readonly issue: "invalid";
}

interface TolerantFieldOptions {
  /** Prefix used for redacted, structural diagnostics. */
  readonly path?: string;
  /** Maximum diagnostics retained for one decode. Defaults to 32. */
  readonly maxDiagnostics?: number;
}

type TolerantFieldSchemas = Readonly<Record<string, Schema.Decoder<any>>>;

type TolerantFieldValues<Fields extends TolerantFieldSchemas> = {
  readonly [Key in keyof Fields]?: Schema.Schema.Type<Fields[Key]>;
};

interface TolerantFieldResult<Fields extends TolerantFieldSchemas> {
  readonly value: TolerantFieldValues<Fields>;
  readonly diagnostics: readonly TolerantFieldDiagnostic[];
}

/**
 * Decodes each owned field independently. A malformed field is omitted without discarding valid
 * siblings, and diagnostics contain paths only (never values or parse details).
 */
export const decodeTolerantFields = <Input, const Fields extends TolerantFieldSchemas>(
  input: Input,
  fields: Fields,
  options: TolerantFieldOptions = {},
): TolerantFieldResult<Fields> => {
  const root = Schema.decodeUnknownOption(JsonRecordSchema)(input);
  const raw = Option.isSome(root) ? root.value : {};
  const prefix = options.path ? `${options.path}.` : "";
  const value: TolerantFieldValues<Fields> = {};
  const diagnostics: TolerantFieldDiagnostic[] = Option.isNone(root)
    ? [{ path: options.path ?? "$", issue: "invalid" }]
    : [];

  for (const [key, schema] of Object.entries(fields)) {
    if (!Object.hasOwn(raw, key)) continue;
    const decoded = Schema.decodeUnknownOption(schema)(raw[key]);
    if (Option.isNone(decoded)) diagnostics.push({ path: `${prefix}${key}`, issue: "invalid" });
    else
      Object.defineProperty(value, key, {
        value: decoded.value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
  }

  const maxDiagnostics = Math.max(0, Math.floor(options.maxDiagnostics ?? 32));
  return { value, diagnostics: diagnostics.slice(0, maxDiagnostics) };
};
