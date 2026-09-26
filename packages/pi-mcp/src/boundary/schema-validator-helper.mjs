import { AjvJsonSchemaValidator } from "@modelcontextprotocol/client/validators/ajv";
import {
  assertDataDocument,
  assertSchemaDocument,
  isBoolean,
  isPlainObject,
} from "../validation/schema-rules.mjs";

// This file is a fixed one-shot boundary. It accepts exactly { schema, data },
// never reads an executable/path/module field, and emits only { valid }.
const maximumInputBytes = 9 * 1024 * 1024;

const readInput = async () => {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.byteLength;
    if (size > maximumInputBytes) throw new Error();
    chunks.push(chunk);
  }
  if (size === 0) throw new Error();
  return JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
};

try {
  const input = await readInput();
  if (!isPlainObject(input)) throw new Error();
  const keys = Object.keys(input);
  if (keys.length !== 2 || !keys.includes("schema") || !keys.includes("data")) throw new Error();
  assertDataDocument(input.data);
  assertSchemaDocument(input.schema);

  // $id establishes an identifier, not a fetch target. Synchronous compile
  // resolves $ref only against this document and bundled schemas; unresolved
  // references throw. Never use compileAsync or install loadSchema. The SDK
  // defaults to 2020-12, leaves content annotations undecoded, and does not
  // enable coercion, defaults, removeAdditional, or custom implementations.
  // Ajv logs unknown annotation formats through console.warn. Suppress those
  // diagnostics in this one-shot process: they contain untrusted schema text.
  // Known format validators stay enabled; unknown formats remain annotations.
  console.warn = () => {};
  const valid = isBoolean(input.schema)
    ? input.schema
    : new AjvJsonSchemaValidator().getValidator(input.schema)(input.data).valid === true;
  process.stdout.write(JSON.stringify({ valid }));
} catch {
  // Never print parser, compiler, regex, or native diagnostics to stderr.
  process.exitCode = 1;
}
