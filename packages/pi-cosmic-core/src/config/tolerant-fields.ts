import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { flow, identity } from "effect/Function";

const JsonRecordSchema = Schema.Record(Schema.String, Schema.MutableJson);

export interface TolerantFieldDiagnostic {
  readonly path: string;
  readonly issue: "invalid";
}

interface TolerantFieldOptions {
  readonly path?: string;
  readonly maxDiagnostics?: number;
}

type TolerantFieldSchemas = Readonly<Record<string, Schema.Decoder<unknown>>>;

type TolerantFieldValues<Fields extends TolerantFieldSchemas> = {
  readonly [Key in keyof Fields]?: Schema.Schema.Type<Fields[Key]>;
};

interface TolerantFieldResult<Fields extends TolerantFieldSchemas> {
  readonly value: TolerantFieldValues<Fields>;
  readonly diagnostics: readonly TolerantFieldDiagnostic[];
}

export const decodeTolerantFields = <const Fields extends TolerantFieldSchemas>(
  fields: Fields,
  options: TolerantFieldOptions = {},
) =>
  flow(
    identity<unknown>,
    Schema.decodeUnknownOption(JsonRecordSchema),
    (root): TolerantFieldResult<Fields> => collectTolerantFields(root, fields, options),
  );

const collectTolerantFields = <Fields extends TolerantFieldSchemas>(
  root: Option.Option<Schema.MutableJsonObject>,
  fields: Fields,
  options: TolerantFieldOptions,
): TolerantFieldResult<Fields> => {
  const raw = Option.isSome(root) ? root.value : {};
  const prefix = options.path ? `${options.path}.` : "";
  const value: TolerantFieldValues<Fields> = {};
  const diagnostics: TolerantFieldDiagnostic[] = Option.isNone(root)
    ? [{ path: options.path ?? "$", issue: "invalid" }]
    : [];

  for (const [key, schema] of Object.entries(fields)) {
    if (!Object.hasOwn(raw, key)) continue;
    const decoded = Schema.decodeOption(schema)(raw[key]);
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
