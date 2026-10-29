import * as Result from "effect/Result";
import { SaxesParser } from "saxes";

// A small namespace-aware DOM. Positions follow SAX: the line and 1-based column just past the
// start tag, which is where upstream's Xerces-based parser locates element events.
export interface XmlAttribute {
  readonly name: string;
  readonly prefix: string;
  readonly local: string;
  readonly ns: string;
  readonly value: string;
}

export interface XmlElement {
  readonly kind: "element";
  readonly name: string;
  readonly prefix: string;
  readonly local: string;
  readonly ns: string;
  readonly attributes: ReadonlyArray<XmlAttribute>;
  readonly children: Array<XmlNode>;
  readonly line: number;
  readonly column: number;
  // Just past the end tag (or the start tag, for empty elements); set when the element closes.
  endLine: number;
  endColumn: number;
}

export interface XmlText {
  readonly kind: "text";
  readonly text: string;
}

export type XmlNode = XmlElement | XmlText;

export interface XmlDoctype {
  readonly name: string;
  readonly publicId: string | undefined;
  readonly systemId: string | undefined;
  readonly internalSubset: string | undefined;
}

export interface XmlDocument {
  readonly root: XmlElement;
  readonly doctype: XmlDoctype | undefined;
  readonly encoding: string | undefined;
  readonly version: string | undefined;
}

export interface XmlError {
  readonly message: string;
  readonly line: number;
  readonly column: number;
}

