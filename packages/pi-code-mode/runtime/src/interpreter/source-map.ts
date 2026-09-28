import * as Schema from "effect/Schema";
import { hasObjectRuntimeType } from "../runtime-values.js";
import type { AstNode, AstPropertyValue, SourceLocation, SourcePosition } from "./model.js";

const decodeSourceMap = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ mappings: Schema.String })),
);

/** One decoded source-map segment: generated column, then original line and column (0-based). */
type Segment = readonly [generatedColumn: number, sourceLine: number, sourceColumn: number];

const base64Digits = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

const decodeVlq = (text: string): Array<number> => {
  const values: Array<number> = [];
  let value = 0;
  let shift = 0;
  for (const character of text) {
    const digit = base64Digits.indexOf(character);
    if (digit < 0) return values;
    value += (digit & 31) << shift;
    if ((digit & 32) !== 0) {
      shift += 5;
      continue;
    }
    values.push((value & 1) === 1 ? -(value >>> 1) : value >>> 1);
    value = 0;
    shift = 0;
  }
  return values;
};

/** Decodes source-map `mappings` into segments per generated line, sorted by column. */
const decodeMappings = (mappings: string): Array<Array<Segment>> => {
  let sourceLine = 0;
  let sourceColumn = 0;
  return mappings.split(";").map((lineText) => {
    let generatedColumn = 0;
    const segments: Array<Segment> = [];
    for (const segmentText of lineText.split(",")) {
      if (segmentText === "") continue;
      const fields = decodeVlq(segmentText);
      generatedColumn += fields[0] ?? 0;
      if (fields.length < 4) continue;
      sourceLine += fields[2] ?? 0;
      sourceColumn += fields[3] ?? 0;
      segments.push([generatedColumn, sourceLine, sourceColumn]);
    }
    return segments.sort((left, right) => left[0] - right[0]);
  });
};

/**
 * Maps positions in a parsed slice of generated code back to the original program.
 *
 * The slice starts at `sliceLine`/`sliceColumn` (0-based) of the generated file. The original
 * was wrapped in one header line, so an original line index is already the program's 1-based
 * line number. Positions that land in the wrapper clamp to the program's first or last line.
 */
export const makePositionMapper = (
  sourceMapText: string,
  sliceLine: number,
  sliceColumn: number,
  programLines: ReadonlyArray<string>,
): ((position: SourcePosition) => SourcePosition) => {
  const lines = decodeMappings(decodeSourceMap(sourceMapText).mappings);
  const lastLine = Math.max(1, programLines.length);
  const clamp = (line: number, column: number): SourcePosition => {
    if (line < 1) return { line: 1, column: 0 };
    if (line > lastLine) return { line: lastLine, column: 0 };
    return { line, column: Math.max(0, Math.min(column, programLines[line - 1]?.length ?? 0)) };
  };
  return ({ line, column }) => {
    const generatedLine = sliceLine + line - 1;
    const generatedColumn = line === 1 ? sliceColumn + column : column;
    const segments = lines[generatedLine] ?? [];
    let match: Segment | undefined;
    for (const segment of segments) {
      if (segment[0] > generatedColumn) break;
      match = segment;
    }
    if (match !== undefined) return clamp(match[1], match[2] + (generatedColumn - match[0]));
    // No mapping at or before this column: use the line's first mapping, then earlier lines.
    const first = segments[0];
    if (first !== undefined) return clamp(first[1], first[2]);
    for (let previous = generatedLine - 1; previous >= 0; previous--) {
      const last = lines[previous]?.at(-1);
      if (last !== undefined) return clamp(last[1], last[2]);
    }
    return { line: 1, column: 0 };
  };
};

const isNode = (value: AstPropertyValue): value is AstNode =>
  value !== null && hasObjectRuntimeType(value) && !Array.isArray(value) && "type" in value;

/** Rewrites every node location in a parsed tree through `map`. */
export const remapLocations = (
  root: AstNode,
  map: (position: SourcePosition) => SourcePosition,
): void => {
  const pending: Array<AstNode> = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    const location: SourceLocation | undefined = node.loc;
    if (location !== undefined) node.loc = { start: map(location.start), end: map(location.end) };
    for (const [key, child] of Object.entries(node)) {
      if (key === "loc") continue;
      if (Array.isArray(child)) {
        for (const item of child) if (isNode(item)) pending.push(item);
      } else if (isNode(child)) pending.push(child);
    }
  }
};
