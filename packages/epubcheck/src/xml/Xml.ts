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

export const decodeCharacterReferences = (text: string) =>
  text.replace(/&#(x[0-9a-fA-F]+|\d+);/g, (reference, code: string) => {
    const point = code.startsWith("x") ? Number.parseInt(code.slice(1), 16) : Number(code);
    return point <= 0x10ffff ? String.fromCodePoint(point) : reference;
  });

const PREDEFINED: Readonly<Record<string, string>> = {
  lt: "<",
  gt: ">",
  amp: "&",
  apos: "'",
  quot: '"',
};

const isXmlChar = (point: number) =>
  point === 0x9 ||
  point === 0xa ||
  point === 0xd ||
  (point >= 0x20 && point <= 0xd7ff) ||
  (point >= 0xe000 && point <= 0xfffd) ||
  (point >= 0x10000 && point <= 0x10ffff);

// The well-formedness error Xerces reports while reading an entity's literal value, with the
// offset in the value where it reports it.
const literalError = (value: string) => {
  for (let index = value.indexOf("&"); index >= 0; index = value.indexOf("&", index + 1)) {
    const rest = value.slice(index + 1);
    const character = /^#(x[0-9a-fA-F]+|\d+);/.exec(rest);
    if (character !== null) {
      const code = character[1] ?? "";
      const point = code.startsWith("x") ? Number.parseInt(code.slice(1), 16) : Number(code);
      if (isXmlChar(point)) continue;
      return {
        message: `Character reference "&#${code}" is an invalid XML character.`,
        offset: index + character[0].length + 1,
      };
    }
    const name = /^[A-Za-z_:\u00C0-\uFFFD][\w.:\u00B7-\uFFFD-]*/.exec(rest)?.[0];
    if (name === undefined) {
      return {
        message: "The entity name must immediately follow the '&' in the entity reference.",
        offset: index + 1,
      };
    }
    if (rest[name.length] !== ";") {
      return {
        message: `The reference to entity "${name}" must end with the ';' delimiter.`,
        offset: index + 1 + name.length,
      };
    }
  }
  return undefined;
};

type Expansion = { readonly text: string } | { readonly error: string };

// Upstream sets no expansion limit and crashes on an entity bomb; this bound keeps memory sane.
const EXPANSION_LIMIT = 2 ** 24;

// saxes inserts an entity's text verbatim, so the replacement text is expanded here as Xerces
// would: character references when declared, then references in the result when used. An
// entity whose expansion fails is left undeclared, with the error Xerces reports where it is used.
const internalEntities = (
  subset: string | undefined,
  known: Readonly<Record<string, string>>,
  subsetOffset: number,
) => {
  const declared: Record<string, string> = {};
  const broken = new Map<string, string>();
  let error: { readonly message: string; readonly offset: number } | undefined;
  if (subset === undefined) return { entities: declared, broken, error };
  for (const match of subset.matchAll(/<!ENTITY\s+([^\s%]+)\s+(["'])([\s\S]*?)\2\s*>/dg)) {
    const [, name, , value] = match;
    if (name === undefined || value === undefined || name in declared) continue;
    const invalid = literalError(value);
    if (invalid !== undefined && error === undefined) {
      error = {
        message: invalid.message,
        offset: subsetOffset + (match.indices?.[3]?.[0] ?? 0) + invalid.offset,
      };
    }
    declared[name] = decodeCharacterReferences(value);
  }
  // Successful expansions do not depend on the path, so each is computed once.
  const expansions = new Map<string, string>();
  const expand = (text: string, path: ReadonlyArray<string>): Expansion => {
    let expanded = "";
    let last = 0;
    for (const match of text.matchAll(/&(?:#(x[0-9a-fA-F]+|\d+)|([^\s&;#]+));/g)) {
      const [reference, code, name] = match;
      expanded += text.slice(last, match.index);
      last = match.index + reference.length;
      if (code !== undefined || name === undefined) {
        expanded += decodeCharacterReferences(reference);
        continue;
      }
      const predefined = PREDEFINED[name];
      const value = declared[name];
      if (predefined !== undefined) expanded += predefined;
      else if (path.includes(name)) {
        const cycle = [...path, name].join(" -> ");
        return { error: `Recursive entity reference "${name}". (Reference path: ${cycle}),` };
      } else if (value !== undefined) {
        const inner = expansionOf(name, value, path);
        if (typeof inner !== "string") return inner;
        if (expanded.length + inner.length > EXPANSION_LIMIT) {
          return {
            error: `The entity "${path[0] ?? name}" expands beyond ${EXPANSION_LIMIT} characters.`,
          };
        }
        expanded += inner;
      } else if (known[name] !== undefined) expanded += known[name];
      else return { error: `The entity "${name}" was referenced, but not declared.` };
    }
    return { text: expanded + text.slice(last) };
  };
  const expansionOf = (name: string, value: string, path: ReadonlyArray<string>) => {
    const cached = expansions.get(name);
    if (cached !== undefined) return cached;
    const expansion = expand(value, [...path, name]);
    if ("error" in expansion) return expansion;
    expansions.set(name, expansion.text);
    return expansion.text;
  };
  const entities: Record<string, string> = {};
  for (const [name, value] of Object.entries(declared)) {
    const expansion = expansionOf(name, value, []);
    if (typeof expansion === "string") entities[name] = expansion;
    else broken.set(name, expansion.error);
  }
  return { entities, broken, error };
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
  const fail = (failure: XmlError) => {
    error ??= failure;
  };
  const positionAt = (offset: number) => {
    const before = source.slice(0, offset).split("\n");
    return { line: before.length, column: (before.at(-1)?.length ?? 0) + 1 };
  };
  let broken = new Map<string, string>();
  parser.on("doctype", (raw) => {
    doctype = parseDoctype(raw);
    const rawOffset = source.indexOf("<!DOCTYPE") + "<!DOCTYPE".length;
    // An external ID needs a system literal after a public one; saxes does not check.
    const publicOnly = /^\s*[^\s[>]+\s+PUBLIC\s+(?:"[^"]*"|'[^']*')(?!\s*["'])/d.exec(raw);
    if (publicOnly !== null) {
      fail({
        message: "White spaces are required between publicId and systemId.",
        ...positionAt(rawOffset + (publicOnly.indices?.[0]?.[1] ?? 0)),
      });
    }
    const external = options.externalEntities?.(doctype) ?? {};
    const subsetOffset =
      doctype.internalSubset === undefined ? 0 : rawOffset + raw.indexOf(doctype.internalSubset);
    const internal = internalEntities(doctype.internalSubset, external, subsetOffset);
    if (internal.error !== undefined) {
      fail({ message: internal.error.message, ...positionAt(internal.error.offset) });
    }
    broken = internal.broken;
    Object.assign(parser.ENTITIES, external, internal.entities);
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
      if (name !== undefined) {
        message = broken.get(name) ?? `The entity "${name}" was referenced, but not declared.`;
      }
    }
    fail({ message, line, column });
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
