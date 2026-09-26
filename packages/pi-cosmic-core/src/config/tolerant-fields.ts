import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const JsonRecordSchema = Schema.Record(Schema.String, Schema.MutableJson);

export interface TolerantFieldDiagnostic {
  readonly path: string;
  readonly issue: "invalid";
}

export interface TolerantFieldOptions {
  /** Prefix used for redacted, structural diagnostics. */
  readonly path?: string;
  /** Maximum diagnostics retained for one decode. Defaults to 32. */
  readonly maxDiagnostics?: number;
}

export type TolerantFieldSchemas = Readonly<Record<string, Schema.Decoder<any>>>;

export type TolerantFieldValues<Fields extends TolerantFieldSchemas> = {
  readonly [Key in keyof Fields]?: Schema.Schema.Type<Fields[Key]>;
};

export interface TolerantFieldResult<Fields extends TolerantFieldSchemas> {
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
  const diagnostics: TolerantFieldDiagnostic[] = [];
  const maxDiagnostics = Math.max(0, Math.floor(options.maxDiagnostics ?? 32));
  const prefix = options.path ? `${options.path}.` : "";
  const value: TolerantFieldValues<Fields> = {};

  if (Option.isNone(root) && diagnostics.length < maxDiagnostics) {
    diagnostics.push({ path: options.path ?? "$", issue: "invalid" });
  }

  for (const [key, schema] of Object.entries(fields)) {
    if (!Object.hasOwn(raw, key)) continue;
    const decoded = Schema.decodeUnknownOption(schema)(raw[key]);
    if (Option.isSome(decoded)) {
      Object.defineProperty(value, key, {
        value: decoded.value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    } else if (diagnostics.length < maxDiagnostics) {
      diagnostics.push({ path: `${prefix}${key}`, issue: "invalid" });
    }
  }

  return { value, diagnostics };
};
