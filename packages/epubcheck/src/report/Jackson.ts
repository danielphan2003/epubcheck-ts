// Serializes JSON the way upstream's Jackson `DefaultPrettyPrinter` does: `"key" : value`, objects
// indented two spaces per level, arrays inline (`[ 1, 2 ]`, `[ ]`, `[ {` ... `}, {` ... `} ]`).

export type Json = null | boolean | number | string | ReadonlyArray<Json> | JsonObject;
export interface JsonObject {
  readonly [key: string]: Json;
}

const escape = (value: string) =>
  `"${value.replace(/["\\\u0000-\u001f]/g, (char) => {
    switch (char) {
      case '"':
        return '\\"';
      case "\\":
        return "\\\\";
      case "\n":
        return "\\n";
      case "\r":
        return "\\r";
      case "\t":
        return "\\t";
      case "\b":
        return "\\b";
      case "\f":
        return "\\f";
      default:
        return `\\u${char.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}`;
    }
  })}"`;

const isArray = (value: Json): value is ReadonlyArray<Json> => Array.isArray(value);

const write = (value: Json, depth: number): string => {
  if (value === null) return "null";
  if (typeof value === "string") return escape(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (isArray(value)) {
    if (value.length === 0) return "[ ]";
    return `[ ${value.map((item) => write(item, depth)).join(", ")} ]`;
  }
  const entries = Object.entries(value);
  if (entries.length === 0) return "{ }";
  const indent = "  ".repeat(depth + 1);
  const body = entries
    .map(([key, item]) => `${indent}${escape(key)} : ${write(item, depth + 1)}`)
    .join(",\n");
  return `{\n${body}\n${"  ".repeat(depth)}}`;
};

export const stringify = (value: Json) => write(value, 0);
