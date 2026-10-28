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
    };
    const parent = stack.at(-1);
    if (parent === undefined) root ??= element;
    else parent.children.push(element);
    stack.push(element);
  });
  parser.on("closetag", () => {
    stack.pop();
  });
  parser.on("text", appendText);
  parser.on("cdata", appendText);
  parser.on("error", (cause) => {
    error ??= {
      message: cause.message.replace(/^[^:]*:\d+:\d+: /, ""),
      line: parser.line,
      column: parser.column + 1,
    };
  });

  parser.write(source).close();
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

export const descendants = function* (element: XmlElement): Generator<XmlElement> {
  for (const child of childElements(element)) {
    yield child;
    yield* descendants(child);
  }
};

export const textContent = (element: XmlElement): string =>
  element.children
    .map((child) => (child.kind === "text" ? child.text : textContent(child)))
    .join("");
