import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import type * as SchemaIssue from "effect/SchemaIssue";
import { JsonDocumentStore, type JsonObject } from "./json-document.ts";

export class SchemaDocumentError extends Schema.TaggedError<SchemaDocumentError>()(
  "SchemaDocumentError",
  {
    operation: Schema.String,
    path: Schema.String,
    message: Schema.String,
  },
) {}

export interface DecodedDocument<A> {
  readonly value: A;
  readonly raw: JsonObject;
}

const mapError = (operation: string, path: string, message: string) => () =>
  new SchemaDocumentError({ operation, path, message });

const MAX_ISSUE_PATHS = 3;
const MAX_ISSUE_NODES = 64;
const MAX_PATH_SEGMENTS = 8;
const MAX_PATH_SEGMENT_CHARS = 48;
const MAX_ISSUE_DIAGNOSTIC_CHARS = 384;
const SAFE_PATH_SEGMENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

interface DiagnosticPathSegment {
  readonly value: PropertyKey;
  readonly reveal: boolean;
}

interface DiagnosticPath {
  readonly segments: ReadonlyArray<DiagnosticPathSegment>;
  readonly truncated: boolean;
}

interface PendingIssue {
  readonly issue: SchemaIssue.Issue;
  readonly path: DiagnosticPath;
  readonly staticKeys: ReadonlySet<PropertyKey> | undefined;
  readonly revealNumericKeys: boolean;
}

const formatPathSegment = (segment: DiagnosticPathSegment): string => {
  if (!segment.reveal) return "[<redacted>]";
  if (Predicate.isNumber(segment.value))
    return `[${Number.isSafeInteger(segment.value) ? segment.value : "?"}]`;
  if (Predicate.isSymbol(segment.value)) return "[<symbol>]";
  if (segment.value.length > MAX_PATH_SEGMENT_CHARS) return "[<redacted>]";
  for (let index = 0; index < segment.value.length; index += 1) {
    const codeUnit = segment.value.charCodeAt(index);
    if (codeUnit <= 31 || codeUnit === 127) return "[<redacted>]";
  }
  return SAFE_PATH_SEGMENT.test(segment.value)
    ? `.${segment.value}`
    : `[${JSON.stringify(segment.value)}]`;
};

const formatIssuePath = (path: DiagnosticPath): string => {
  const visible = path.segments.map(formatPathSegment).join("");
  return `$${visible}${path.truncated ? "[…]" : ""}`;
};

const appendPointerPath = (current: PendingIssue, pointer: SchemaIssue.Pointer): DiagnosticPath => {
  const remaining = Math.max(0, MAX_PATH_SEGMENTS - current.path.segments.length);
  const segmentCount = Math.min(pointer.path.length, remaining);
  const segments = [...current.path.segments];
  for (let index = 0; index < segmentCount; index += 1) {
    const value = pointer.path[index];
    if (value === undefined) continue;
    segments.push({
      value,
      reveal:
        current.staticKeys?.has(value) === true ||
        (current.revealNumericKeys && Predicate.isNumber(value)),
    });
  }
  return {
    segments,
    truncated: current.path.truncated || pointer.path.length > remaining,
  };
};

const issuePathDiagnostic = (root: SchemaIssue.Issue): string => {
  const pending: PendingIssue[] = [
    {
      issue: root,
      path: { segments: [], truncated: false },
      staticKeys: undefined,
      revealNumericKeys: false,
    },
  ];
  const paths: string[] = [];
  const seen = new Set<string>();
  let visited = 0;
  let truncated = false;
  while (pending.length > 0 && paths.length < MAX_ISSUE_PATHS && visited < MAX_ISSUE_NODES) {
    const current = pending.pop();
    if (!current) break;
    visited += 1;
    switch (current.issue._tag) {
      case "Pointer":
        pending.push({
          issue: current.issue.issue,
          path: appendPointerPath(current, current.issue),
          staticKeys: undefined,
          revealNumericKeys: false,
        });
        break;
      case "Filter":
      case "Encoding":
        pending.push({ ...current, issue: current.issue.issue });
        break;
      case "Composite":
      case "AnyOf": {
        const remaining = Math.max(0, MAX_ISSUE_NODES - visited - pending.length);
        const childCount = Math.min(current.issue.issues.length, remaining);
        if (childCount < current.issue.issues.length) truncated = true;
        const staticKeys =
          current.issue.ast._tag === "Objects"
            ? new Set(current.issue.ast.propertySignatures.map((property) => property.name))
            : undefined;
        const revealNumericKeys = current.issue.ast._tag === "Arrays";
        for (let index = childCount - 1; index >= 0; index -= 1) {
          const issue = current.issue.issues[index];
          if (issue) pending.push({ issue, path: current.path, staticKeys, revealNumericKeys });
        }
        break;
      }
      default: {
        const path = formatIssuePath(current.path);
        if (!seen.has(path)) {
          seen.add(path);
          paths.push(path);
        }
      }
    }
  }
  if (paths.length === 0) return "";
  const suffix = truncated || pending.length > 0 || visited >= MAX_ISSUE_NODES ? ", …" : "";
  const diagnostic = `${paths.join(", ")}${suffix}`;
  return diagnostic.length <= MAX_ISSUE_DIAGNOSTIC_CHARS
    ? diagnostic
    : `${diagnostic.slice(0, MAX_ISSUE_DIAGNOSTIC_CHARS - 1)}…`;
};

const decodeSchemaObject = <A>(path: string, schema: Schema.Decoder<A>, raw: JsonObject) =>
  Schema.decodeUnknownEffect(schema)(raw).pipe(
    Effect.map((value): DecodedDocument<A> => ({ value, raw })),
    Effect.mapError((error) => {
      const paths = issuePathDiagnostic(error.issue);
      return new SchemaDocumentError({
        operation: "decode",
        path,
        message: paths
          ? `Unable to decode schema document. Invalid field path: ${paths}.`
          : "Unable to decode schema document.",
      });
    }),
  );

export const readSchemaDocument = Effect.fn("SchemaDocument.read")(function* <A>(
  path: string,
  schema: Schema.Decoder<A>,
) {
  const documents = yield* JsonDocumentStore;
  const raw = yield* documents
    .readObject(path)
    .pipe(Effect.mapError(mapError("read", path, "Unable to read schema document.")));
  if (raw === undefined) return undefined;
  return yield* decodeSchemaObject(path, schema, raw);
});