const parseDoctype = (raw: string): XmlDoctype => {
  const match =
    /^\s*([^\s[>]+)(?:\s+(?:PUBLIC\s+(["'])(.*?)\2(?:\s+(["'])(.*?)\4)?|SYSTEM\s+(["'])(.*?)\6))?\s*(?:\[([\s\S]*)\])?\s*$/.exec(
      raw,
    );
  return {
    name: match?.[1] ?? "",
    publicId: match?.[3],
    systemId: match?.[5] ?? match?.[7],
    internalSubset: match?.[8],
  };
};

const internalEntities = (subset: string | undefined) => {
  const entities: Record<string, string> = {};
  if (subset === undefined) return entities;
  for (const match of subset.matchAll(/<!ENTITY\s+([^\s%]+)\s+(["'])([\s\S]*?)\2\s*>/g)) {
    const [, name, , value] = match;
    if (name !== undefined && value !== undefined && !(name in entities)) entities[name] = value;
  }
  return entities;
};

export interface ParseOptions {
  // Entities declared by a known external DTD (for example XHTML 1.1), keyed by name.
  readonly externalEntities?: (doctype: XmlDoctype) => Readonly<Record<string, string>>;
}

export const decode = (bytes: Uint8Array) => {
  if (bytes[0] === 0xfe && bytes[1] === 0xff)
    return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  if (bytes[0] === 0xff && bytes[1] === 0xfe)
    return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  return new TextDecoder("utf-8").decode(bytes);
};

// Xerces rejects an entity reference without its `;`, which saxes reports later and less
// precisely; this finds the first one outside markup that is not parsed as text.
const unterminatedReference = (source: string): XmlError | undefined => {
  const skipped =
    /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE(?:[^[>]|\[[\s\S]*?\])*>/gy;
  let index = 0;
  while (index < source.length) {
    skipped.lastIndex = index;
    const skip = skipped.exec(source);
    if (skip !== null) {
      index += skip[0].length;
      continue;
    }
    if (source[index] === "&") {
      const reference = /^&(#x[0-9a-fA-F]+|#\d+|[A-Za-z_:][\w.:-]*)(;?)/.exec(
        source.slice(index, index + 80),
      );
      if (reference !== null && reference[2] === "") {
        const before = source.slice(0, index + reference[0].length).split("\n");
        return {
          message: `The reference to entity "${reference[1]}" must end with the ';' delimiter.`,
          line: before.length,
          column: (before.at(-1)?.length ?? 0) + 1,
        };
      }
    }
    index++;
  }
  return undefined;
};

// The name of the entity reference ending just before `offset`.
const referenceBefore = (source: string, offset: number) =>
  /&([^&;\s]+);$/.exec(source.slice(Math.max(0, offset - 80), offset))?.[1];

const offsetOf = (source: string, line: number, column: number) => {
  let offset = 0;
  for (let current = 1; current < line; current++) {
    const next = source.indexOf("\n", offset);
    if (next < 0) return source.length;
    offset = next + 1;
  }
  return offset + column - 1;
};

export const parse = (source: string, options: ParseOptions = {}) => {
  const parser = new SaxesParser({ xmlns: true, position: true });
  const stack: Array<XmlElement> = [];
  let root: XmlElement | undefined;
  let doctype: XmlDoctype | undefined;
  let declaration: {
    readonly encoding?: string | undefined;
    readonly version?: string | undefined;
  } = {};
  let error: XmlError | undefined;

  const appendText = (text: string) => {
    const parent = stack.at(-1);
    if (parent === undefined) return;
    const last = parent.children.at(-1);
    if (last?.kind === "text")
      parent.children[parent.children.length - 1] = { kind: "text", text: last.text + text };
    else parent.children.push({ kind: "text", text });
  };

  parser.on("xmldecl", (decl) => {
    declaration = { encoding: decl.encoding, version: decl.version };
  });
  parser.on("doctype", (raw) => {
    doctype = parseDoctype(raw);
    Object.assign(
      parser.ENTITIES,
      options.externalEntities?.(doctype) ?? {},
      internalEntities(doctype.internalSubset),
    );
  });
  parser.on("opentag", (tag) => {
    const element: XmlElement = {
      kind: "element",
      name: tag.name,
      prefix: tag.prefix,
      local: tag.local,
      ns: tag.uri,
      attributes: Object.values(tag.attributes).map((attribute) => ({
        name: attribute.name,
        prefix: attribute.prefix,
        local: attribute.local,
        ns: attribute.uri,
        value: attribute.value,
      })),
      children: [],
      line: parser.line,
      column: parser.column + 1,
      endLine: parser.line,
      endColumn: parser.column + 1,
    };
    const parent = stack.at(-1);
    if (parent === undefined) root ??= element;
    else parent.children.push(element);
    stack.push(element);
  });
  parser.on("closetag", () => {
    const element = stack.pop();
    if (element !== undefined) {
      element.endLine = parser.line;
      element.endColumn = parser.column + 1;
    }
  });
  parser.on("text", appendText);
  parser.on("cdata", appendText);
  parser.on("error", (cause) => {
    if (error !== undefined) return;
    const line = parser.line;
    const column = parser.column + 1;
    let message = cause.message.replace(/^(?:[^:\n]*:)?\d+:\d+: /, "");
    if (message === "undefined entity.") {
      const name = referenceBefore(source, offsetOf(source, line, column));
      if (name !== undefined) message = `The entity "${name}" was referenced, but not declared.`;
    }
    error = { message, line, column };
  });

  parser.write(source).close();
  const unterminated = unterminatedReference(source);
  if (
    unterminated !== undefined &&
    (error === undefined ||
      unterminated.line < error.line ||
      (unterminated.line === error.line && unterminated.column <= error.column))
  ) {
    return Result.fail(unterminated);
  }
  if (error !== undefined) return Result.fail(error);
  if (root === undefined)
    return Result.fail({ message: "document has no root element", line: 1, column: 1 });
  return Result.succeed({
    root,
    doctype,
    encoding: declaration.encoding,
    version: declaration.version,
  } satisfies XmlDocument);
};

export const attribute = (element: XmlElement, local: string, ns = "") =>
  element.attributes.find((candidate) => candidate.local === local && candidate.ns === ns)?.value;

export const childElements = (element: XmlElement) =>
  element.children.filter((child): child is XmlElement => child.kind === "element");

// Iterative walks: documents can nest deeper than the call stack allows.
export const descendants = (element: XmlElement) => {
  const found: Array<XmlElement> = [];
  const stack = [...childElements(element)].reverse();
  while (stack.length > 0) {
    const next = stack.pop();
    if (next === undefined) break;
    found.push(next);
    for (const child of [...childElements(next)].reverse()) stack.push(child);
  }
  return found;
};

export const textContent = (element: XmlElement) => {
  let text = "";
  const stack: Array<XmlNode> = [...element.children].reverse();
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) break;
    if (node.kind === "text") text += node.text;
    else for (const child of [...node.children].reverse()) stack.push(child);
  }
  return text;
};

export interface PackagePeek {
  readonly root: string | undefined;
  readonly version: string | undefined;
  readonly error: XmlError | undefined;
}

// Streams a package document only up to the end of `metadata`, like upstream's version peek:
// errors after that point are left to the full check.
export const peekPackage = (source: string): PackagePeek => {
  const parser = new SaxesParser({ xmlns: true, position: true });
  let root: string | undefined;
  let version: string | undefined;
  let error: XmlError | undefined;
  let done = false;
  parser.on("opentag", (tag) => {
    if (done || root !== undefined) return;
    root = tag.local;
    version = tag.local === "package" ? tag.attributes.version?.value : undefined;
  });
  parser.on("closetag", (tag) => {
    if (tag.local === "metadata" || tag.local === "package") done = true;
  });
  parser.on("error", (cause) => {
    if (done || error !== undefined) return;
    error = {
      message: cause.message.replace(/^[^:]*:\d+:\d+: /, ""),
      line: parser.line,
      column: parser.column + 1,
    };
  });
  parser.write(source).close();
  return { root, version, error };
};
